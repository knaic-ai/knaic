import { useEffect, useMemo, useState } from 'react';
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
  createNamespacedYaml,
  deleteNamespaced,
  fetchYaml,
  listNamespaced,
  updateNamespacedYaml,
} from '@/api/k8sres';
import { useApp } from '@/context/AppContext';

interface LLMConfigRow {
  id: string;
  name: string;
  namespace: string;
  image: string;
  hasRouter: boolean;
  hasWorker: boolean;
  hasPrefill: boolean;
}

const TEMPLATE_YAML = (ns: string) => `apiVersion: serving.kserve.io/v1alpha2
kind: LLMInferenceServiceConfig
metadata:
  name: my-llm-config
  namespace: ${ns}
spec:
  template:
    containers:
      - name: main
        image: vllm/vllm-openai:v0.7.2
        command: [vllm, serve, /mnt/models]
        args:
          - --served-model-name
          - "{{ .Spec.Model.Name }}"
          - --port
          - "8000"
        ports:
          - containerPort: 8000
            protocol: TCP
`;

export function LLMConfigsPage() {
  const { namespace, user } = useApp();
  const { message, modal } = App.useApp();
  // Same gate as the cluster-scoped sibling page — backend requires
  // platform-admin for create/update/delete on the generic dispatcher.
  const canWrite = user.isPlatformAdmin;
  const [rows, setRows] = useState<LLMConfigRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<{ ns: string; name: string; text: string } | null>(null);
  const [editing, setEditing] = useState<{ ns: string; name: string | null; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const data = await listNamespaced<LLMConfigRow>('llminferenceserviceconfigs', namespace);
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
  }, [namespace]);

  const filtered = useMemo(() => rows, [rows]);

  const openYaml = async (r: LLMConfigRow) => {
    try {
      const text = await fetchYaml('llminferenceserviceconfigs', r.namespace, r.name);
      setView({ ns: r.namespace, name: r.name, text });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const openEdit = async (r: LLMConfigRow) => {
    try {
      const text = await fetchYaml('llminferenceserviceconfigs', r.namespace, r.name);
      setEditing({ ns: r.namespace, name: r.name, text });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const openCreate = () => setEditing({ ns: namespace, name: null, text: TEMPLATE_YAML(namespace) });

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      if (editing.name) {
        await updateNamespacedYaml('llminferenceserviceconfigs', editing.ns, editing.name, editing.text);
        message.success('Saved');
      } else {
        await createNamespacedYaml('llminferenceserviceconfigs', editing.ns, editing.text);
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
        title="LLM Inference Configs"
        description={`LLMInferenceServiceConfig resources merged into LLMInferenceServices via spec.baseRefs[]. Showing namespace ${namespace} — KServe ships its built-in configs in the kserve namespace.`}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()}>Refresh</Button>
            {canWrite && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                New LLM config
              </Button>
            )}
          </Space>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={filtered}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'Namespace', dataIndex: 'namespace' },
          {
            title: 'Image',
            dataIndex: 'image',
            render: v => <span className="mono" style={{ fontSize: 12 }}>{v || '—'}</span>,
          },
          {
            title: 'Includes',
            render: (_, r) => (
              <Space wrap size={4}>
                {r.hasRouter && <Tag color="cyan">router</Tag>}
                {r.hasWorker && <Tag color="geekblue">worker</Tag>}
                {r.hasPrefill && <Tag color="purple">prefill</Tag>}
                {!r.hasRouter && !r.hasWorker && !r.hasPrefill && <span className="knaic-sub">—</span>}
              </Space>
            ),
          },
          {
            title: 'Actions',
            width: canWrite ? 240 : 100,
            render: (_, r) => (
              <Space>
                <Button size="small" icon={<CodeOutlined />} onClick={() => void openYaml(r)}>YAML</Button>
                {canWrite && (
                  <>
                    <Button size="small" icon={<EditOutlined />} onClick={() => void openEdit(r)}>Edit</Button>
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() =>
                        modal.confirm({
                          title: `Delete LLM config ${r.name}?`,
                          content: 'Existing LLMInferenceServices that reference this config via baseRefs will lose those defaults.',
                          onOk: async () => {
                            try {
                              await deleteNamespaced('llminferenceserviceconfigs', r.namespace, r.name);
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
        title={`LLMInferenceServiceConfig · ${view?.ns ?? ''}/${view?.name ?? ''}`}
        yaml={view?.text ?? ''}
        onClose={() => setView(null)}
      />
      <YamlEditor
        open={!!editing}
        title={editing?.name ? `Edit · ${editing.ns}/${editing.name}` : `New LLMInferenceServiceConfig in ${editing?.ns ?? namespace}`}
        value={editing?.text ?? ''}
        saving={saving}
        onChange={text => setEditing(prev => (prev ? { ...prev, text } : prev))}
        onSave={() => void save()}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
