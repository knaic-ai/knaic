import { useEffect, useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App } from 'antd';
import { CodeOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { YamlViewer } from '@/components/YamlViewer';
import {
  buildServiceYaml,
  deleteClusterResource,
  ensureServicesLoaded,
  fetchClusterResourceYaml,
  useK8sServices,
} from '@/data/clusterResources';
import { useApp } from '@/context/AppContext';

export function Services() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useK8sServices();
  const data = useMemo(() => all.filter(s => s.namespace === namespace), [all, namespace]);
  const [yaml, setYaml] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    ensureServicesLoaded(namespace);
  }, [namespace]);

  async function showYaml(r: (typeof data)[number]) {
    const fallback = buildServiceYaml(r);
    try {
      const body = await fetchClusterResourceYaml('services', r.namespace, r.name, fallback);
      setYaml({ title: `Service · ${r.name}`, body });
    } catch (err) {
      setYaml({ title: `Service · ${r.name}`, body: fallback });
      message.error(err instanceof Error ? err.message : 'Failed to fetch YAML');
    }
  }

  return (
    <div className="knaic-page">
      <PageHeader title="Services" description={`Kubernetes Services in namespace ${namespace}`} />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'Type', dataIndex: 'type', render: v => <Tag color={v === 'LoadBalancer' ? 'gold' : v === 'NodePort' ? 'purple' : 'default'}>{v}</Tag> },
          { title: 'ClusterIP', dataIndex: 'clusterIP', render: v => <span className="mono">{v}</span> },
          {
            title: 'Ports',
            render: (_, r) => r.ports.map(p => `${p.port}→${p.targetPort}/${p.protocol}`).join(', '),
          },
          {
            title: 'Selector',
            render: (_, r) => (
              <Space wrap size={4}>
                {Object.entries(r.selector).map(([k, v]) => (
                  <Tag key={k}>{k}={v}</Tag>
                ))}
              </Space>
            ),
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
                      title: `Delete service ${r.name}?`,
                      onOk: async () => {
                        try {
                          await deleteClusterResource('services', r.namespace, r.name);
                          message.success('Deleted');
                        } catch (err) {
                          message.error(err instanceof Error ? err.message : 'Failed to delete service');
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
