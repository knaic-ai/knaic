import { useEffect, useState } from 'react';
import { Table, Tag, Space, Button, Modal, Form, Input, Select, App } from 'antd';
import { EditOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { ensureNodesLoaded, useNodes, updateNode, type NodeInfo, type Taint } from '@/data/nodes';

export function NodesPage() {
  const data = useNodes();
  const { message } = App.useApp();
  const [labelTarget, setLabelTarget] = useState<NodeInfo | null>(null);
  const [taintTarget, setTaintTarget] = useState<NodeInfo | null>(null);
  const [labelForm] = Form.useForm();
  const [taintForm] = Form.useForm();

  useEffect(() => {
    ensureNodesLoaded();
  }, []);

  return (
    <div className="knaic-page">
      <PageHeader
        title="Admin · Nodes"
        description="Worker nodes registered in this Kubernetes cluster. Edit labels and taints to steer scheduling."
      />
      <Table
        rowKey="name"
        size="middle"
        dataSource={data}
        pagination={false}
        expandable={{
          expandedRowRender: n => (
            <div className="knaic-kv" style={{ padding: '6px 0' }}>
              <div className="k">Labels</div>
              <div>
                <Space wrap size={4}>
                  {Object.entries(n.labels).map(([k, v]) => (
                    <Tag key={k}>{k}={v}</Tag>
                  ))}
                  {Object.keys(n.labels).length === 0 && <span className="knaic-sub">—</span>}
                </Space>
              </div>
              <div className="k">Taints</div>
              <div>
                <Space wrap size={4}>
                  {n.taints.map((t, i) => (
                    <Tag key={i} color="red">{t.key}{t.value ? `=${t.value}` : ''}:{t.effect}</Tag>
                  ))}
                  {n.taints.length === 0 && <span className="knaic-sub">—</span>}
                </Space>
              </div>
            </div>
          ),
        }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          {
            title: 'Role',
            dataIndex: 'role',
            render: v => (
              <Tag color={v === 'gpu-worker' ? 'blue' : v === 'control-plane' ? 'purple' : 'default'}>{v}</Tag>
            ),
          },
          { title: 'CPU', dataIndex: 'cpu' },
          { title: 'Memory', dataIndex: 'memory' },
          { title: 'Accelerators', dataIndex: 'gpu' },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          { title: 'Kubelet', dataIndex: 'kubelet' },
          {
            title: 'Actions',
            render: (_, r) => (
              <Space>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setLabelTarget(r);
                    labelForm.setFieldsValue({
                      entries: Object.entries(r.labels).map(([k, v]) => ({ key: k, value: v })),
                    });
                  }}
                >
                  Labels
                </Button>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setTaintTarget(r);
                    taintForm.setFieldsValue({ taints: r.taints });
                  }}
                >
                  Taints
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={!!labelTarget}
        title={`Edit labels · ${labelTarget?.name ?? ''}`}
        onCancel={() => setLabelTarget(null)}
        destroyOnClose
        onOk={async () => {
          const v = await labelForm.validateFields();
          const labels: Record<string, string> = {};
          for (const e of v.entries as { key: string; value: string }[]) labels[e.key] = e.value ?? '';
          try {
            await updateNode(labelTarget!.name, { labels });
            setLabelTarget(null);
            message.success('Labels updated');
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to update labels');
          }
        }}
      >
        <Form form={labelForm} layout="vertical" preserve={false}>
          <Form.List name="entries">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 6 }}>
                    <Form.Item name={[name, 'key']} rules={[{ required: true }]}>
                      <Input placeholder="key (e.g. node.knaic.io/pool)" style={{ width: 260 }} />
                    </Form.Item>
                    <Form.Item name={[name, 'value']}>
                      <Input placeholder="value" style={{ width: 180 }} />
                    </Form.Item>
                    <Button danger icon={<DeleteOutlined />} onClick={() => remove(name)} />
                  </Space>
                ))}
                <Button block icon={<PlusOutlined />} onClick={() => add({ key: '', value: '' })}>
                  Add label
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
      <Modal
        open={!!taintTarget}
        title={`Edit taints · ${taintTarget?.name ?? ''}`}
        onCancel={() => setTaintTarget(null)}
        destroyOnClose
        onOk={async () => {
          const v = await taintForm.validateFields();
          try {
            await updateNode(taintTarget!.name, { taints: v.taints as Taint[] });
            setTaintTarget(null);
            message.success('Taints updated');
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to update taints');
          }
        }}
      >
        <Form form={taintForm} layout="vertical" preserve={false}>
          <Form.List name="taints">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 6 }}>
                    <Form.Item name={[name, 'key']} rules={[{ required: true }]}>
                      <Input placeholder="key" style={{ width: 200 }} />
                    </Form.Item>
                    <Form.Item name={[name, 'value']}>
                      <Input placeholder="value" style={{ width: 160 }} />
                    </Form.Item>
                    <Form.Item name={[name, 'effect']} rules={[{ required: true }]} initialValue="NoSchedule">
                      <Select
                        style={{ width: 160 }}
                        options={['NoSchedule', 'PreferNoSchedule', 'NoExecute'].map(v => ({ label: v, value: v }))}
                      />
                    </Form.Item>
                    <Button danger icon={<DeleteOutlined />} onClick={() => remove(name)} />
                  </Space>
                ))}
                <Button block icon={<PlusOutlined />} onClick={() => add({ key: '', value: '', effect: 'NoSchedule' })}>
                  Add taint
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  );
}
