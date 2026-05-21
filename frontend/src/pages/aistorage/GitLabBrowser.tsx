import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  App,
  Breadcrumb,
  Button,
  Checkbox,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  theme,
  Upload,
} from 'antd';
import {
  ArrowLeftOutlined,
  BranchesOutlined,
  DownloadOutlined,
  ExportOutlined,
  FileOutlined,
  FolderOutlined,
  ReloadOutlined,
  TagOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import {
  downloadGitLabFile,
  fetchGitLabFileText,
  FileTooLargeError,
  getGitLabProject,
  listGitLabRefs,
  listGitLabTreeViaGraphQL,
  uploadGitLabFile,
  type GitLabProjectDTO,
  type GitLabTreeEntryDTO,
} from '@/api/aiStorage';
import {
  ensureGitLabConfigsLoaded,
  useAIStorageGitLabConfigs,
} from '@/data/aiStorage';

// File extensions we never auto-load into the text viewer. Either they're
// binary, or they're so large/structured that displaying them as UTF-8
// text would be useless or actively dangerous (model weights are the
// usual offender — multi-GB tensors slow the page to a crawl).
//
// LFS-backed files of these types are also covered: the typed /file/raw
// endpoint resolves the LFS pointer, so by the time we decide whether to
// preview we'd be fetching the *real* gigabyte payload, not the 130-byte
// pointer. Block at the extension layer instead.
const BINARY_EXTENSIONS = new Set([
  // ML model artefacts
  '.bin', '.safetensors', '.pt', '.pth', '.ckpt', '.pkl', '.pickle',
  '.onnx', '.pb', '.h5', '.hdf5', '.tflite', '.gguf', '.ggml', '.msgpack',
  // Tensor / dataset formats
  '.npy', '.npz', '.parquet', '.arrow', '.feather', '.tfrecord',
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.tif',
  '.psd', '.heic', '.heif',
  // Audio / video
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.webm', '.ogg', '.wav', '.flac',
  '.aac', '.m4a', '.opus',
  // Archives + disk images
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.bzip2', '.7z', '.rar', '.xz', '.zst',
  '.iso', '.img', '.dmg',
  // Office docs (binary even when "text-like")
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Executables / native code
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib', '.obj',
  '.jar', '.class', '.war', '.ear', '.deb', '.rpm', '.apk',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
]);

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function isLikelyBinary(name: string): boolean {
  return BINARY_EXTENSIONS.has(fileExtension(name));
}

// AI Storage · GitLab project browser — the detail page for one specific
// project. Identity is carried entirely on the URL (`config` + `projectID`
// in the path, `path` + `ref` as query strings) so refreshing or sharing
// the URL re-enters the same folder on the same branch/tag.
//
// Layout: the file list lives on the left, a text viewer on the right.
// Clicking a folder navigates the tree (left pane only); clicking a file
// loads its content into the right pane. Known-binary extensions are
// short-circuited with a "binary file" message instead of being fetched.
export function GitLabBrowserPage() {
  const { namespace } = useApp();
  const navigate = useNavigate();
  const params = useParams<{ config: string; projectID: string }>();
  const [search, setSearch] = useSearchParams();
  const configs = useAIStorageGitLabConfigs(namespace);
  const { message } = App.useApp();
  // Pull theme tokens once so the split-view chrome (panel surface, row
  // highlight, borders) follows the active light/dark algorithm instead
  // of being hardcoded white.
  const { token } = theme.useToken();

  const configName = params.config;
  const projectIDNum = Number(params.projectID);
  const path = search.get('path') ?? '';
  const refOverride = search.get('ref') ?? '';

  const [project, setProject] = useState<GitLabProjectDTO | undefined>();
  const [projectLoading, setProjectLoading] = useState(true);
  const [tree, setTree] = useState<GitLabTreeEntryDTO[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [refs, setRefs] = useState<{ branches: string[]; tags: string[] }>({ branches: [], tags: [] });
  const [refsLoading, setRefsLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [form] = Form.useForm();
  // Right-pane viewer state. `kind` distinguishes plaintext loads from
  // short-circuited binary placeholders so the renderer can branch
  // cleanly. `loading` and `error` are mutually exclusive with `text`.
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  useEffect(() => {
    ensureGitLabConfigsLoaded(namespace);
  }, [namespace]);

  useEffect(() => {
    if (!configName || !Number.isFinite(projectIDNum)) {
      setProjectLoading(false);
      return;
    }
    let cancelled = false;
    setProjectLoading(true);
    getGitLabProject(namespace, configName, projectIDNum)
      .then(p => { if (!cancelled) setProject(p); })
      .catch(e => { if (!cancelled) message.error((e as Error).message); })
      .finally(() => { if (!cancelled) setProjectLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, configName, projectIDNum]);

  useEffect(() => {
    if (!configName || !project) return;
    let cancelled = false;
    setRefsLoading(true);
    listGitLabRefs(namespace, configName, project.id)
      .then(r => { if (!cancelled) setRefs(r); })
      .catch(() => { /* non-fatal — the default branch still works */ })
      .finally(() => { if (!cancelled) setRefsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, configName, project?.id]);

  const ref = refOverride || project?.defaultBranch || 'main';

  const reload = async () => {
    if (!configName || !project) return;
    setTreeLoading(true);
    try {
      const t = await listGitLabTreeViaGraphQL(namespace, configName, project.pathWithNamespace, path, ref);
      setTree(t);
    } catch (e) {
      message.error((e as Error).message);
      setTree([]);
    } finally {
      setTreeLoading(false);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [project, path, ref, configName]);

  // Switching ref usually invalidates any open viewer (the file may not
  // exist on the new ref). Path changes don't — the file's still there.
  useEffect(() => { setViewer(null); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [ref, project?.id]);

  const setPath = (next: string) => {
    const sp = new URLSearchParams(search);
    if (next) sp.set('path', next);
    else sp.delete('path');
    setSearch(sp, { replace: false });
  };

  const setRef = (nextRef: string) => {
    const sp = new URLSearchParams(search);
    if (nextRef && nextRef !== project?.defaultBranch) sp.set('ref', nextRef);
    else sp.delete('ref');
    sp.delete('path');
    setSearch(sp, { replace: false });
  };

  const crumbs = useMemo(() => {
    const segs = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    return [
      { key: '', label: '/', goto: '' },
      ...segs.map((s, i) => ({
        key: segs.slice(0, i + 1).join('/'),
        label: s,
        goto: segs.slice(0, i + 1).join('/'),
      })),
    ];
  }, [path]);

  const refOptions = useMemo(() => {
    const branches = [...refs.branches];
    if (project?.defaultBranch) {
      const idx = branches.indexOf(project.defaultBranch);
      if (idx > 0) {
        branches.splice(idx, 1);
        branches.unshift(project.defaultBranch);
      } else if (idx < 0) {
        branches.unshift(project.defaultBranch);
      }
    }
    return [
      {
        label: <span><BranchesOutlined /> Branches</span>,
        options: branches.map(b => ({ value: b, label: b })),
      },
      ...(refs.tags.length > 0 ? [{
        label: <span><TagOutlined /> Tags</span>,
        options: refs.tags.map(t => ({ value: t, label: t })),
      }] : []),
    ];
  }, [refs, project?.defaultBranch]);

  // openViewer is the click handler for blob rows. It decides upfront
  // whether to attempt a preview at all — known-binary extensions get a
  // placeholder instead of a fetch.
  const openViewer = async (entry: GitLabTreeEntryDTO) => {
    if (!configName || !project || entry.type !== 'blob') return;
    if (isLikelyBinary(entry.name)) {
      setViewer({
        path: entry.path,
        name: entry.name,
        sizeBytes: entry.size,
        kind: 'binary',
        loading: false,
        reason: `${fileExtension(entry.name) || 'this'} files are not previewable`,
      });
      return;
    }
    setViewer({ path: entry.path, name: entry.name, sizeBytes: entry.size, kind: 'text', loading: true });
    try {
      const result = await fetchGitLabFileText(
        namespace,
        configName,
        project.id,
        entry.path,
        ref,
        1024 * 1024,
      );
      setViewer({
        path: entry.path,
        name: entry.name,
        kind: 'text',
        text: result.text,
        sizeBytes: result.sizeBytes,
        truncated: result.truncated,
        loading: false,
      });
    } catch (e) {
      if (e instanceof FileTooLargeError) {
        setViewer({
          path: entry.path,
          name: entry.name,
          sizeBytes: e.sizeBytes,
          kind: 'binary',
          loading: false,
          reason: 'file too large to preview',
        });
        return;
      }
      setViewer({
        path: entry.path,
        name: entry.name,
        sizeBytes: entry.size,
        kind: 'text',
        loading: false,
        error: (e as Error).message,
      });
    }
  };

  if (configs.length === 0) {
    return (
      <div className="knaic-page">
        <PageHeader
          title="AI Storage · GitLab"
          description={`Browse, upload and download files in GitLab projects for namespace "${namespace}".`}
        />
        <Result
          status="info"
          title="No GitLab configs in this namespace"
          subTitle="Ask a platform admin to add one under Admin Area → GitLab Configs."
        />
      </div>
    );
  }

  if (projectLoading) {
    return (
      <div className="knaic-page">
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <Spin tip="Loading project…" />
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="knaic-page">
        <PageHeader
          title="AI Storage · GitLab"
          extra={<Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/aistorage/gitlab')}>Back to projects</Button>}
        />
        <Result
          status="404"
          title="Project not found"
          subTitle="The project could not be loaded. It may have been deleted, or the token may have lost access."
        />
      </div>
    );
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title={<>AI Storage · GitLab · <span className="mono">{project.pathWithNamespace}</span></>}
        description={`Files in ref "${ref}".`}
        extra={
          <Space>
            <Link to="/aistorage/gitlab">
              <Button icon={<ArrowLeftOutlined />}>Back to projects</Button>
            </Link>
            {project.webUrl && (
              <Button
                icon={<ExportOutlined />}
                onClick={() => window.open(project.webUrl, '_blank', 'noopener,noreferrer')}
                title="Open in GitLab"
              >
                Open in GitLab
              </Button>
            )}
            <Select
              size="middle"
              value={ref}
              onChange={setRef}
              options={refOptions}
              loading={refsLoading}
              showSearch
              placeholder="Branch or tag"
              style={{ width: 240 }}
            />
            <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
            <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
              Upload
            </Button>
          </Space>
        }
      />
      {project.lfsEnabled === false && (
        <div className="knaic-sub" style={{ marginBottom: 8 }}>
          Note: this project does not have LFS enabled. Uploads with the LFS
          checkbox will still attempt the LFS protocol but may be rejected by
          the server.
        </div>
      )}
      <Row gutter={16}>
        <Col xs={24} md={10} lg={9} xxl={8}>
          <Breadcrumb
            style={{ marginBottom: 8 }}
            items={crumbs.map(c => ({
              key: c.key,
              title: <a onClick={() => setPath(c.goto)}>{c.label}</a>,
            }))}
          />
          <Table<GitLabTreeEntryDTO>
            rowKey={r => `${r.type}/${r.path}`}
            size="middle"
            loading={treeLoading}
            dataSource={tree}
            locale={{ emptyText: <Empty description={path ? `Empty folder "${path}"` : 'No files'} /> }}
            pagination={false}
            scroll={{ y: 'calc(100vh - 320px)' }}
            onRow={r => ({
              onClick: () => {
                if (r.type === 'tree') setPath(r.path);
                else void openViewer(r);
              },
              style: {
                cursor: 'pointer',
                // controlItemBgActive is the same token Antd uses for the
                // built-in row-selection highlight, so it lands at the
                // expected tint in both light and dark mode.
                background: viewer && viewer.path === r.path ? token.controlItemBgActive : undefined,
              },
            })}
            columns={[
              {
                title: 'Name',
                dataIndex: 'name',
                render: (name, r) => (
                  <span>
                    {r.type === 'tree' ? <FolderOutlined style={{ marginRight: 6 }} /> : <FileOutlined style={{ marginRight: 6 }} />}
                    {name}
                    {r.isLfs && <Tag color="purple" style={{ marginLeft: 8 }}>LFS</Tag>}
                  </span>
                ),
              },
              {
                title: 'Size',
                dataIndex: 'size',
                width: 90,
                align: 'right',
                render: (v: number | undefined, r) => r.type === 'tree' ? '—' : (v !== undefined ? formatBytes(v) : '—'),
              },
              {
                title: '',
                width: 50,
                render: (_, r) => r.type === 'blob' ? (
                  <Button
                    size="small"
                    type="text"
                    icon={<DownloadOutlined />}
                    onClick={async e => {
                      // Don't let the row's click handler open the
                      // viewer when the user really meant "save it".
                      e.stopPropagation();
                      try {
                        await downloadGitLabFile(
                          namespace,
                          configName!,
                          project.id,
                          r.path,
                          ref,
                        );
                      } catch (err) {
                        message.error((err as Error).message);
                      }
                    }}
                    title="Download"
                  />
                ) : null,
              },
            ]}
          />
        </Col>
        <Col xs={24} md={14} lg={15} xxl={16}>
          <ViewerPane
            viewer={viewer}
            token={token}
            onClose={() => setViewer(null)}
            onDownload={async () => {
              if (!viewer || !configName) return;
              try {
                await downloadGitLabFile(namespace, configName, project.id, viewer.path, ref);
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          />
        </Col>
      </Row>
      <Modal
        open={uploadOpen}
        title={`Upload to ${project.pathWithNamespace}`}
        destroyOnClose
        onCancel={() => setUploadOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          if (!configName) return;
          const file: File | undefined = v.file?.file ?? v.file?.[0]?.originFileObj;
          if (!file) {
            message.error('Pick a file first');
            return;
          }
          const targetPath = ((path ? path.replace(/\/$/, '') + '/' : '') + (v.targetPath || file.name)).replace(/^\/+/, '');
          try {
            await uploadGitLabFile(
              namespace,
              configName,
              project.id,
              targetPath,
              v.branch || ref || 'main',
              v.message || '',
              file,
              v.asLfs ?? false,
            );
            message.success(`Uploaded ${targetPath}`);
            setUploadOpen(false);
            form.resetFields();
            await reload();
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="file" label="File" rules={[{ required: true }]}>
            <Upload beforeUpload={() => false} maxCount={1}>
              <Button icon={<UploadOutlined />}>Choose file</Button>
            </Upload>
          </Form.Item>
          <Form.Item name="targetPath" label="Path in repo (relative to current folder)" tooltip="Leave blank to use the file's own name.">
            <Input placeholder="optional/sub/folder/filename" />
          </Form.Item>
          <Form.Item name="branch" label="Branch" initialValue={ref}>
            <Input />
          </Form.Item>
          <Form.Item name="message" label="Commit message">
            <Input placeholder={`Upload via knaic AI Storage`} />
          </Form.Item>
          <Form.Item name="asLfs" valuePropName="checked">
            <Checkbox>Mark as LFS (recommended for files &gt; 100 MB)</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ViewerState is the shape rendered by ViewerPane. The `kind` discriminator
// lets us cleanly branch on text vs binary placeholders without optional-
// chaining `text` everywhere.
type ViewerState =
  | { kind: 'text'; path: string; name: string; sizeBytes?: number; loading: true }
  | { kind: 'text'; path: string; name: string; sizeBytes?: number; loading: false; text: string; truncated: boolean }
  | { kind: 'text'; path: string; name: string; sizeBytes?: number; loading: false; error: string }
  | { kind: 'binary'; path: string; name: string; sizeBytes?: number; loading: false; reason: string };

function ViewerPane(props: {
  viewer: ViewerState | null;
  token: ReturnType<typeof theme.useToken>['token'];
  onClose: () => void;
  onDownload: () => void | Promise<void>;
}) {
  const { viewer, token, onClose, onDownload } = props;

  // All colors come from the Antd token system so the panel follows the
  // light/dark algorithm instead of staying white in dark mode.
  const panelStyle: React.CSSProperties = {
    background: token.colorBgContainer,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusLG,
    height: 'calc(100vh - 280px)',
    minHeight: 240,
    display: 'flex',
    flexDirection: 'column',
  };

  if (!viewer) {
    return (
      <div style={panelStyle}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>
          <Empty description="Select a file on the left to preview" />
        </div>
      </div>
    );
  }

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flex: '0 0 auto',
      }}
    >
      <FileOutlined />
      <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={viewer.path}>
        {viewer.path}
      </span>
      {viewer.sizeBytes !== undefined && <Tag>{formatBytes(viewer.sizeBytes)}</Tag>}
      {viewer.kind === 'text' && !viewer.loading && 'truncated' in viewer && viewer.truncated && (
        <Tag color="orange">truncated</Tag>
      )}
      <Button size="small" icon={<DownloadOutlined />} onClick={() => void onDownload()}>Download</Button>
      <Button size="small" onClick={onClose}>Close</Button>
    </div>
  );

  let body: React.ReactNode = null;
  if (viewer.kind === 'binary') {
    body = (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Empty
          description={
            <Space direction="vertical" align="center" size="small">
              <span>Preview unavailable — {viewer.reason}.</span>
              <span style={{ color: token.colorTextTertiary }}>Click Download above to fetch the file.</span>
            </Space>
          }
        />
      </div>
    );
  } else if (viewer.loading) {
    body = (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin tip="Loading file…" />
      </div>
    );
  } else if ('error' in viewer && viewer.error) {
    body = (
      <div style={{ padding: 16 }}>
        <Result status="error" title="Could not load file" subTitle={viewer.error} />
      </div>
    );
  } else if ('text' in viewer) {
    body = (
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: 12,
          overflow: 'auto',
          // colorFillQuaternary is the very-subtle fill Antd uses for
          // inline code blocks — sits a hair lighter/darker than the
          // panel surface in both modes.
          background: token.colorFillQuaternary,
          color: token.colorText,
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre',
        }}
      >
        {viewer.text}
      </pre>
    );
  }

  return (
    <div style={panelStyle}>
      {header}
      {body}
    </div>
  );
}

// formatBytes — same compact form the S3 viewer uses; copy-pasted to keep
// this file self-contained. Worth a shared util if a third caller shows up.
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
