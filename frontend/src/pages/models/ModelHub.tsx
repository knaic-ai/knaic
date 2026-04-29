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
import { useRuntimes, ensureRuntimesLoaded, createInferenceService } from '@/data/inference';

const schemeTag: Record<string, { color: string; label: string }> = {
  hf: { color: 'orange', label: 'HuggingFace' },
  modelscope: { color: 'purple', label: 'ModelScope' },
  s3: { color: 'cyan', label: 'S3' },
  oci: { color: 'geekblue', label: 'OCI' },
};

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
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [detail, setDetail] = useState<ModelItem | null>(null);
  const [publishModel, setPublishModel] = useState<ModelItem | null>(null);
  const [form] = Form.useForm();
  const [importForm] = Form.useForm();
  const [uploadForm] = Form.useForm();
  const [publishForm] = Form.useForm();

  const scoped = useMemo(
    () =>
      models.filter(m =>
        actualScope === 'public' ? m.scope === 'public' : m.scope === 'private' && m.namespace === namespace,
      ),
    [models, actualScope, namespace],
  );

  const filtered = useMemo(
    () =>
      scoped.filter(m => {
        if (search && !m.name.toLowerCase().includes(search.toLowerCase())) return false;
        if (tagFilter && !m.tags.includes(tagFilter)) return false;
        return true;
      }),
    [scoped, search, tagFilter],
  );

  const allTags = useMemo(
    () => Array.from(new Set(scoped.flatMap(m => m.tags))).sort(),
    [scoped],
  );

  const canWritePublic = user.isPlatformAdmin;
  const canWrite = actualScope === 'public' ? canWritePublic : true;

  const openPublish = (m: ModelItem) => {
    setPublishModel(m);
    const defaultRuntime = runtimes.find(r => r.namespace === namespace) ?? runtimes[0];
    publishForm.setFieldsValue({
      name: m.name.split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      kind: m.modelType === 'llm' ? 'LLMInferenceService' : 'InferenceService',
      runtime: defaultRuntime?.name,
      replicas: 1,
      gpu: m.modelType === 'llm' ? 1 : 0,
    });
  };

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

      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="Search by name"
          allowClear
          onChange={e => setSearch(e.target.value)}
          style={{ width: 280 }}
        />
        <Select
          allowClear
          placeholder="Filter by tag"
          options={allTags.map(t => ({ label: t, value: t }))}
          onChange={setTagFilter}
          style={{ width: 200 }}
        />
      </Space>

      {filtered.length === 0 ? (
        <Empty description="No models match these filters." />
      ) : (
        <Row gutter={[12, 12]}>
          {filtered.map(m => {
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
            message.error('Unsupported URI scheme. Use hf:// modelscope:// s3:// or oci://');
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
            <Input placeholder="hf://Qwen/Qwen3.5-7B-Instruct or s3://bucket/path/" />
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

      <Modal
        open={!!publishModel}
        title={publishModel ? `Publish ${publishModel.name} to inference` : ''}
        onCancel={() => setPublishModel(null)}
        destroyOnClose
        okText="Create inference service"
        okButtonProps={{ icon: <RocketOutlined /> }}
        onOk={async () => {
          const v = await publishForm.validateFields();
          if (!publishModel) return;
          try {
            await createInferenceService(namespace, {
              name: v.name,
              kind: v.kind,
              runtime: v.runtime,
              modelUri: publishModel.uri,
              replicas: v.replicas,
              cpuRequest: '8',
              memoryRequest: '64Gi',
              gpuValues: v.gpu > 0 ? { 'nvidia.com/gpu': v.gpu } : undefined,
            });
            setPublishModel(null);
            publishForm.resetFields();
            message.success(`Publishing ${publishModel.name} → ${v.name}`);
            nav('/inference/services');
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={publishForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Service name" rules={[{ required: true, pattern: /^[a-z0-9-]+$/ }]}>
            <Input placeholder="my-service" />
          </Form.Item>
          <Form.Item name="kind" label="Kind" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'LLMInferenceService (KServe v1alpha1)', value: 'LLMInferenceService' },
                { label: 'InferenceService (KServe v1beta1)', value: 'InferenceService' },
              ]}
            />
          </Form.Item>
          <Form.Item name="runtime" label="Serving runtime" rules={[{ required: true }]}>
            <Select options={runtimes.map(r => ({ label: `${r.name} · ${r.image}`, value: r.name }))} />
          </Form.Item>
          <Form.Item name="replicas" label="Replicas" rules={[{ required: true }]}>
            <InputNumber min={1} max={16} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="gpu" label="GPUs per replica">
            <InputNumber min={0} max={16} style={{ width: '100%' }} />
          </Form.Item>
          <div className="knaic-sub">
            Target namespace: <b>{namespace}</b>. Model URI: <span className="mono">{publishModel?.uri}</span>.
            Advanced tuning is available on the Inference services page.
          </div>
        </Form>
      </Modal>

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
