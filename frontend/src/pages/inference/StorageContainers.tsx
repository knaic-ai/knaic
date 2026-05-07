import { useEffect, useState } from 'react';
import { App, Button, Space, Table, Tag } from 'antd';
import {
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { YamlEditor } from '@/components/YamlEditor';
import { YamlViewer } from '@/components/YamlViewer';
import {
  createClusterYaml,
  deleteCluster,
  fetchYaml,
  listCluster,
  updateClusterYaml,
} from '@/api/k8sres';
import { useApp } from '@/context/AppContext';

interface StorageContainerRow {
  id: string;
  name: string;
  image: string;
  workloadType: string;
  supportedUriFormats: string[];
  supportsMultiModelDownload: boolean;
}

const TEMPLATE_YAML = `apiVersion: serving.kserve.io/v1alpha1
kind: ClusterStorageContainer
metadata:
  name: my-storage
spec:
  container:
    name: storage-initializer
    image: kserve/storage-initializer:v0.14.0
    resources:
      requests:
        cpu: "100m"
        memory: 100Mi
      limits:
        cpu: "1"
        memory: 1Gi
  supportedUriFormats:
    - prefix: s3://
`;

export function StorageContainersPage() {
  const { user } = useApp();
  const { message, modal } = App.useApp();
  // ClusterStorageContainer is a cluster-scoped CR; the backend gates every
  // mutation behind RequirePlatformAdmin (internal/api/k8sres.go), so non-
  // admin users would just hit 403. Hide the write controls instead.
  const canWrite = user.isPlatformAdmin;
  const [rows, setRows] = useState<StorageContainerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<{ name: string; text: string } | null>(null);
  const [editing, setEditing] = useState<{ name: string | null; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const data = await listCluster<StorageContainerRow>('clusterstoragecontainers');
      setRows(data);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openYaml = async (name: string) => {
    try {
      const text = await fetchYaml('clusterstoragecontainers', null, name);
      setView({ name, text });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const openEdit = async (name: string) => {
    try {
      const text = await fetchYaml('clusterstoragecontainers', null, name);
      setEditing({ name, text });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const openCreate = () => setEditing({ name: null, text: TEMPLATE_YAML });

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      if (editing.name) {
        await updateClusterYaml('clusterstoragecontainers', editing.name, editing.text);
        message.success('Saved');
      } else {
        await createClusterYaml('clusterstoragecontainers', editing.text);
        message.success('Created');
      }
      setEditing(null);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="Storage Initializers"
        description="ClusterStorageContainer resources tell KServe how to download model artifacts from each URI scheme (s3://, hf://, hf-mirror://, oci://, …). Cluster-scoped."
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()}>Refresh</Button>
            {canWrite && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                New storage initializer
              </Button>
            )}
          </Space>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={rows}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          {
            title: 'Image',
            dataIndex: 'image',
            render: v => <span className="mono" style={{ fontSize: 12 }}>{v || '—'}</span>,
          },
          {
            title: 'Supported URI formats',
            dataIndex: 'supportedUriFormats',
            render: (v?: string[]) => (
              <Space wrap size={4}>
                {(v ?? []).map(p => <Tag key={p} className="mono">{p}</Tag>)}
              </Space>
            ),
          },
          { title: 'Workload', dataIndex: 'workloadType', render: v => v || '—' },
          {
            title: 'Multi-model',
            dataIndex: 'supportsMultiModelDownload',
            width: 110,
            render: v => v ? <Tag color="green">yes</Tag> : <Tag>no</Tag>,
          },
          {
            title: 'Actions',
            width: canWrite ? 240 : 100,
            render: (_, r) => (
              <Space>
                <Button size="small" icon={<CodeOutlined />} onClick={() => void openYaml(r.name)}>YAML</Button>
                {canWrite && (
                  <>
                    <Button size="small" icon={<EditOutlined />} onClick={() => void openEdit(r.name)}>Edit</Button>
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() =>
                        modal.confirm({
                          title: `Delete storage initializer ${r.name}?`,
                          onOk: async () => {
                            try {
                              await deleteCluster('clusterstoragecontainers', r.name);
                              message.success('Deleted');
                              await reload();
                            } catch (e) {
                              message.error((e as Error).message);
                            }
                          },
                        })
                      }
                    />
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />

      <YamlViewer
        open={!!view}
        title={`ClusterStorageContainer · ${view?.name ?? ''}`}
        yaml={view?.text ?? ''}
        onClose={() => setView(null)}
      />
      <YamlEditor
        open={!!editing}
        title={editing?.name ? `Edit · ${editing.name}` : 'New ClusterStorageContainer'}
        value={editing?.text ?? ''}
        saving={saving}
        onChange={text => setEditing(prev => (prev ? { ...prev, text } : prev))}
        onSave={() => void save()}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
