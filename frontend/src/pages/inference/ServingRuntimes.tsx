import { useEffect, useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App, Dropdown } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  CodeOutlined,
  EditOutlined,
  MoreOutlined,
  ImportOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import {
  useRuntimes,
  ensureRuntimesLoaded,
  reloadRuntimes,
  deleteServingRuntime,
  fetchServingRuntimeYaml,
  buildServingRuntimeYaml,
  updateServingRuntimeYaml,
  type ServingRuntime,
} from '@/data/inference';
import { useApp } from '@/context/AppContext';
import { YamlViewer } from '@/components/YamlViewer';
import { YamlEditor } from '@/components/YamlEditor';
import { NewServingRuntimeModal } from './NewServingRuntimeModal';
import { ImportClusterRuntimeModal } from './ImportClusterRuntimeModal';

export function ServingRuntimesPage() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useRuntimes();
  const data = useMemo(() => all.filter(r => r.namespace === namespace || r.builtin), [all, namespace]);
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<ServingRuntime | null>(null);
  const [yaml, setYaml] = useState<{ sr: ServingRuntime; text: string } | null>(null);
  const [yamlEdit, setYamlEdit] = useState<{ sr: ServingRuntime; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);
  const [yamlSaving, setYamlSaving] = useState(false);

  useEffect(() => {
    ensureRuntimesLoaded(namespace);
  }, [namespace]);

  const openYaml = async (sr: ServingRuntime) => {
    setYamlLoading(sr.name);
    try {
      const text = sr.builtin
        ? buildServingRuntimeYaml(sr)
        : await fetchServingRuntimeYaml(namespace, sr.name);
      setYaml({ sr, text: text || buildServingRuntimeYaml(sr) });
    } catch (e) {
      setYaml({ sr, text: buildServingRuntimeYaml(sr) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  const openEditYaml = async (sr: ServingRuntime) => {
    setYamlLoading(sr.name);
    try {
      const text = sr.builtin
        ? buildServingRuntimeYaml(sr)
        : await fetchServingRuntimeYaml(namespace, sr.name);
      setYamlEdit({ sr, text: text || buildServingRuntimeYaml(sr) });
    } catch (e) {
      setYamlEdit({ sr, text: buildServingRuntimeYaml(sr) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  const saveYaml = async () => {
    if (!yamlEdit) return;
    setYamlSaving(true);
    try {
      await updateServingRuntimeYaml(namespace, yamlEdit.sr.name, yamlEdit.text);
      message.success('Runtime YAML updated');
      setYamlEdit(null);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setYamlSaving(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (r: ServingRuntime) => {
    setEditing(r);
    setModalOpen(true);
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="Serving runtimes"
        description="KServe ServingRuntimes configurable via UI. Built-in runtimes (vllm, sglang) are bundled by knaic and cloned into each namespace on demand."
        extra={
          <Space>
            <Button onClick={() => reloadRuntimes(namespace)}>Refresh</Button>
            <Button
              icon={<ImportOutlined />}
              onClick={() => setImportOpen(true)}
            >
              Import from ClusterServingRuntime
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New runtime
            </Button>
          </Space>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          {
            title: 'Name',
            render: (_, r) => (
              <Space>
                <b>{r.name}</b>
                {r.builtin && <Tag color="gold">built-in</Tag>}
              </Space>
            ),
          },
          { title: 'Runtime', dataIndex: 'runtime', render: v => <Tag color="blue">{v}</Tag> },
          { title: 'Image', dataIndex: 'image', render: v => <span className="mono">{v}</span> },
          {
            title: 'Default resources',
            render: (_, r) => {
              const cpuMem = `${r.resources.cpu || '—'} CPU · ${r.resources.memory || '—'}`;
              if (r.gpuValues && Object.keys(r.gpuValues).length > 0) {
                return (
                  <Space direction="vertical" size={0}>
                    <span>{cpuMem}</span>
                    {Object.entries(r.gpuValues).map(([k, v]) => (
                      <span key={k} className="mono" style={{ fontSize: 12 }}>
                        {k.split('/').pop()}={v}
                      </span>
                    ))}
                  </Space>
                );
              }
              return `${cpuMem} · ${r.resources.gpu > 0 ? `${r.resources.gpu} GPU` : 'no GPU'}`;
            },
          },
          {
            title: 'Formats',
            dataIndex: 'supportedModelFormats',
            render: (v: string[]) => v?.map(f => <Tag key={f}>{f}</Tag>),
          },
          {
            title: 'Actions',
            width: 170,
            render: (_, r) => (
              <Space>
                <Button
                  size="small"
                  icon={<CodeOutlined />}
                  loading={yamlLoading === r.name}
                  onClick={() => openYaml(r)}
                >
                  YAML
                </Button>
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      { key: 'edit', label: 'Edit', icon: <EditOutlined />, disabled: r.builtin },
                      { key: 'edit-yaml', label: 'Edit YAML', icon: <EditOutlined />, disabled: r.builtin },
                      { key: 'delete', label: 'Delete', icon: <DeleteOutlined />, danger: true, disabled: r.builtin },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'edit') {
                        openEdit(r);
                      } else if (key === 'edit-yaml') {
                        openEditYaml(r);
                      } else if (key === 'delete') {
                        modal.confirm({
                          title: `Delete runtime ${r.name}?`,
                          onOk: async () => {
                            try {
                              await deleteServingRuntime(namespace, r.name);
                              message.success('Runtime deleted');
                            } catch (e) {
                              message.error((e as Error).message);
                            }
                          },
                        });
                      }
                    },
                  }}
                >
                  <Button
                    size="small"
                    icon={<MoreOutlined />}
                    loading={yamlLoading === r.name}
                    aria-label="More actions"
                  />
                </Dropdown>
              </Space>
            ),
          },
        ]}
      />

      <NewServingRuntimeModal
        open={modalOpen}
        namespace={namespace}
        editing={editing}
        onClose={() => setModalOpen(false)}
      />

      <ImportClusterRuntimeModal
        open={importOpen}
        namespace={namespace}
        onClose={() => setImportOpen(false)}
      />

      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`ServingRuntime · ${yaml?.sr.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
      <YamlEditor
        open={!!yamlEdit}
        onClose={() => setYamlEdit(null)}
        title={`Edit YAML · ServingRuntime · ${yamlEdit?.sr.name ?? ''}`}
        value={yamlEdit?.text ?? ''}
        saving={yamlSaving}
        onChange={text => setYamlEdit(cur => (cur ? { ...cur, text } : cur))}
        onSave={saveYaml}
      />
    </div>
  );
}
