import { useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App } from 'antd';
import { CodeOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { YamlViewer } from '@/components/YamlViewer';
import {
  useK8sServices,
  k8sServicesStore,
  buildServiceYaml,
  type K8sService,
} from '@/data/clusterResources';
import { useApp } from '@/context/AppContext';

export function Services() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useK8sServices();
  const data = useMemo(() => all.filter(s => s.namespace === namespace), [all, namespace]);
  const [yaml, setYaml] = useState<K8sService | null>(null);

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
                <Button size="small" icon={<CodeOutlined />} onClick={() => setYaml(r)}>YAML</Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete service ${r.name}?`,
                      onOk: () => {
                        k8sServicesStore.set(prev => prev.filter(s => s.id !== r.id));
                        message.success('Deleted');
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
        title={`Service · ${yaml?.name ?? ''}`}
        yaml={yaml ? buildServiceYaml(yaml) : ''}
      />
    </div>
  );
}
