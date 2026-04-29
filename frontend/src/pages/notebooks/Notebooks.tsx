import { useEffect, useMemo, useState } from 'react';
import {
  Table, Tag, Space, Button, App, Modal, Form, Input, Select, Row, Col, Radio,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  useNotebooks,
  ensureNotebooksLoaded,
  reloadNotebooks,
  createNotebook,
  startNotebook,
  stopNotebook,
  deleteNotebook,
  type Notebook,
  type NotebookVolumeKind,
} from '@/data/notebooks';
import { useApp } from '@/context/AppContext';
import { GPUProfileFields } from '@/components/GPUProfileFields';
import { useGPUProfiles } from '@/data/gpuProfiles';
import { usePVCs, ensurePvcsLoaded } from '@/data/workloads';

const IMAGE_PRESETS = [
  { label: 'jupyter-pytorch-cuda-full (v1.10.0)', value: 'kubeflownotebookswg/jupyter-pytorch-cuda-full:v1.10.0' },
  { label: 'jupyter-scipy (v1.10.0)', value: 'kubeflownotebookswg/jupyter-scipy:v1.10.0' },
  { label: 'jupyter-tensorflow-cuda (v1.10.0)', value: 'kubeflownotebookswg/jupyter-tensorflow-cuda:v1.10.0' },
  { label: 'vscode-python (v1.10.0)', value: 'kubeflownotebookswg/codeserver-python:v1.10.0' },
];

interface FormShape {
  name: string;
  image: string;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  gpuProfileId?: string;
  gpuValues?: Record<string, number>;
  sharedMemory: string;
  volumeKind: NotebookVolumeKind;
  pvcName?: string;
  pvcCapacity?: string;
  pvcStorageClass?: string;
  mountPath?: string;
}

