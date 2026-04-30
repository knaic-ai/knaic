import { useEffect, useMemo, useState } from 'react';
import { Table, Space, Button, Modal, Form, Input, InputNumber, App, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, FileTextOutlined, EditOutlined, CodeOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  createDeployment,
  deleteWorkload,
  ensureDeploymentsLoaded,
  ensurePodsLoaded,
  fetchResourceYaml,
  reloadDeployments,
  updateDeployment,
  useDeployments,
  usePods,
  type Deployment,
  type Pod,
} from '@/data/workloads';
import { useApp } from '@/context/AppContext';
import { LogViewer } from '@/components/LogViewer';
import { YamlViewer } from '@/components/YamlViewer';
import { buildDeploymentYaml } from '@/data/clusterResources';
import { apiEnabled } from '@/api/client';

export function Deployments() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useDeployments();
  const pods = usePods();
  const data = useMemo(() => all.filter(d => d.namespace === namespace), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Deployment | null>(null);
  const [form] = Form.useForm();
  const [logTarget, setLogTarget] = useState<{ deployment: Deployment; pod?: Pod } | null>(null);
  const [yaml, setYaml] = useState<{ dep: Deployment; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);

  useEffect(() => {
    ensureDeploymentsLoaded(namespace);
    ensurePodsLoaded(namespace);
  }, [namespace]);

  const podFor = (deployment: Deployment) =>
    pods.find(p => p.namespace === deployment.namespace && p.ownerRef === `Deployment/${deployment.name}`);

  const openYaml = async (dep: Deployment) => {
    setYamlLoading(dep.name);
    try {
      const text = await fetchResourceYaml('deployments', namespace, dep.name);
      setYaml({ dep, text });
    } catch (e) {
      setYaml({ dep, text: buildDeploymentYaml(dep) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="Deployments"
        description={`Workloads in namespace ${namespace}`}
        extra={
          <Space>
            <Button onClick={() => reloadDeployments(namespace)}>Refresh</Button>
            <Tooltip title="Create a Kubernetes Deployment in the selected namespace">
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => { setEditing(null); form.resetFields(); setOpen(true); }}
              >
                New deployment
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
          { title: 'Image', dataIndex: 'image', render: v => <span className="mono">{v}</span> },
          {
            title: 'Replicas',
            render: (_, r) => (
              <span>
                {r.readyReplicas}/{r.replicas}
              </span>
            ),
          },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          { title: 'Created', dataIndex: 'createdAt' },
          {
            title: 'Actions',
            width: 240,
            render: (_, r) => (
              <Space>
                <Button
                  size="small"
                  icon={<FileTextOutlined />}
                  onClick={() => {
                    const pod = podFor(r);
                    if (apiEnabled && !pod) {
                      message.warning('No pod found for this deployment');
                      return;
                    }
                    setLogTarget({ deployment: r, pod });
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
                <Tooltip title="Update image and replica count">
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditing(r);
                      form.setFieldsValue(r);
                      setOpen(true);
                    }}
                  />
                </Tooltip>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete deployment ${r.name}?`,
                      onOk: async () => {
                        try {
                          await deleteWorkload('deployments', namespace, r.name);
                          message.success('Deleted');
                          reloadDeployments(namespace);
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
        title={editing ? `Edit deployment ${editing.name}` : 'New deployment'}
        onCancel={() => setOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          try {
            if (editing) {
              await updateDeployment(namespace, editing, { image: v.image, replicas: v.replicas });
              message.success('Deployment updated');
            } else {
              await createDeployment(namespace, { name: v.name, image: v.image, replicas: v.replicas });
              message.success('Deployment created');
            }
            setOpen(false);
            form.resetFields();
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to save deployment');
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item name="image" label="Image" rules={[{ required: true }]}>
            <Input placeholder="nginx:1.27" />
          </Form.Item>
          <Form.Item name="replicas" label="Replicas" initialValue={1} rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <LogViewer
        open={!!logTarget}
        onClose={() => setLogTarget(null)}
        title={`Logs · ${logTarget?.deployment.name ?? ''}`}
        containers={logTarget?.pod?.containers ?? ['main', 'sidecar']}
        podRef={logTarget?.pod ? { namespace: logTarget.pod.namespace, name: logTarget.pod.name } : undefined}
      />
      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`Deployment · ${yaml?.dep.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
    </div>
  );
}
