import { useEffect, useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import {
  deleteTrainingRuntime,
  ensureTrainingRuntimesLoaded,
  useTrainingRuntimes,
  type TrainingFramework,
} from '@/data/training';
import { useApp } from '@/context/AppContext';
import { NewTrainingRuntimeModal } from './NewTrainingRuntimeModal';

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

  useEffect(() => {
    ensureTrainingRuntimesLoaded(namespace);
  }, [namespace]);

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
                      onOk: async () => {
                        try {
                          await deleteTrainingRuntime(namespace, r);
                          message.success('Runtime deleted');
                        } catch (err) {
                          message.error(err instanceof Error ? err.message : 'Failed to delete runtime');
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
      <NewTrainingRuntimeModal open={open} namespace={namespace} onClose={() => setOpen(false)} />
    </div>
  );
}
