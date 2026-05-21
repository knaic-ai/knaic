import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Result,
  Space,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import {
  CodeOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { YamlViewer } from '@/components/YamlViewer';
import { YamlEditor } from '@/components/YamlEditor';
import { fetchYaml, updateClusterYaml } from '@/api/k8sres';
import { useApp } from '@/context/AppContext';
import {
  deleteLocalModelCache,
  deleteLocalModelNodeGroup,
  ensureLocalModelLoaded,
  reloadLocalModel,
  useLocalModelCaches,
  useLocalModelNodeGroups,
  useLocalModelStatus,
} from '@/data/localModelCache';
import type {
  LocalModelCache as Cache,
  LocalModelNodeGroup as NodeGroup,
} from '@/api/localModelCache';
import { NewLocalModelCacheModal } from './NewLocalModelCacheModal';
import { NewLocalModelNodeGroupModal } from './NewLocalModelNodeGroupModal';

type YamlTarget =
  | { kind: 'cache'; name: string; text: string }
  | { kind: 'nodegroup'; name: string; text: string };

export function LocalModelCachePage() {
  const { user } = useApp();
  const { message, modal } = App.useApp();
  const status = useLocalModelStatus();
  const caches = useLocalModelCaches();
  const nodeGroups = useLocalModelNodeGroups();

  const [cacheModalOpen, setCacheModalOpen] = useState(false);
  const [nodeGroupModalOpen, setNodeGroupModalOpen] = useState(false);

  const [yamlView, setYamlView] = useState<YamlTarget | null>(null);
  const [yamlEdit, setYamlEdit] = useState<YamlTarget | null>(null);
  const [yamlSaving, setYamlSaving] = useState(false);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);

  useEffect(() => {
    ensureLocalModelLoaded();
  }, []);

  const canWrite = user.isPlatformAdmin;

  const openView = async (kind: YamlTarget['kind'], name: string) => {
    const slug = kind === 'cache' ? 'localmodelcaches' : 'localmodelnodegroups';
    setYamlLoading(name);
    try {
      const text = await fetchYaml(slug, null, name);
      setYamlView({ kind, name, text });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setYamlLoading(null);
    }
  };

  const openEdit = async (kind: YamlTarget['kind'], name: string) => {
    const slug = kind === 'cache' ? 'localmodelcaches' : 'localmodelnodegroups';
    setYamlLoading(name);
    try {
      const text = await fetchYaml(slug, null, name);
      setYamlEdit({ kind, name, text });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setYamlLoading(null);
    }
  };

  const saveEdit = async () => {
    if (!yamlEdit) return;
    setYamlSaving(true);
    try {
      const slug = yamlEdit.kind === 'cache' ? 'localmodelcaches' : 'localmodelnodegroups';
      await updateClusterYaml(slug, yamlEdit.name, yamlEdit.text);
      await reloadLocalModel();
      message.success('YAML updated');
      setYamlEdit(null);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setYamlSaving(false);
    }
  };

  const confirmDeleteCache = (name: string) => {
    modal.confirm({
      title: `Delete LocalModelCache ${name}?`,
      icon: <ExclamationCircleOutlined />,
      onOk: async () => {
        try {
          await deleteLocalModelCache(name);
          message.success('LocalModelCache deleted');
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  const confirmDeleteNodeGroup = (name: string) => {
    modal.confirm({
      title: `Delete LocalModelNodeGroup ${name}?`,
      icon: <ExclamationCircleOutlined />,
      content: 'Caches that reference this node group will stop pre-downloading new copies.',
      onOk: async () => {
        try {
          await deleteLocalModelNodeGroup(name);
          message.success('LocalModelNodeGroup deleted');
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  if (!status.installed) {
    return (
      <div className="knaic-page">
        <PageHeader
          title="Local Model Cache"
          description="Pre-download models onto cluster nodes so InferenceServices can warm-start from local disk."
        />
        <Result
          status="info"
          title="KServe local model cache agent is not installed"
          subTitle={
            <Space direction="vertical" size={4} style={{ alignItems: 'center' }}>
              <span>
                Deploy the <code className="mono">kserve-localmodelnode-agent</code> DaemonSet in the{' '}
                <code className="mono">kserve</code> namespace to enable LocalModelCache / LocalModelNodeGroup.
              </span>
              <a
                href="https://kserve.github.io/website/docs/model-serving/generative-inference/modelcache/localmodel"
                target="_blank"
                rel="noreferrer"
              >
                KServe local model cache install guide
              </a>
            </Space>
          }
          extra={
            <Button icon={<ReloadOutlined />} onClick={() => reloadLocalModel()}>
              Re-check
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="Local Model Cache"
        description="Manage KServe LocalModelCache and LocalModelNodeGroup resources. Caches pre-download models onto the nodes selected by their NodeGroup."
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => reloadLocalModel()}>Refresh</Button>
            {!canWrite && <Tag color="default">read-only</Tag>}
          </Space>
        }
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <Descriptions size="small" column={3} colon>
            <Descriptions.Item label="Agent DaemonSet">
              <span className="mono">{status.namespace}/{status.name}</span>
            </Descriptions.Item>
            <Descriptions.Item label="Host path">
              <span className="mono">{status.hostPath || '(not set)'}</span>
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color="green">running</Tag>
            </Descriptions.Item>
          </Descriptions>
        }
      />

      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title="Local model caches"
        extra={
          canWrite && (
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setCacheModalOpen(true)}
            >
              New cache
            </Button>
          )
        }
      >
        <Table<Cache>
          rowKey={r => r.name}
          size="middle"
          dataSource={caches}
          locale={{ emptyText: <Empty description="No caches yet" /> }}
          expandable={{
            rowExpandable: r => (r.nodeStatus?.length ?? 0) > 0 || (r.inferenceServices?.length ?? 0) > 0,
            expandedRowRender: r => (
              <Space direction="vertical" style={{ width: '100%' }}>
                {r.nodeStatus && r.nodeStatus.length > 0 && (
                  <Table
                    size="small"
                    rowKey="node"
                    pagination={false}
                    dataSource={r.nodeStatus}
                    columns={[
                      { title: 'Node', dataIndex: 'node', render: v => <span className="mono">{v}</span> },
                      {
                        title: 'State',
                        dataIndex: 'state',
                        render: v => (
                          <Tag color={v === 'NodeDownloaded' ? 'green' : v === 'NodeNotReady' ? 'red' : 'blue'}>
                            {v || 'unknown'}
                          </Tag>
                        ),
                      },
                    ]}
                  />
                )}
                {r.inferenceServices && r.inferenceServices.length > 0 && (
                  <Space size={4} wrap>
                    <span className="knaic-sub">Used by:</span>
                    {r.inferenceServices.map(ref => (
                      <Tag key={`${ref.namespace}/${ref.name}`} color="blue">
                        {ref.namespace}/{ref.name}
                      </Tag>
                    ))}
                  </Space>
                )}
              </Space>
            ),
          }}
          columns={[
            { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
            {
              title: 'Source model URI',
              dataIndex: 'sourceModelUri',
              render: v => <span className="mono">{v}</span>,
            },
            { title: 'Size', dataIndex: 'modelSize', width: 100 },
            {
              title: 'Node groups',
              dataIndex: 'nodeGroups',
              render: (v: string[] | null) =>
                v?.length
                  ? v.map(n => <Tag key={n}>{n}</Tag>)
                  : <span className="knaic-sub">—</span>,
            },
            {
              title: 'Copies',
              width: 110,
              render: (_, r) => `${r.copiesAvailable}/${r.copiesTotal || '—'}`,
            },
            { title: 'Age', dataIndex: 'age', width: 80 },
            {
              title: 'Actions',
              width: 200,
              render: (_, r) => (
                <Space>
                  <Button
                    size="small"
                    icon={<CodeOutlined />}
                    loading={yamlLoading === r.name}
                    onClick={() => openView('cache', r.name)}
                  >
                    YAML
                  </Button>
                  {canWrite && (
                    <>
                      <Button
                        size="small"
                        onClick={() => openEdit('cache', r.name)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => confirmDeleteCache(r.name)}
                      />
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        size="small"
        title="Local model node groups"
        extra={
          canWrite && (
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setNodeGroupModalOpen(true)}
            >
              New node group
            </Button>
          )
        }
      >
        <Table<NodeGroup>
          rowKey={r => r.name}
          size="middle"
          dataSource={nodeGroups}
          locale={{ emptyText: <Empty description="No node groups yet" /> }}
          columns={[
            { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
            { title: 'Storage limit', dataIndex: 'storageLimit', width: 130 },
            {
              title: 'Host path',
              dataIndex: 'hostPath',
              render: (v: string) => {
                const mismatch = !!status.hostPath && !!v && v !== status.hostPath;
                return (
                  <Space size={4}>
                    <span className="mono">{v || '—'}</span>
                    {mismatch && (
                      <Tooltip title={`Differs from agent hostPath (${status.hostPath})`}>
                        <ExclamationCircleOutlined style={{ color: '#faad14' }} />
                      </Tooltip>
                    )}
                  </Space>
                );
              },
            },
            { title: 'Storage class', dataIndex: 'storageClassName', width: 150 },
            {
              title: 'Node selector',
              render: (_, r) => {
                if (!r.selectorKey) return <span className="knaic-sub">—</span>;
                const vals = r.selectorValues?.join(', ') || '?';
                return (
                  <span className="mono" style={{ fontSize: 12 }}>
                    {r.selectorKey} {r.selectorOp || 'In'} [{vals}]
                  </span>
                );
              },
            },
            {
              title: 'Used / Available',
              width: 160,
              render: (_, r) => `${r.used || '—'} / ${r.available || '—'}`,
            },
            { title: 'Age', dataIndex: 'age', width: 80 },
            {
              title: 'Actions',
              width: 200,
              render: (_, r) => (
                <Space>
                  <Button
                    size="small"
                    icon={<CodeOutlined />}
                    loading={yamlLoading === r.name}
                    onClick={() => openView('nodegroup', r.name)}
                  >
                    YAML
                  </Button>
                  {canWrite && (
                    <>
                      <Button
                        size="small"
                        onClick={() => openEdit('nodegroup', r.name)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => confirmDeleteNodeGroup(r.name)}
                      />
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <NewLocalModelCacheModal
        open={cacheModalOpen}
        onClose={() => setCacheModalOpen(false)}
      />
      <NewLocalModelNodeGroupModal
        open={nodeGroupModalOpen}
        onClose={() => setNodeGroupModalOpen(false)}
      />

      <YamlViewer
        open={!!yamlView}
        onClose={() => setYamlView(null)}
        title={
          yamlView
            ? `${yamlView.kind === 'cache' ? 'LocalModelCache' : 'LocalModelNodeGroup'} · ${yamlView.name}`
            : ''
        }
        yaml={yamlView?.text ?? ''}
      />
      <YamlEditor
        open={!!yamlEdit}
        onClose={() => setYamlEdit(null)}
        title={
          yamlEdit
            ? `Edit YAML · ${yamlEdit.kind === 'cache' ? 'LocalModelCache' : 'LocalModelNodeGroup'} · ${yamlEdit.name}`
            : ''
        }
        value={yamlEdit?.text ?? ''}
        saving={yamlSaving}
        onChange={text => setYamlEdit(cur => (cur ? { ...cur, text } : cur))}
        onSave={saveEdit}
      />
    </div>
  );
}
