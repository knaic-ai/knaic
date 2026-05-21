import { useEffect, useMemo, useState } from 'react';
import { Table, Space, Button, App, Tag } from 'antd';
import { CodeOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { YamlViewer } from '@/components/YamlViewer';
import { YamlEditor } from '@/components/YamlEditor';
import {
  buildSecretYaml,
  createClusterResource,
  deleteClusterResource,
  ensureSecretsLoaded,
  fetchClusterResourceYaml,
  secretTemplate,
  useSecrets,
  type Secret,
} from '@/data/clusterResources';
import { useApp } from '@/context/AppContext';

const typeColor: Record<Secret['type'], string> = {
  'Opaque': 'default',
  'kubernetes.io/tls': 'gold',
  'kubernetes.io/dockerconfigjson': 'purple',
  'kubernetes.io/service-account-token': 'blue',
};

export function Secrets() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useSecrets();
  const data = useMemo(() => all.filter(s => s.namespace === namespace), [all, namespace]);
  const [yaml, setYaml] = useState<{ title: string; body: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createYaml, setCreateYaml] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    ensureSecretsLoaded(namespace);
  }, [namespace]);

  async function showYaml(r: (typeof data)[number]) {
    const fallback = buildSecretYaml(r);
    try {
      const body = await fetchClusterResourceYaml('secrets', r.namespace, r.name, fallback);
      setYaml({ title: `Secret · ${r.name}`, body });
    } catch (err) {
      setYaml({ title: `Secret · ${r.name}`, body: fallback });
      message.error(err instanceof Error ? err.message : 'Failed to fetch YAML');
    }
  }

  function openCreate() {
    setCreateYaml(secretTemplate(namespace));
    setCreateOpen(true);
  }

  async function submitCreate() {
    setCreating(true);
    try {
      await createClusterResource('secrets', namespace, createYaml);
      setCreateOpen(false);
      message.success('Secret created');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to create Secret');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="Secrets"
        description={`Secret values are never shown — only keys and types. In namespace ${namespace}.`}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New Secret
          </Button>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'Type', dataIndex: 'type', render: v => <Tag color={typeColor[v as Secret['type']]}>{v}</Tag> },
          {
            title: 'Keys',
            render: (_, r) => <Space wrap size={4}>{r.keys.map(k => <Tag key={k}>{k}</Tag>)}</Space>,
          },
          { title: 'Created', dataIndex: 'createdAt' },
          {
            title: 'Actions',
            width: 140,
            render: (_, r) => (
              <Space>
                <Button size="small" icon={<CodeOutlined />} onClick={() => void showYaml(r)}>YAML</Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete Secret ${r.name}?`,
                      content: 'Workloads referencing this secret will start failing.',
                      onOk: async () => {
                        try {
                          await deleteClusterResource('secrets', r.namespace, r.name);
                          message.success('Deleted');
                        } catch (err) {
                          message.error(err instanceof Error ? err.message : 'Failed to delete Secret');
                          throw err;
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
      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={yaml?.title ?? ''}
        yaml={yaml?.body ?? ''}
      />
      <YamlEditor
        open={createOpen}
        title={`New Secret in ${namespace}`}
        value={createYaml}
        saving={creating}
        onChange={setCreateYaml}
        onSave={() => void submitCreate()}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
