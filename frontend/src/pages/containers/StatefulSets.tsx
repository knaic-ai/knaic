import { useEffect, useMemo, useState } from 'react';
import { Table, Space, Button, App, Modal, Form, Input, InputNumber, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, FileTextOutlined, CodeOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  createStatefulSet,
  deleteWorkload,
  ensurePodsLoaded,
  ensureStatefulSetsLoaded,
  fetchResourceYaml,
  reloadStatefulSets,
  usePods,
  useStatefulSets,
  type Pod,
  type StatefulSet,
} from '@/data/workloads';
import { useApp } from '@/context/AppContext';
import { LogViewer } from '@/components/LogViewer';
import { YamlViewer } from '@/components/YamlViewer';
import { buildStatefulSetYaml } from '@/data/clusterResources';
import { apiEnabled } from '@/api/client';

export function StatefulSets() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useStatefulSets();
  const pods = usePods();
  const data = useMemo(() => all.filter(s => s.namespace === namespace), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [log, setLog] = useState<{ statefulSet: StatefulSet; pod?: Pod } | null>(null);
  const [yaml, setYaml] = useState<{ ss: StatefulSet; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);

  useEffect(() => {
    ensureStatefulSetsLoaded(namespace);
    ensurePodsLoaded(namespace);
  }, [namespace]);

  const podFor = (statefulSet: StatefulSet) =>
    pods.find(p => p.namespace === statefulSet.namespace && p.ownerRef === `StatefulSet/${statefulSet.name}`);

  const openYaml = async (ss: StatefulSet) => {
    setYamlLoading(ss.name);
    try {
      const text = await fetchResourceYaml('statefulsets', namespace, ss.name);
      setYaml({ ss, text });
    } catch (e) {
      setYaml({ ss, text: buildStatefulSetYaml(ss) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="StatefulSets"
        description={`Stateful workloads in namespace ${namespace}`}
        extra={
          <Space>
            <Button onClick={() => reloadStatefulSets(namespace)}>Refresh</Button>
            <Tooltip title="Create a Kubernetes StatefulSet in the selected namespace">
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setOpen(true)}
              >
                New StatefulSet
              </Button>
            </Tooltip>
          </Space>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'Service', dataIndex: 'serviceName' },
          { title: 'Image', dataIndex: 'image', render: v => <span className="mono">{v}</span> },
          {
            title: 'Replicas',
            render: (_, r) => `${r.readyReplicas}/${r.replicas}`,
          },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          { title: 'Created', dataIndex: 'createdAt' },
          {
            title: 'Actions',
            width: 200,
            render: (_, r) => (
              <Space>
                <Button
                  size="small"
                  icon={<FileTextOutlined />}
                  onClick={() => {
                    const pod = podFor(r);
                    if (apiEnabled && !pod) {
                      message.warning('No pod found for this StatefulSet');
                      return;
                    }
                    setLog({ statefulSet: r, pod });
                  }}
                >
                  Logs
                </Button>
                <Button
                  size="small"
                  icon={<CodeOutlined />}
                  loading={yamlLoading === r.name}
                  onClick={() => openYaml(r)}
                >
                  YAML
                </Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete StatefulSet ${r.name}?`,
                      onOk: async () => {
                        try {
                          await deleteWorkload('statefulsets', namespace, r.name);
                          message.success('Deleted');
                          reloadStatefulSets(namespace);
                        } catch (e) {
                          message.error((e as Error).message);
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
      <Modal
        open={open}
        title="New StatefulSet"
        onCancel={() => setOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await createStatefulSet(namespace, { name: v.name, image: v.image, replicas: v.replicas });
            setOpen(false);
            form.resetFields();
            message.success('StatefulSet created');
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to create StatefulSet');
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="image" label="Image" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="replicas" label="Replicas" initialValue={1} rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <LogViewer
        open={!!log}
        onClose={() => setLog(null)}
        title={`Logs · ${log?.statefulSet.name ?? ''}`}
        containers={log?.pod?.containers ?? ['main']}
        podRef={log?.pod ? { namespace: log.pod.namespace, name: log.pod.name } : undefined}
      />
      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`StatefulSet · ${yaml?.ss.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
    </div>
  );
}
