import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Result,
  Row,
  Skeleton,
  Space,
  Spin,
  Tag,
  theme,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  ApiOutlined,
  AppstoreOutlined,
  BranchesOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  GlobalOutlined,
  LinkOutlined,
  LockOutlined,
  PartitionOutlined,
  ReadOutlined,
  RocketOutlined,
  ShareAltOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import {
  useModels,
  ensureModelsLoaded,
  deleteModel,
  publicSourceURL,
  isPublicSource,
  type ModelItem,
  type ModelScope,
} from '@/data/models';
import { ensureCollectionsLoaded, useCollections } from '@/data/collections';
import { ensureRuntimesLoaded, useRuntimes } from '@/data/inference';
import { getModelTree, listInferenceServicesUsingModel, type InferenceServiceRef } from '@/api/models';
import type { ModelTreeDTO } from '@/api/models';
import { NewInferenceServiceModal } from '@/pages/inference/NewInferenceServiceModal';
import { PublishRequestModal } from './PublishRequestModal';
import { ModelTypeBadge } from './ModelTypeBadge';

const schemeTag: Record<string, { color: string; label: string }> = {
  hf: { color: 'orange', label: 'HuggingFace' },
  modelscope: { color: 'purple', label: 'ModelScope' },
  s3: { color: 'cyan', label: 'S3' },
  oci: { color: 'geekblue', label: 'OCI' },
  gitlab: { color: 'magenta', label: 'GitLab' },
  pvc: { color: 'gold', label: 'PVC' },
  git: { color: 'magenta', label: 'Git' },
};

const derivedKindLabel: Record<string, string> = {
  finetune: 'Finetunes',
  quantization: 'Quantizations',
  adapter: 'Adapters',
};

