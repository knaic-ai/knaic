import { useEffect } from 'react';
import { Card, Row, Col, Form, Input, Switch, Button, Progress, Space, Table, Tag, App } from 'antd';
import { CloudSyncOutlined, SaveOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import {
  useRegistry,
  updateRegistry,
  syncAllImages,
  useComponents,
  ensureRegistryLoaded,
  ensureInitialLoad,
} from '@/data/components';

export function RegistryPage() {
  const registry = useRegistry();
  const components = useComponents();
  const { message } = App.useApp();
  const [form] = Form.useForm();

  useEffect(() => {
    ensureInitialLoad();
    ensureRegistryLoaded();
  }, []);

  const syncPct = Math.round((registry.syncedImages / registry.totalImages) * 100);
  const diskPct = Math.round((registry.diskUsageGi / registry.capacityGi) * 100);

  const imageRows = components.flatMap(c =>
    c.images.map(i => ({
      key: `${c.name}:${i}`,
      component: c.displayName,
      image: i,
      status: c.imageSync,
    })),
  );

  return (
    <div className="knaic-page">
      <PageHeader
        title="Admin · Image registry"
        description="The built-in registry stores images for all bundled knaic components. Platform admins can switch to an external registry and sync images on demand."
      />
      <Row gutter={12}>
        <Col span={12}>
          <Card title="Registry configuration" size="small">
            <Form
              form={form}
              layout="vertical"
              initialValues={registry}
              onFinish={async v => {
                try {
                  await updateRegistry(v);
                  message.success('Registry config saved');
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              <Form.Item name="useBuiltin" label="Use built-in registry" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="endpoint" label="Endpoint" rules={[{ required: true }]}>
                <Input placeholder="registry.knaic.local" />
              </Form.Item>
              <Form.Item name="project" label="Project / repository">
                <Input placeholder="components" />
              </Form.Item>
              <Form.Item name="username" label="Pull-secret username">
                <Input />
              </Form.Item>
              <Space>
                <Button type="primary" icon={<SaveOutlined />} htmlType="submit">Save</Button>
                <Button
                  icon={<CloudSyncOutlined />}
                  onClick={async () => {
                    try {
                      await syncAllImages();
                      message.success('Sync triggered');
                    } catch (e) {
                      message.error((e as Error).message);
                    }
                  }}
                >
                  Sync all images now
                </Button>
              </Space>
            </Form>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Capacity" size="small">
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <div>
                <div className="knaic-sub">Images synced</div>
                <Progress percent={syncPct} />
                <span className="knaic-sub">{registry.syncedImages} of {registry.totalImages} images</span>
              </div>
              <div>
                <div className="knaic-sub">Disk usage</div>
                <Progress
                  percent={diskPct}
                  status={diskPct > 85 ? 'exception' : diskPct > 70 ? 'active' : 'normal'}
                />
                <span className="knaic-sub">{registry.diskUsageGi} GiB used of {registry.capacityGi} GiB</span>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>
      <Card title="Images in registry" size="small" style={{ marginTop: 12 }}>
        <Table
          rowKey="key"
          size="small"
          dataSource={imageRows}
          columns={[
            { title: 'Component', dataIndex: 'component' },
            { title: 'Image', dataIndex: 'image', render: v => <span className="mono">{v}</span> },
            {
              title: 'Status',
              dataIndex: 'status',
              render: v => (
                <Tag color={v === 'Synced' ? 'green' : v === 'Pending' ? 'gold' : 'red'}>{v}</Tag>
              ),
            },
          ]}
          pagination={{ pageSize: 15 }}
        />
      </Card>
    </div>
  );
}
