import { useMemo, useState } from 'react';
import { Table, Space, Button, App, Tag } from 'antd';
import { CodeOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { YamlViewer } from '@/components/YamlViewer';
import {
  useConfigMaps,
  configMapsStore,
  buildConfigMapYaml,
  type ConfigMap,
} from '@/data/clusterResources';
import { useApp } from '@/context/AppContext';

export function ConfigMaps() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useConfigMaps();
  const data = useMemo(() => all.filter(c => c.namespace === namespace), [all, namespace]);
  const [yaml, setYaml] = useState<ConfigMap | null>(null);

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
                <Button size="small" icon={<CodeOutlined />} onClick={() => setYaml(r)}>YAML</Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete ConfigMap ${r.name}?`,
                      onOk: () => {
                        configMapsStore.set(prev => prev.filter(c => c.id !== r.id));
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
        title={`ConfigMap · ${yaml?.name ?? ''}`}
        yaml={yaml ? buildConfigMapYaml(yaml) : ''}
      />
    </div>
  );
}
