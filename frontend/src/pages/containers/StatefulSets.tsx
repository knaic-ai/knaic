import { useEffect, useMemo, useState } from 'react';
import { Table, Space, Button, App, Modal, Form, Input, InputNumber, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, FileTextOutlined, CodeOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  statefulSetsStore,
  useStatefulSets,
  ensureStatefulSetsLoaded,
  reloadStatefulSets,
  deleteWorkload,
  fetchResourceYaml,
  type StatefulSet,
} from '@/data/workloads';
import { uid } from '@/data/store';
import { useApp } from '@/context/AppContext';
import { LogViewer } from '@/components/LogViewer';
import { YamlViewer } from '@/components/YamlViewer';
import { buildStatefulSetYaml } from '@/data/clusterResources';
import { apiEnabled } from '@/api/client';

export function StatefulSets() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useStatefulSets();
  const data = useMemo(() => all.filter(s => s.namespace === namespace), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [log, setLog] = useState<StatefulSet | null>(null);
  const [yaml, setYaml] = useState<{ ss: StatefulSet; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);

  useEffect(() => {
    ensureStatefulSetsLoaded(namespace);
  }, [namespace]);

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
            <Tooltip title={apiEnabled ? 'Create raw StatefulSets via kubectl' : ''}>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={apiEnabled}
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
                <Button size="small" icon={<FileTextOutlined />} onClick={() => setLog(r)}>
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
          statefulSetsStore.set(prev => [
            {
              id: uid('ss'),
              name: v.name,
              namespace,
              image: v.image,
              replicas: v.replicas,
              readyReplicas: 0,
              status: 'Progressing',
              createdAt: new Date().toISOString().slice(0, 10),
              serviceName: v.name,
            },
            ...prev,
          ]);
          window.setTimeout(() => {
            statefulSetsStore.set(prev =>
              prev.map(s => (s.name === v.name ? { ...s, readyReplicas: v.replicas, status: 'Running' } : s)),
            );
          }, 1500);
          setOpen(false);
          form.resetFields();
          message.success('StatefulSet created');
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
        title={`Logs · ${log?.name ?? ''}`}
        containers={['main']}
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
