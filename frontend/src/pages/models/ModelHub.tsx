import { useEffect, useMemo, useState } from 'react';
import {
  Row,
  Col,
  Card,
  Tag,
  Input,
  Space,
  Button,
  Modal,
  Form,
  Select,
  App,
  Drawer,
  Tabs,
  Upload,
  Empty,
  InputNumber,
  Segmented,
} from 'antd';
import {
  PlusOutlined,
  DownloadOutlined,
  DeleteOutlined,
  UploadOutlined,
  CloudDownloadOutlined,
  GlobalOutlined,
  LockOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import {
  useModels,
  ensureModelsLoaded,
  reloadModels,
  addModel,
  importModelFromURL,
  uploadModelMeta,
  deleteModel,
  updateModel,
  parseUri,
  type ModelItem,
  type ModelScope,
} from '@/data/models';
import { useApp } from '@/context/AppContext';
import { useStorageTargets, targetUri } from '@/data/storageTargets';
import { useRuntimes, ensureRuntimesLoaded } from '@/data/inference';
import { NewInferenceServiceModal } from '@/pages/inference/NewInferenceServiceModal';

const schemeTag: Record<string, { color: string; label: string }> = {
  hf: { color: 'orange', label: 'HuggingFace' },
  modelscope: { color: 'purple', label: 'ModelScope' },
  s3: { color: 'cyan', label: 'S3' },
  oci: { color: 'geekblue', label: 'OCI' },
};

type ModelSort = 'created-desc' | 'created-asc' | 'name-asc';

const sortOptions: { label: string; value: ModelSort }[] = [
  { label: 'Creation time: newest first', value: 'created-desc' },
  { label: 'Creation time: oldest first', value: 'created-asc' },
  { label: 'Alphabetical', value: 'name-asc' },
];

const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function modelTime(value: string): number {
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? 0 : ts;
}

function sortModels(items: ModelItem[], sortBy: ModelSort): ModelItem[] {
  return [...items].sort((a, b) => {
    if (sortBy === 'name-asc') {
      return nameCollator.compare(a.name, b.name) || modelTime(b.createdAt) - modelTime(a.createdAt) || a.id.localeCompare(b.id);
    }
    const delta = modelTime(a.createdAt) - modelTime(b.createdAt);
    const byTime = sortBy === 'created-asc' ? delta : -delta;
    return byTime || nameCollator.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });
}

export function ModelHub() {
  const { scope } = useParams<{ scope: ModelScope }>();
  const actualScope = (scope ?? 'public') as ModelScope;
  const { namespace, user } = useApp();
  const { message, modal } = App.useApp();
  const nav = useNavigate();
  const models = useModels();
  const targets = useStorageTargets();
  const runtimes = useRuntimes();

  // Load on scope/namespace change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    ensureModelsLoaded(actualScope, actualScope === 'private' ? namespace : undefined);
    ensureRuntimesLoaded(namespace);
  }, [actualScope, namespace]);

  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<ModelSort>('created-desc');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [detail, setDetail] = useState<ModelItem | null>(null);
  const [publishModel, setPublishModel] = useState<ModelItem | null>(null);
  const [form] = Form.useForm();
  const [importForm] = Form.useForm();
  const [uploadForm] = Form.useForm();

  const scoped = useMemo(
    () =>
      models.filter(m =>
        actualScope === 'public' ? m.scope === 'public' : m.scope === 'private' && m.namespace === namespace,
      ),
    [models, actualScope, namespace],
  );

  const visibleModels = useMemo(
    () => {
      const items = scoped.filter(m => {
        if (search && !m.name.toLowerCase().includes(search.toLowerCase())) return false;
        if (tagFilter && !m.tags.includes(tagFilter)) return false;
        if (typeFilter !== 'all' && m.modelType !== typeFilter) return false;
        return true;
      });
      return sortModels(items, sortBy);
    },
    [scoped, search, tagFilter, typeFilter, sortBy],
  );

  const allTags = useMemo(
    () => Array.from(new Set(scoped.flatMap(m => m.tags))).sort(),
    [scoped],
  );

  const allModelTypes = useMemo(
    () => Array.from(new Set(scoped.map(m => m.modelType).filter(Boolean))).sort(nameCollator.compare),
    [scoped],
  );

  useEffect(() => {
    if (typeFilter !== 'all' && !allModelTypes.includes(typeFilter)) {
      setTypeFilter('all');
    }
  }, [allModelTypes, typeFilter]);

  const canWritePublic = user.isPlatformAdmin;
  const canWrite = actualScope === 'public' ? canWritePublic : true;

  const openPublish = (m: ModelItem) => {
    setPublishModel(m);
  };

  const publishDefaults = useMemo(() => {
    if (!publishModel) return undefined;
    const defaultRuntime = runtimes.find(r => r.namespace === namespace) ?? runtimes[0];
    return {
      name: publishModel.name.split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]/g, '-') ?? '',
      kind: (publishModel.modelType === 'llm' ? 'LLMInferenceService' : 'InferenceService') as
        'LLMInferenceService' | 'InferenceService',
      runtime: defaultRuntime?.name,
      modelUri: publishModel.uri,
    };
  }, [publishModel, runtimes, namespace]);

  return (
    <div className="knaic-page">
      <PageHeader
        title={
          actualScope === 'public' ? (
            <>
              <GlobalOutlined /> Model Hub · Public
            </>
          ) : (
            <>
              <LockOutlined /> Model Hub · Private ({namespace})
            </>
          )
        }
        description={
          actualScope === 'public'
            ? 'Models visible to all users. Only platform admins can add or remove entries.'
            : `Private models scoped to namespace ${namespace}.`
        }
        extra={
          <Space>
            <Button onClick={() => reloadModels(actualScope, actualScope === 'private' ? namespace : undefined)}>
              Refresh
            </Button>
            {canWrite && (
              <>
                <Button icon={<CloudDownloadOutlined />} onClick={() => setImportOpen(true)}>
                  Import from URL
                </Button>
                <Button icon={<UploadOutlined />} onClick={() => { uploadForm.resetFields(); setUploadOpen(true); }}>
                  Upload from local disk
                </Button>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  Register model
                </Button>
              </>
            )}
          </Space>
        }
      />

      <div className="model-filter-panel">
        <div className="model-filter-row">
          <Space wrap align="center" size={[12, 8]}>
            <Input.Search
              placeholder="Search by name"
              allowClear
              onChange={e => setSearch(e.target.value)}
              style={{ width: 260 }}
            />
            <Select
              allowClear
              placeholder="Filter by tag"
              options={allTags.map(t => ({ label: t, value: t }))}
              onChange={setTagFilter}
              style={{ width: 200 }}
            />
          </Space>
          <Space align="center" size={8} className="model-sort-control">
            <span className="knaic-sub">Sort by</span>
            <Select
              value={sortBy}
              options={sortOptions}
              onChange={setSortBy}
              style={{ width: 230 }}
              aria-label="Sort by"
            />
          </Space>
        </div>
        <div className="model-type-filter">
          <span className="knaic-sub">Model type</span>
          <Segmented
            size="small"
            value={typeFilter}
            options={[
              { label: 'All', value: 'all' },
              ...allModelTypes.map(t => ({ label: t, value: t })),
            ]}
            onChange={value => setTypeFilter(String(value))}
          />
        </div>
      </div>

      {visibleModels.length === 0 ? (
        <Empty description="No models match these filters." />
      ) : (
        <Row gutter={[12, 12]}>
          {visibleModels.map(m => {
            const sch = schemeTag[m.scheme] ?? { color: 'default', label: m.scheme };
            return (
              <Col xs={24} md={12} xl={8} key={m.id}>
                <Card
                  className="model-card"
                  size="small"
                  hoverable
                  onClick={() => setDetail(m)}
                  title={
                    <Space direction="vertical" size={0} style={{ width: '100%' }}>
                      <Space size={6}>
                        <span style={{ fontWeight: 600 }}>{m.name}</span>
                        <Tag color="blue">{m.modelType}</Tag>
                        <Tag color={sch.color}>{sch.label}</Tag>
                      </Space>
                      <span className="knaic-sub mono" style={{ fontSize: 11 }}>
                        {m.uri}
                      </span>
                    </Space>
                  }
                  styles={{ body: { minHeight: 140 } }}
                  actions={[
                    <Button
                      key="publish"
                      type="link"
                      icon={<RocketOutlined />}
                      onClick={e => {
                        e.stopPropagation();
                        openPublish(m);
                      }}
                    >
                      Publish
                    </Button>,
                    <Button
                      key="download"
                      type="link"
                      icon={<DownloadOutlined />}
                      onClick={e => {
                        e.stopPropagation();
                        updateModel(m.id, { downloads: m.downloads + 1 }).catch(err => message.error(err.message));
                        message.success(`Downloading ${m.name} …`);
                      }}
                    >
                      Download
                    </Button>,
                    ...(canWrite
                      ? [
                          <Button
                            key="delete"
                            type="link"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={e => {
                              e.stopPropagation();
                              modal.confirm({
                                title: `Delete ${m.name}?`,
                                onOk: async () => {
                                  try {
                                    await deleteModel(m.id);
                                    message.success('Model deleted');
                                  } catch (err) {
                                    message.error((err as Error).message);
                                  }
                                },
                              });
                            }}
                          >
                            Delete
                          </Button>,
                        ]
                      : []),
                  ]}
                >
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space wrap size={4}>
                      {m.tags.map(t => (
                        <Tag key={t}>{t}</Tag>
                      ))}
                    </Space>
                    <Space size={16} className="knaic-sub" wrap>
                      <span>Size: {m.sizeGB.toFixed(1)} GiB</span>
                      <span>Downloads: {m.downloads}</span>
                      <span>Created: {m.createdAt}</span>
                      <span>Updated: {m.updatedAt}</span>
                    </Space>
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      <Modal
        open={createOpen}
        title="Register model"
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          const scheme = parseUri(v.uri);
          if (!scheme) {
            message.error('Unsupported URI scheme. Use hf:// hf-mirror:// modelscope:// s3:// or oci://');
            return;
          }
          try {
            await addModel({
              name: v.name,
              owner: user.name,
              scope: actualScope,
              namespace: actualScope === 'private' ? namespace : undefined,
              uri: v.uri,
              scheme,
              tags: v.tags ?? [],
              modelType: v.modelType ?? 'llm',
              sizeGB: v.sizeGB ?? 0,
              readme: v.readme ?? `# ${v.name}\n\n_Registered via knaic._`,
            });
            setCreateOpen(false);
            form.resetFields();
            message.success('Model registered');
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="my-org/my-model" />
          </Form.Item>
          <Form.Item name="uri" label="Storage URI" rules={[{ required: true }]}>
            <Input placeholder="hf-mirror://Qwen/Qwen3.5-7B-Instruct or s3://bucket/path/" />
          </Form.Item>
          <Form.Item name="modelType" label="Type" initialValue="llm">
            <Select
              options={[
                { label: 'llm', value: 'llm' },
                { label: 'embedding', value: 'embedding' },
                { label: 'classifier', value: 'classifier' },
                { label: 'diffusion', value: 'diffusion' },
                { label: 'other', value: 'other' },
              ]}
            />
          </Form.Item>
          <Form.Item name="tags" label="Tags">
            <Select mode="tags" />
          </Form.Item>
          <Form.Item name="sizeGB" label="Size (GiB)">
            <InputNumber min={0} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="readme" label="README.md">
            <Input.TextArea rows={6} placeholder="# Model title&#10;&#10;Description…" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={importOpen}
        title="Import model from URL"
        onCancel={() => setImportOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await importForm.validateFields();
          try {
            const created = await importModelFromURL(
              v.url,
              actualScope,
              actualScope === 'private' ? namespace : undefined,
            );
            setImportOpen(false);
            importForm.resetFields();
            message.success(`Imported ${created.name}`);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={importForm} layout="vertical" preserve={false}>
          <Form.Item name="url" label="HuggingFace or ModelScope URL" rules={[{ required: true }]}>
            <Input placeholder="https://huggingface.co/Qwen/Qwen3.5-7B-Instruct" />
          </Form.Item>
          <div className="knaic-sub">
            knaic will sync model files from the source into the selected storage backend.
          </div>
        </Form>
      </Modal>

      <Modal
        open={uploadOpen}
        title="Upload model from local disk"
        onCancel={() => setUploadOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await uploadForm.validateFields();
          const target = targets.find(t => t.id === v.target)!;
          const sub = `${actualScope === 'private' ? namespace + '/' : ''}${v.name}/`;
          const uri = targetUri(target, sub);
          try {
            await uploadModelMeta({
              name: v.name,
              scope: actualScope,
              namespace: actualScope === 'private' ? namespace : undefined,
              targetUri: uri,
              modelType: v.modelType ?? 'llm',
              sizeGB: v.sizeGB ?? 0,
              tags: ['uploaded'],
              readme: `# ${v.name}\n\nUploaded from local disk to ${target.name}.`,
            });
            setUploadOpen(false);
            uploadForm.resetFields();
            message.success(`Upload to ${target.name} enqueued`);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={uploadForm} layout="vertical" preserve={false} initialValues={{ modelType: 'llm' }}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="my-team/my-model" />
          </Form.Item>
          <Form.Item name="target" label="Storage target" rules={[{ required: true }]}>
            <Select
              options={targets.map(t => ({
                label: (
                  <Space>
                    <Tag color={t.kind === 's3' ? 'cyan' : t.kind === 'oci' ? 'geekblue' : 'default'}>{t.kind}</Tag>
                    <span>{t.name}</span>
                    {t.builtin && <Tag color="blue">built-in</Tag>}
                  </Space>
                ),
                value: t.id,
              }))}
              placeholder="Where to store the uploaded files"
            />
          </Form.Item>
          <Form.Item name="modelType" label="Type">
            <Select
              options={[
                { label: 'llm', value: 'llm' },
                { label: 'embedding', value: 'embedding' },
                { label: 'classifier', value: 'classifier' },
                { label: 'diffusion', value: 'diffusion' },
                { label: 'other', value: 'other' },
              ]}
            />
          </Form.Item>
          <Form.Item name="sizeGB" label="Size (GiB)">
            <InputNumber min={0} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Files">
            <Upload.Dragger multiple beforeUpload={() => false} directory>
              <p>
                <UploadOutlined /> Click or drag a directory of safetensors / .bin / .gguf files
              </p>
            </Upload.Dragger>
          </Form.Item>
        </Form>
      </Modal>

      <NewInferenceServiceModal
        open={!!publishModel}
        namespace={namespace}
        defaults={publishDefaults}
        lockModel
        title={publishModel ? `Publish ${publishModel.name} to inference` : 'Publish to inference'}
        onClose={() => setPublishModel(null)}
        onCreated={() => nav('/inference/services')}
      />

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name}
        width={720}
        destroyOnClose
        extra={
          detail && (
            <Button
              type="primary"
              icon={<RocketOutlined />}
              onClick={() => {
                setDetail(null);
                openPublish(detail);
              }}
            >
              Publish
            </Button>
          )
        }
      >
        {detail && (
          <Tabs
            items={[
              {
                key: 'readme',
                label: 'README',
                children: (
                  <div style={{ lineHeight: 1.7 }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.readme}</ReactMarkdown>
                  </div>
                ),
              },
              {
                key: 'meta',
                label: 'Metadata',
                children: (
                  <div className="knaic-kv">
                    <div className="k">Owner</div><div>{detail.owner}</div>
                    <div className="k">Scope</div><div>{detail.scope}</div>
                    <div className="k">Namespace</div><div>{detail.namespace ?? '—'}</div>
                    <div className="k">Storage URI</div><div className="mono">{detail.uri}</div>
                    <div className="k">Type</div><div>{detail.modelType}</div>
                    <div className="k">Tags</div>
                    <div>
                      <Space wrap>
                        {detail.tags.map(t => <Tag key={t}>{t}</Tag>)}
                      </Space>
                    </div>
                    <div className="k">Size</div><div>{detail.sizeGB.toFixed(1)} GiB</div>
                    <div className="k">Downloads</div><div>{detail.downloads}</div>
                    <div className="k">Created</div><div>{detail.createdAt}</div>
                    <div className="k">Updated</div><div>{detail.updatedAt}</div>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Drawer>
    </div>
  );
}
