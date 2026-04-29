import { useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App, Modal, Form, Input, InputNumber, Select, Switch } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import {
  trainingRuntimesStore,
  useTrainingRuntimes,
  type TrainingFramework,
} from '@/data/training';
import { uid } from '@/data/store';
import { useApp } from '@/context/AppContext';

const FRAMEWORKS: TrainingFramework[] = ['torch', 'deepspeed', 'mpi', 'tensorflow', 'jax'];

const fwColor: Record<TrainingFramework, string> = {
  torch: 'red',
  deepspeed: 'geekblue',
  mpi: 'volcano',
  tensorflow: 'orange',
  jax: 'purple',
};

export function TrainingRuntimesPage() {
  const { namespace, user } = useApp();
  const { message, modal } = App.useApp();
  const all = useTrainingRuntimes();
  const data = useMemo(
    () => all.filter(r => r.builtin || r.namespace === namespace),
    [all, namespace],
  );
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  return (
    <div className="knaic-page">
      <PageHeader
        title="Training runtimes"
        description="Kubeflow Trainer v2 ClusterTrainingRuntime / TrainingRuntime resources. Builtin runtimes are shipped with knaic."
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            New training runtime
          </Button>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            render: (v, r) => (
              <Space>
                <b>{v}</b>
                {r.builtin && <Tag color="cyan">builtin</Tag>}
              </Space>
            ),
          },
          { title: 'Namespace', dataIndex: 'namespace' },
          {
            title: 'Framework',
            dataIndex: 'framework',
            render: (v: TrainingFramework) => <Tag color={fwColor[v]}>{v}</Tag>,
          },
          { title: 'Image', dataIndex: 'image', render: v => <span className="mono">{v}</span> },
          { title: 'Nodes', dataIndex: 'numNodes' },
          {
            title: 'Per-node resources',
            render: (_, r) =>
              `${r.resourcesPerNode.cpu} CPU · ${r.resourcesPerNode.memory} · ${r.resourcesPerNode.gpu} GPU`,
          },
          { title: 'Created', dataIndex: 'createdAt' },
          {
            title: 'Actions',
            width: 120,
            render: (_, r) => (
              <Space>
                <Button
                  size="small"
                  danger
                  disabled={r.builtin && !user.isPlatformAdmin}
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete runtime ${r.name}?`,
                      content: r.builtin
                        ? 'This is a builtin ClusterTrainingRuntime — removing it will affect all namespaces.'
                        : undefined,
                      onOk: () => {
                        trainingRuntimesStore.set(prev => prev.filter(x => x.id !== r.id));
                        message.success('Runtime deleted');
                      },
                    })
                  }
                />
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={open}
        title="New training runtime"
        onCancel={() => setOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          trainingRuntimesStore.set(prev => [
            {
              id: uid('tr'),
              name: v.name,
              namespace: v.cluster ? 'knaic-system' : namespace,
              framework: v.framework,
              image: v.image,
              numNodes: v.numNodes,
              resourcesPerNode: { cpu: v.cpu, memory: v.memory, gpu: v.gpu },
              createdAt: new Date().toISOString().slice(0, 10),
              builtin: false,
            },
            ...prev,
          ]);
          setOpen(false);
          form.resetFields();
          message.success('TrainingRuntime created');
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="framework" label="Framework" initialValue="torch">
            <Select options={FRAMEWORKS.map(v => ({ label: v, value: v }))} />
          </Form.Item>
          <Form.Item name="image" label="Image" rules={[{ required: true }]}>
            <Input placeholder="ghcr.io/kubeflow/trainer/torch-runtime:2.4.0" />
          </Form.Item>
          <Form.Item name="numNodes" label="Number of nodes" initialValue={1}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Space>
            <Form.Item name="cpu" label="CPU / node" initialValue="16">
              <Input style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="memory" label="Memory / node" initialValue="128Gi">
              <Input style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="gpu" label="GPU / node" initialValue={2}>
              <InputNumber min={0} style={{ width: 100 }} />
            </Form.Item>
          </Space>
          {user.isPlatformAdmin && (
            <Form.Item
              name="cluster"
              label="ClusterTrainingRuntime"
              valuePropName="checked"
              tooltip="Cluster-scoped, shared across all namespaces. Stored in knaic-system."
            >
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
