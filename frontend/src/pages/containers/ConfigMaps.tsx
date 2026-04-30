import { useEffect, useMemo, useState } from 'react';
import { Table, Space, Button, App, Tag } from 'antd';
import { CodeOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { YamlViewer } from '@/components/YamlViewer';
import {
  buildConfigMapYaml,
  deleteClusterResource,
  ensureConfigMapsLoaded,
  fetchClusterResourceYaml,
  useConfigMaps,
} from '@/data/clusterResources';
import { useApp } from '@/context/AppContext';

export function ConfigMaps() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useConfigMaps();
  const data = useMemo(() => all.filter(c => c.namespace === namespace), [all, namespace]);
  const [yaml, setYaml] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    ensureConfigMapsLoaded(namespace);
  }, [namespace]);

  async function showYaml(r: (typeof data)[number]) {
    const fallback = buildConfigMapYaml(r);
    try {
      const body = await fetchClusterResourceYaml('configmaps', r.namespace, r.name, fallback);
      setYaml({ title: `ConfigMap · ${r.name}`, body });
    } catch (err) {
      setYaml({ title: `ConfigMap · ${r.name}`, body: fallback });
      message.error(err instanceof Error ? err.message : 'Failed to fetch YAML');
    }
  }

  return (
    <div className="knaic-page">
      <PageHeader title="ConfigMaps" description={`ConfigMaps in namespace ${namespace}`} />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        expandable={{
          expandedRowRender: r => (
            <div style={{ padding: '6px 0' }}>
              {Object.entries(r.data).map(([k, v]) => (
                <div key={k} style={{ marginBottom: 8 }}>
                  <div className="knaic-sub mono">{k}</div>
                  <pre className="log-viewer" style={{ margin: 0, maxHeight: 160 }}>{v}</pre>
                </div>
              ))}
            </div>
          ),
        }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'Keys', render: (_, r) => <Space wrap size={4}>{Object.keys(r.data).map(k => <Tag key={k}>{k}</Tag>)}</Space> },
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
                      title: `Delete ConfigMap ${r.name}?`,
                      onOk: async () => {
                        try {
                          await deleteClusterResource('configmaps', r.namespace, r.name);
                          message.success('Deleted');
                        } catch (err) {
                          message.error(err instanceof Error ? err.message : 'Failed to delete ConfigMap');
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
    </div>
  );
}