export function ModelDetailPage() {
  const { scope, id } = useParams<{ scope: ModelScope; id: string }>();
  const actualScope = (scope ?? 'public') as ModelScope;
  const { namespace, user } = useApp();
  const { message, modal } = App.useApp();
  const nav = useNavigate();
  const models = useModels();
  const collections = useCollections();
  const runtimes = useRuntimes();
  const { token } = theme.useToken();

  const [tree, setTree] = useState<ModelTreeDTO | null>(null);
  const [services, setServices] = useState<InferenceServiceRef[] | null>(null);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishToInference, setPublishToInference] = useState(false);

  useEffect(() => {
    ensureModelsLoaded(actualScope, actualScope === 'private' ? namespace : undefined);
    ensureCollectionsLoaded(actualScope, actualScope === 'private' ? namespace : undefined);
    ensureRuntimesLoaded(namespace);
  }, [actualScope, namespace]);

  const detail = useMemo<ModelItem | undefined>(() => models.find(m => m.id === id), [models, id]);

  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    setTreeLoading(true);
    getModelTree(detail.id)
      .then(t => {
        if (!cancelled) {
          setTree(t);
          setTreeLoading(false);
        }
      })
      .catch(() => !cancelled && setTreeLoading(false));
    return () => {
      cancelled = true;
    };
  }, [detail?.id]);

  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    setServicesLoading(true);
    setServicesError(null);
    const ns = detail.scope === 'private' ? detail.namespace : namespace;
    listInferenceServicesUsingModel(detail.id, ns)
      .then(items => {
        if (!cancelled) {
          setServices(items);
          setServicesLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setServicesError((err as Error).message);
          setServices([]);
          setServicesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.id, detail?.namespace, namespace]);

  if (!detail) {
    return (
      <div className="knaic-page">
        <Skeleton active />
      </div>
    );
  }

  const collection = collections.find(c => c.id === detail.collectionId);
  const sch = schemeTag[detail.scheme] ?? { color: 'default', label: detail.scheme };
  const sourceURL = publicSourceURL(detail.uri, detail.sourceUrl);
  const canEdit = detail.scope === 'private' ? true : user.isPlatformAdmin;
  const canPublishToCatalog = detail.scope === 'private' && isPublicSource(detail.uri);
  const isCatalog = detail.scope === 'public';

  const defaultRuntime = runtimes.find(r => r.namespace === namespace) ?? runtimes[0];
  const publishDefaults = {
    name: detail.name.split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]/g, '-') ?? '',
    kind: (detail.modelType === 'llm' ? 'LLMInferenceService' : 'InferenceService') as
      | 'LLMInferenceService'
      | 'InferenceService',
    runtime: defaultRuntime?.name,
    modelUri: detail.uri,
  };

  const handleDelete = () => {
    modal.confirm({
      title: `Delete ${detail.name}?`,
      onOk: async () => {
        try {
          await deleteModel(detail.id);
          message.success('Model deleted');
          nav(`/models/${actualScope}`);
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title={
          <Space size={8} align="center">
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => nav(`/models/${actualScope}`)} />
            {actualScope === 'public' ? <GlobalOutlined /> : <LockOutlined />}
            <Typography.Text strong style={{ fontSize: 20 }}>{detail.name}</Typography.Text>
            <ModelTypeBadge type={detail.modelType} />
            <Tag color={sch.color}>{sch.label}</Tag>
            {detail.derivedKind && (
              <Tag color="default" icon={<BranchesOutlined />}>
                {derivedKindLabel[detail.derivedKind] ?? detail.derivedKind}
              </Tag>
            )}
          </Space>
        }
        description={detail.uri}
        extra={
          <Space wrap>
            {sourceURL && (
              <Tooltip title="Open original source page">
                <Button
                  icon={<ExportOutlined />}
                  href={sourceURL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Source
                </Button>
              </Tooltip>
            )}
            <Button
              type="primary"
              icon={<RocketOutlined />}
              onClick={() => setPublishToInference(true)}
            >
              Publish to inference
            </Button>
            {canPublishToCatalog && (
              <Button icon={<ShareAltOutlined />} onClick={() => setPublishOpen(true)}>
                Request publish to catalog
              </Button>
            )}
            {canEdit && (
              <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>
                Delete
              </Button>
            )}
          </Space>
        }
      />

      {!isCatalog && !isPublicSource(detail.uri) && (
        <Alert
          type="warning"
          showIcon
          message="This model's storage URI requires private credentials, so it cannot be published to the public catalog."
          style={{ marginBottom: 12 }}
        />
      )}

      <Row gutter={[16, 16]} align="top">
        <Col xs={24} lg={15} xxl={16}>
          <Card title={<Space><ReadOutlined /> README</Space>}>
            <div style={{ lineHeight: 1.7 }} className="knaic-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {detail.readme || '_No README provided._'}
              </ReactMarkdown>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={9} xxl={8}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small" title={<Space><LinkOutlined /> Metadata</Space>}>
              <div className="knaic-kv">
                <div className="k">Owner</div><div>{detail.owner || '—'}</div>
                <div className="k">Scope</div><div>{detail.scope}</div>
                <div className="k">Namespace</div><div>{detail.namespace ?? '—'}</div>
                <div className="k">Storage URI</div><div className="mono">{detail.uri}</div>
                <div className="k">Source URL</div>
                <div className="mono">
                  {sourceURL ? (
                    <a href={sourceURL} target="_blank" rel="noopener noreferrer">{sourceURL}</a>
                  ) : '—'}
                </div>
                <div className="k">Type</div><div><ModelTypeBadge type={detail.modelType} /></div>
                <div className="k">Tags</div>
                <div><Space wrap>{detail.tags.map(t => <Tag key={t}>{t}</Tag>)}</Space></div>
                <div className="k">Size</div><div>{detail.sizeGB.toFixed(1)} GiB</div>
                <div className="k">Downloads</div><div>{detail.downloads}</div>
                <div className="k">Created</div><div>{detail.createdAt}</div>
                <div className="k">Updated</div><div>{detail.updatedAt}</div>
              </div>
            </Card>

            <Card size="small" title={<Space><AppstoreOutlined /> Collection</Space>}>
              {collection ? (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Typography.Link
                    strong
                    onClick={() =>
                      nav(`/models/${actualScope}?collection=${encodeURIComponent(collection.id)}`)
                    }
                  >
                    {collection.name}
                  </Typography.Link>
                  {collection.description && (
                    <Typography.Paragraph
                      type="secondary"
                      style={{ marginBottom: 0 }}
                      ellipsis={{ rows: 3, expandable: true }}
                    >
                      {collection.description}
                    </Typography.Paragraph>
                  )}
                </Space>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="Not in a collection"
                  style={{ margin: 0 }}
                />
              )}
            </Card>

            <Card size="small" title={<Space><PartitionOutlined /> Model tree</Space>}>
              {treeLoading ? (
                <Spin />
              ) : (
                <ModelTreeView tree={tree} onOpen={mid => nav(`/models/${actualScope}/${mid}`)} />
              )}
            </Card>

            <Card size="small" title={<Space><ApiOutlined /> Inference services</Space>}>
              {servicesLoading ? (
                <Spin />
              ) : servicesError ? (
                <Result
                  status="warning"
                  title="Could not list inference services"
                  subTitle={servicesError}
                  style={{ padding: 8 }}
                />
              ) : (services?.length ?? 0) === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No inference services are using this model."
                  style={{ margin: 0 }}
                />
              ) : (
                <Space direction="vertical" style={{ width: '100%' }} size={6}>
                  {services!.map(svc => (
                    <Card
                      key={`${svc.namespace}/${svc.kind}/${svc.name}`}
                      size="small"
                      hoverable
                      styles={{ body: { padding: 8 } }}
                      onClick={() =>
                        nav(
                          `/namespaces/${encodeURIComponent(svc.namespace)}/inference/services/${encodeURIComponent(svc.name)}?kind=${svc.kind}`,
                        )
                      }
                    >
                      <Space size={[8, 4]} wrap>
                        <Tag color={svc.kind === 'LLMInferenceService' ? 'purple' : 'geekblue'}>
                          {svc.kind}
                        </Tag>
                        <strong>{svc.name}</strong>
                        <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>
                          ns: {svc.namespace}
                        </span>
                        {svc.ready && (
                          <Tag color={svc.ready === 'True' ? 'success' : 'warning'}>
                            Ready={svc.ready}
                          </Tag>
                        )}
                      </Space>
                    </Card>
                  ))}
                </Space>
              )}
            </Card>
          </Space>
        </Col>
      </Row>

      <NewInferenceServiceModal
        open={publishToInference}
        namespace={namespace}
        defaults={publishDefaults}
        lockModel
        title={`Publish ${detail.name} to inference`}
        onClose={() => setPublishToInference(false)}
        onCreated={() => nav('/inference/services')}
      />
      <PublishRequestModal
        open={publishOpen}
        model={detail}
        onClose={() => setPublishOpen(false)}
        onCreated={() => {
          setPublishOpen(false);
          message.success('Publish request submitted; an admin will review.');
        }}
      />
    </div>
  );
}

function ModelTreeView({ tree, onOpen }: { tree: ModelTreeDTO | null; onOpen: (id: string) => void }) {
  const { token } = theme.useToken();
  if (!tree) {
    return <Empty description="No model relations yet." />;
  }
  const groups: Array<['finetune' | 'quantization' | 'adapter', ModelItem[]]> = [
    ['finetune', tree.children.finetune ?? []],
    ['quantization', tree.children.quantization ?? []],
    ['adapter', tree.children.adapter ?? []],
  ];
  const hasAny = !!tree.parent || groups.some(([, list]) => list.length > 0);
  if (!hasAny) {
    return <Empty description="This model has no parent and no derivatives yet." />;
  }
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {tree.parent && (
        <Card
          size="small"
          title={<Space><BranchesOutlined /> Parent</Space>}
          hoverable
          onClick={() => onOpen(tree.parent!.id)}
        >
          <Space wrap>
            <strong>{tree.parent.name}</strong>
            <ModelTypeBadge type={tree.parent.modelType} size="small" />
            <span style={{ color: token.colorTextTertiary }} className="mono">{tree.parent.uri}</span>
          </Space>
        </Card>
      )}
      {groups.map(([kind, list]) => (
        list.length > 0 && (
          <Card key={kind} size="small" title={<Space><PartitionOutlined /> {derivedKindLabel[kind]}</Space>}>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {list.map(m => (
                <Card
                  key={m.id}
                  size="small"
                  hoverable
                  onClick={() => onOpen(m.id)}
                  styles={{ body: { padding: 8 } }}
                >
                  <Space wrap>
                    <strong>{m.name}</strong>
                    <ModelTypeBadge type={m.modelType} size="small" />
                    <Tag>{m.sizeGB.toFixed(1)} GiB</Tag>
                    <span style={{ color: token.colorTextTertiary }} className="mono">{m.uri}</span>
                  </Space>
                </Card>
              ))}
            </Space>
          </Card>
        )
      ))}
    </Space>
  );
}