export function NotebooksPage() {
  const { namespace, user } = useApp();
  const { message, modal } = App.useApp();
  const all = useNotebooks();
  const profiles = useGPUProfiles();
  const pvcs = usePVCs();
  const data = useMemo(() => all.filter(n => n.namespace === namespace), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<FormShape>();

  const cpuReq = Form.useWatch('cpuRequest', form);
  const memReq = Form.useWatch('memoryRequest', form);
  const volumeKind = Form.useWatch('volumeKind', form);
  const nbName = Form.useWatch('name', form);

  useEffect(() => {
    ensureNotebooksLoaded(namespace);
    ensurePvcsLoaded(namespace);
  }, [namespace]);

  useEffect(() => {
    if (!open) return;
    const { cpuLimit, memoryLimit } = form.getFieldsValue(['cpuLimit', 'memoryLimit']);
    if (!cpuLimit) form.setFieldValue('cpuLimit', cpuReq);
    if (!memoryLimit) form.setFieldValue('memoryLimit', memReq);
  }, [cpuReq, memReq, open, form]);

  const transition = async (n: Notebook, next: Notebook['status']) => {
    try {
      if (next === 'Running') await startNotebook(n.namespace, n.name);
      else if (next === 'Stopped') await stopNotebook(n.namespace, n.name);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const nsPvcs = pvcs.filter(p => p.namespace === namespace);

  return (
    <div className="knaic-page">
      <PageHeader
        title="Notebooks"
        description="Jupyter / VSCode notebook servers managed by the kubeflow notebook controller."
        extra={
          <Space>
            <Button onClick={() => reloadNotebooks(namespace)}>Refresh</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setOpen(true); }}>
              New notebook
            </Button>
          </Space>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'Owner', dataIndex: 'owner' },
          { title: 'Image', dataIndex: 'image', render: v => <span className="mono">{v}</span> },
          {
            title: 'Resources',
            render: (_, r) => (
              <Space size={4} wrap>
                <Tag>{r.cpu} CPU</Tag>
                <Tag>{r.memory}</Tag>
                {r.gpu > 0 && <Tag color="blue">{r.gpu} GPU</Tag>}
                <Tag color="purple">shm {r.sharedMemory}</Tag>
              </Space>
            ),
          },
          {
            title: 'Volume',
            render: (_, r) =>
              r.volume.kind === 'none' ? (
                <span className="knaic-sub">none</span>
              ) : (
                <Space size={4}>
                  <Tag color={r.volume.kind === 'new' ? 'green' : 'default'}>{r.volume.kind}</Tag>
                  <span className="mono">{r.volume.pvcName}</span>
                </Space>
              ),
          },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          {
            title: 'Actions',
            width: 260,
            render: (_, r) => (
              <Space>
                {r.status === 'Running' ? (
                  <>
                    <Button size="small" icon={<LinkOutlined />} href={r.url} target="_blank">
                      Open
                    </Button>
                    <Button
                      size="small"
                      icon={<PauseCircleOutlined />}
                      onClick={() => transition(r, 'Stopped')}
                    >
                      Stop
                    </Button>
                  </>
                ) : r.status === 'Stopped' ? (
                  <Button
                    size="small"
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    onClick={() => transition(r, 'Running')}
                  >
                    Start
                  </Button>
                ) : (
                  <Button size="small" disabled>
                    {r.status}
                  </Button>
                )}
                {(user.isPlatformAdmin || r.owner === user.name) && (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() =>
                      modal.confirm({
                        title: `Delete notebook ${r.name}?`,
                        onOk: async () => {
                          try {
                            await deleteNotebook(r.namespace, r.name);
                            message.success('Notebook deleted');
                          } catch (e) {
                            message.error((e as Error).message);
                          }
                        },
                      })
                    }
                  />
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={open}
        title="New notebook"
        width={680}
        onCancel={() => setOpen(false)}
        destroyOnClose
        confirmLoading={submitting}
        onOk={async () => {
          const v = await form.validateFields();
          const profile = profiles.find(p => p.id === v.gpuProfileId);
          const gpuValues = profile && v.gpuValues ? v.gpuValues : undefined;
          const volume = {
            kind: v.volumeKind,
            pvcName:
              v.volumeKind === 'existing' ? v.pvcName :
              v.volumeKind === 'new' ? (v.pvcName || `notebook-${v.name}-home`) :
              undefined,
            storageClass: v.volumeKind === 'new' ? (v.pvcStorageClass ?? 'standard') : undefined,
            capacity: v.volumeKind === 'new' ? (v.pvcCapacity ?? '20Gi') : undefined,
            mountPath: v.volumeKind !== 'none' ? (v.mountPath ?? '/home/jovyan') : undefined,
          };
          setSubmitting(true);
          try {
            await createNotebook(namespace, {
              name: v.name,
              image: v.image,
              cpuRequest: v.cpuRequest,
              cpuLimit: v.cpuLimit,
              memoryRequest: v.memoryRequest,
              memoryLimit: v.memoryLimit,
              gpuValues,
              sharedMemory: v.sharedMemory,
              volume,
              owner: user.name,
            });
            message.success('Notebook created');
            setOpen(false);
            form.resetFields();
          } catch (e) {
            message.error((e as Error).message);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            image: IMAGE_PRESETS[0].value,
            cpuRequest: '4',
            cpuLimit: '4',
            memoryRequest: '16Gi',
            memoryLimit: '16Gi',
            sharedMemory: '2Gi',
            volumeKind: 'new',
            pvcCapacity: '20Gi',
            pvcStorageClass: 'standard',
            mountPath: '/home/jovyan',
          }}
        >
          <Form.Item name="name" label="Name" rules={[{ required: true, pattern: /^[a-z0-9-]+$/ }]}>
            <Input placeholder="my-research" />
          </Form.Item>
          <Form.Item name="image" label="Image" rules={[{ required: true }]}>
            <Select options={IMAGE_PRESETS} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="cpuRequest" label="CPU request" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="cpuLimit" label="CPU limit" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="memoryRequest" label="Memory request" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="memoryLimit" label="Memory limit" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="sharedMemory"
            label="Shared memory (/dev/shm)"
            tooltip="Mounted as an emptyDir with medium=Memory. Increase for PyTorch DataLoader workers."
            rules={[{ required: true }]}
          >
            <Input style={{ width: 200 }} placeholder="2Gi" />
          </Form.Item>
          <GPUProfileFields />
          <Form.Item name="volumeKind" label="Workspace volume">
            <Radio.Group
              options={[
                { label: 'New PVC', value: 'new' },
                { label: 'Existing PVC', value: 'existing' },
                { label: 'None (ephemeral)', value: 'none' },
              ]}
              optionType="button"
            />
          </Form.Item>
          {volumeKind === 'new' && (
            <Row gutter={12}>
              <Col span={10}>
                <Form.Item name="pvcName" label="PVC name" tooltip="Defaults to notebook-<name>-home">
                  <Input placeholder={`notebook-${nbName ?? '<name>'}-home`} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="pvcCapacity" label="Capacity" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="pvcStorageClass" label="StorageClass">
                  <Select
                    options={[
                      { label: 'standard', value: 'standard' },
                      { label: 'nvme-premium', value: 'nvme-premium' },
                      { label: 'hdd-bulk', value: 'hdd-bulk' },
                    ]}
                  />
                </Form.Item>
              </Col>
            </Row>
          )}
          {volumeKind === 'existing' && (
            <Form.Item name="pvcName" label="Existing PVC" rules={[{ required: true }]}>
              <Select
                options={nsPvcs.map(p => ({ label: `${p.name} · ${p.capacity}`, value: p.name }))}
                placeholder="Pick a PVC bound in this namespace"
                notFoundContent="No PVCs in this namespace"
              />
            </Form.Item>
          )}
          {volumeKind !== 'none' && (
            <Form.Item name="mountPath" label="Mount path" rules={[{ required: true }]}>
              <Input style={{ width: 320 }} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
