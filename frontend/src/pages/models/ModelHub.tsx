import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
  theme,
} from 'antd';
import {
  AppstoreOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  ShareAltOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import {
  useModels,
  ensureModelsLoaded,
  reloadModels,
  addModel,
  importModelFromURL,
  uploadModelMeta,
  deleteModel,
  parseUri,
  publicSourceURL,
  isPublicSource,
  type ModelItem,
  type ModelScope,
} from '@/data/models';
import { useApp } from '@/context/AppContext';
import { ensureStorageTargetsLoaded, useStorageTargets, targetUri } from '@/data/storageTargets';
import {
  ensureCollectionsLoaded,
  reloadCollections,
  upsertCollectionLocal,
  removeCollectionLocal,
  useCollections,
} from '@/data/collections';
import {
  createCollection,
  patchCollection,
  deleteCollection,
  type CollectionDTO,
} from '@/api/collections';
import { NewInferenceServiceModal } from '@/pages/inference/NewInferenceServiceModal';
import { useRuntimes, ensureRuntimesLoaded } from '@/data/inference';
import { ModelTypeBadge } from './ModelTypeBadge';
import { MODEL_TYPE_META, MODEL_TYPE_OPTIONS } from './modelTypeMeta';
import { PublishRequestModal } from './PublishRequestModal';

const schemeTag: Record<string, { color: string; label: string }> = {
  hf: { color: 'orange', label: 'HuggingFace' },
  modelscope: { color: 'purple', label: 'ModelScope' },
  s3: { color: 'cyan', label: 'S3' },
  oci: { color: 'geekblue', label: 'OCI' },
  gitlab: { color: 'magenta', label: 'GitLab' },
  pvc: { color: 'gold', label: 'PVC' },
  git: { color: 'magenta', label: 'Git' },
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
      return (
        nameCollator.compare(a.name, b.name) ||
        modelTime(b.createdAt) - modelTime(a.createdAt) ||
        a.id.localeCompare(b.id)
      );
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
  const [sp, setSp] = useSearchParams();
  const models = useModels();
  const collections = useCollections();
  const targets = useStorageTargets();
  const runtimes = useRuntimes();
  const { token } = theme.useToken();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    ensureModelsLoaded(actualScope, actualScope === 'private' ? namespace : undefined);
    ensureCollectionsLoaded(actualScope, actualScope === 'private' ? namespace : undefined);
    ensureRuntimesLoaded(namespace);
    ensureStorageTargetsLoaded();
  }, [actualScope, namespace]);

  const activeTab = sp.get('tab') === 'collections' ? 'collections' : 'models';
  const collectionFilter = sp.get('collection') ?? '';

  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<ModelSort>('created-desc');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [publishModel, setPublishModel] = useState<ModelItem | null>(null);
  const [publishToCatalog, setPublishToCatalog] = useState<ModelItem | null>(null);
  const [collectionEditor, setCollectionEditor] = useState<CollectionDTO | { creating: true } | null>(null);
  const [form] = Form.useForm();
  const [importForm] = Form.useForm();
  const [uploadForm] = Form.useForm();
  const [collectionForm] = Form.useForm();

  const scopedModels = useMemo(
    () =>
      models.filter(m =>
        actualScope === 'public'
          ? m.scope === 'public'
          : m.scope === 'private' && m.namespace === namespace,
      ),
    [models, actualScope, namespace],
  );

  const scopedCollections = useMemo(
    () =>
      collections.filter(c =>
        actualScope === 'public'
          ? c.scope === 'public'
          : c.scope === 'private' && c.namespace === namespace,
      ),
    [collections, actualScope, namespace],
  );

  const visibleModels = useMemo(() => {
    const items = scopedModels.filter(m => {
      if (search && !m.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (tagFilter && !m.tags.includes(tagFilter)) return false;
      if (typeFilter !== 'all' && m.modelType !== typeFilter) return false;
      if (collectionFilter && m.collectionId !== collectionFilter) return false;
      return true;
    });
    return sortModels(items, sortBy);
  }, [scopedModels, search, tagFilter, typeFilter, sortBy, collectionFilter]);

  const allTags = useMemo(
    () => Array.from(new Set(scopedModels.flatMap(m => m.tags))).sort(),
    [scopedModels],
  );

  const allModelTypes = useMemo(
    () => Array.from(new Set(scopedModels.map(m => m.modelType).filter(Boolean))).sort(nameCollator.compare),
    [scopedModels],
  );

  useEffect(() => {
    if (typeFilter !== 'all' && !allModelTypes.includes(typeFilter)) {
      setTypeFilter('all');
    }
  }, [allModelTypes, typeFilter]);

  const canWritePublic = user.isPlatformAdmin;
  const canWrite = actualScope === 'public' ? canWritePublic : true;
  const isCatalog = actualScope === 'public';

  const publishDefaults = useMemo(() => {
    if (!publishModel) return undefined;
    const defaultRuntime = runtimes.find(r => r.namespace === namespace) ?? runtimes[0];
    return {
      name: publishModel.name.split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]/g, '-') ?? '',
      kind: (publishModel.modelType === 'llm' ? 'LLMInferenceService' : 'InferenceService') as
        | 'LLMInferenceService'
        | 'InferenceService',
      runtime: defaultRuntime?.name,
      modelUri: publishModel.uri,
    };
  }, [publishModel, runtimes, namespace]);

  const collectionsById = useMemo(() => {
    const m = new Map<string, CollectionDTO>();
    scopedCollections.forEach(c => m.set(c.id, c));
    return m;
  }, [scopedCollections]);

  // Reset the collection filter when its target collection disappears.
  useEffect(() => {
    if (collectionFilter && !collectionsById.has(collectionFilter)) {
      const next = new URLSearchParams(sp);
      next.delete('collection');
      setSp(next, { replace: true });
    }
  }, [collectionFilter, collectionsById, sp, setSp]);

  const clearCollectionFilter = () => {
    const next = new URLSearchParams(sp);
    next.delete('collection');
    setSp(next);
  };

  const renderModelCard = (m: ModelItem) => {
    const sch = schemeTag[m.scheme] ?? { color: 'default', label: m.scheme };
    const sourceURL = publicSourceURL(m.uri, m.sourceUrl);
    const collection = m.collectionId ? collectionsById.get(m.collectionId) : undefined;
    return (
      <Col xs={24} md={12} xl={8} key={m.id}>
        <Card
          className="model-card"
          size="small"
          hoverable
          onClick={() => nav(`/models/${actualScope}/${m.id}`)}
          title={
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Space size={6} wrap>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                <ModelTypeBadge type={m.modelType} size="small" />
                <Tag color={sch.color}>{sch.label}</Tag>
                {sourceURL && (
                  <Tooltip title="Open original source">
                    <Button
                      type="text"
                      size="small"
                      icon={<ExportOutlined />}
                      onClick={e => {
                        e.stopPropagation();
                        window.open(sourceURL, '_blank', 'noopener,noreferrer');
                      }}
                    />
                  </Tooltip>
                )}
              </Space>
              <span className="knaic-sub mono" style={{ fontSize: 11 }}>{m.uri}</span>
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
                setPublishModel(m);
              }}
            >
              Publish
            </Button>,
            ...(actualScope === 'private' && isPublicSource(m.uri)
              ? [
                  <Button
                    key="publish-catalog"
                    type="link"
                    icon={<ShareAltOutlined />}
                    onClick={e => {
                      e.stopPropagation();
                      setPublishToCatalog(m);
                    }}
                  >
                    To catalog
                  </Button>,
                ]
              : []),
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
            {collection && (
              <Tag
                icon={<AppstoreOutlined />}
                style={{
                  background: collection.iconColor ? `${collection.iconColor}1A` : undefined,
                  borderColor: collection.iconColor ? `${collection.iconColor}55` : undefined,
                  color: collection.iconColor ?? undefined,
                  fontWeight: 600,
                }}
              >
                {collection.name}
              </Tag>
            )}
            <Space wrap size={4}>
              {m.tags.map(t => (
                <Tag key={t}>{t}</Tag>
              ))}
            </Space>
            <Space size={16} className="knaic-sub" wrap>
              <span>Size: {m.sizeGB.toFixed(1)} GiB</span>
              <span>Downloads: {m.downloads}</span>
              <span>Created: {m.createdAt}</span>
            </Space>
          </Space>
        </Card>
      </Col>
    );
  };

  const renderModelsList = () => (
    <>
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
            {collectionFilter && (
              <Tag closable onClose={clearCollectionFilter} color="purple" icon={<AppstoreOutlined />}>
                Collection: {collectionsById.get(collectionFilter)?.name ?? collectionFilter}
              </Tag>
            )}
          </Space>
          <Space align="center" size={8} className="model-sort-control">
            <span className="knaic-sub">Sort by</span>
            <Select value={sortBy} options={sortOptions} onChange={setSortBy} style={{ width: 230 }} />
          </Space>
        </div>
        <div className="model-type-filter">
          <span className="knaic-sub">Model type</span>
          <Segmented
            size="small"
            value={typeFilter}
            options={[
              { label: 'All', value: 'all' },
              ...allModelTypes.map(t => {
                const meta = MODEL_TYPE_META[t];
                if (!meta) return { label: t, value: t };
                const Icon = meta.Icon;
                return {
                  label: (
                    <Space size={4}>
                      <Icon style={{ color: meta.color, fontSize: 12 }} />
                      <span>{meta.label}</span>
                    </Space>
                  ),
                  value: t,
                };
              }),
            ]}
            onChange={value => setTypeFilter(String(value))}
          />
        </div>
      </div>
      {visibleModels.length === 0 ? (
        <Empty description="No models match these filters." />
      ) : (
        <Row gutter={[12, 12]}>{visibleModels.map(renderModelCard)}</Row>
      )}
    </>
  );

  const renderCollectionsTab = () => (
    <>
      {canWrite && (
        <div style={{ marginBottom: 12 }}>
          <Button icon={<PlusOutlined />} onClick={() => setCollectionEditor({ creating: true })}>
            New collection
          </Button>
        </div>
      )}
      {scopedCollections.length === 0 ? (
        <Empty description="No collections yet." />
      ) : (
        <Row gutter={[12, 12]}>
          {scopedCollections.map(c => {
            const count = scopedModels.filter(m => m.collectionId === c.id).length;
            return (
              <Col xs={24} md={12} xl={8} key={c.id}>
                <Card
                  size="small"
                  hoverable
                  onClick={() => {
                    const next = new URLSearchParams(sp);
                    next.set('tab', 'models');
                    next.set('collection', c.id);
                    setSp(next);
                  }}
                  styles={{ body: { minHeight: 120 } }}
                  title={
                    <Space>
                      <AppstoreOutlined style={{ color: c.iconColor ?? token.colorPrimary }} />
                      <Typography.Text strong>{c.name}</Typography.Text>
                      <Tag>{count} models</Tag>
                    </Space>
                  }
                  actions={
                    canWrite
                      ? [
                          <Button
                            key="edit"
                            type="link"
                            icon={<EditOutlined />}
                            onClick={e => {
                              e.stopPropagation();
                              setCollectionEditor(c);
                            }}
                          >
                            Edit
                          </Button>,
                          <Button
                            key="delete"
                            type="link"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={e => {
                              e.stopPropagation();
                              modal.confirm({
                                title: `Delete collection "${c.name}"?`,
                                content:
                                  count > 0
                                    ? `${count} model(s) reference this collection and will lose the link.`
                                    : undefined,
                                onOk: async () => {
                                  try {
                                    await deleteCollection(c.id);
                                    removeCollectionLocal(c.id);
                                    message.success('Collection deleted');
                                  } catch (e) {
                                    message.error((e as Error).message);
                                  }
                                },
                              });
                            }}
                          >
                            Delete
                          </Button>,
                        ]
                      : undefined
                  }
                >
                  <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                    {c.description || '—'}
                  </Typography.Paragraph>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}
    </>
  );

  return (
    <div className="knaic-page">
      <PageHeader
        title={
          actualScope === 'public' ? (
            <>
              <GlobalOutlined /> Model Catalog
            </>
          ) : (
            <>
              <LockOutlined /> Private Models · {namespace}
            </>
          )
        }
        description={
          actualScope === 'public'
            ? 'Public models curated by platform admins. Other users can request to publish their private models here.'
            : `Private models scoped to namespace ${namespace}.`
        }
        extra={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                reloadModels(actualScope, actualScope === 'private' ? namespace : undefined);
                reloadCollections(actualScope, actualScope === 'private' ? namespace : undefined);
              }}
            >
              Refresh
            </Button>
            {canWrite && (
              <>
                <Button icon={<CloudDownloadOutlined />} onClick={() => setImportOpen(true)}>
                  Import from URL
                </Button>
                {actualScope === 'private' && (
                  <Button
                    icon={<UploadOutlined />}
                    onClick={() => {
                      uploadForm.resetFields();
                      setUploadOpen(true);
                    }}
                  >
                    Upload from local disk
                  </Button>
                )}
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  Register model
                </Button>
              </>
            )}
          </Space>
        }
      />

      <Tabs
        activeKey={activeTab}
        onChange={key => {
          const next = new URLSearchParams(sp);
          if (key === 'models') {
            next.delete('tab');
          } else {
            next.set('tab', key);
            next.delete('collection');
          }
          setSp(next);
        }}
        items={[
          {
            key: 'models',
            label: (
              <span>
                <FolderOpenOutlined /> Models
              </span>
            ),
            children: renderModelsList(),
          },
          {
            key: 'collections',
            label: (
              <span>
                <AppstoreOutlined /> Collections
              </span>
            ),
            children: renderCollectionsTab(),
          },
        ]}
      />

      {/* Register URI modal */}
      <Modal
        open={createOpen}
        title="Register model"
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          const scheme = parseUri(v.uri);
          if (!scheme) {
            message.error('Unsupported URI scheme. Use hf:// hf-mirror:// hf-local:// modelscope:// s3:// oci:// or gitlab://');
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
              collectionId: v.collectionId,
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
            <Select options={MODEL_TYPE_OPTIONS.map(o => ({ label: o.label, value: o.id }))} />
          </Form.Item>
          <Form.Item name="collectionId" label="Collection">
            <Select
              allowClear
              placeholder="Group with an existing collection (optional)"
              options={scopedCollections.map(c => ({ label: c.name, value: c.id }))}
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

      {/* Import from URL */}
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

      {/* Upload from local disk */}
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
            <Select options={MODEL_TYPE_OPTIONS.map(o => ({ label: o.label, value: o.id }))} />
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

      {/* Collection editor */}
      <Modal
        open={!!collectionEditor}
        title={
          collectionEditor && 'creating' in collectionEditor
            ? 'New collection'
            : collectionEditor
              ? `Edit collection ${(collectionEditor as CollectionDTO).name}`
              : ''
        }
        onCancel={() => setCollectionEditor(null)}
        destroyOnClose
        afterOpenChange={open => {
          if (open && collectionEditor) {
            if ('creating' in collectionEditor) {
              collectionForm.setFieldsValue({ name: '', description: '', iconColor: '' });
            } else {
              collectionForm.setFieldsValue({
                name: collectionEditor.name,
                description: collectionEditor.description,
                iconColor: collectionEditor.iconColor,
              });
            }
          }
        }}
        onOk={async () => {
          const v = await collectionForm.validateFields();
          try {
            if (collectionEditor && 'creating' in collectionEditor) {
              const created = await createCollection({
                name: v.name,
                scope: actualScope,
                namespace: actualScope === 'private' ? namespace : undefined,
                description: v.description,
                iconColor: v.iconColor,
              });
              upsertCollectionLocal(created);
              message.success('Collection created');
            } else if (collectionEditor) {
              const updated = await patchCollection(collectionEditor.id, {
                name: v.name,
                description: v.description,
                iconColor: v.iconColor,
              });
              upsertCollectionLocal(updated);
              message.success('Collection updated');
            }
            setCollectionEditor(null);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={collectionForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="Qwen3.5" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="What models live in this collection?" />
          </Form.Item>
          <Form.Item name="iconColor" label="Accent color (hex)">
            <Input placeholder="#722ED1" />
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

      <PublishRequestModal
        open={!!publishToCatalog}
        model={publishToCatalog}
        onClose={() => setPublishToCatalog(null)}
        onCreated={() => {
          setPublishToCatalog(null);
          message.success('Publish request submitted; an admin will review.');
        }}
      />
    </div>
  );
}
