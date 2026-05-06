import { useEffect, useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App } from 'antd';
import { PlusOutlined, DeleteOutlined, CodeOutlined, EditOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import {
  useRuntimes,
  ensureRuntimesLoaded,
  reloadRuntimes,
  deleteServingRuntime,
  fetchServingRuntimeYaml,
  buildServingRuntimeYaml,
  type ServingRuntime,
} from '@/data/inference';
import { useApp } from '@/context/AppContext';
import { YamlViewer } from '@/components/YamlViewer';
import { NewServingRuntimeModal } from './NewServingRuntimeModal';

export function ServingRuntimesPage() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useRuntimes();
  const data = useMemo(() => all.filter(r => r.namespace === namespace || r.builtin), [all, namespace]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ServingRuntime | null>(null);
  const [yaml, setYaml] = useState<{ sr: ServingRuntime; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);

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
            width: 240,
            render: (_, r) => (
              <Space>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  disabled={r.builtin}
                  onClick={() => openEdit(r)}
                >
                  Edit
                </Button>
                <Button
                  size="small"
                  icon={<CodeOutlined />}
                  loading={yamlLoading === r.name}
                  onClick={() => openYaml(r)}
                >
                  YAML
                </Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={r.builtin}
                  onClick={() =>
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
                    })
                  }
                />
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

      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`ServingRuntime · ${yaml?.sr.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
    </div>
  );
}
