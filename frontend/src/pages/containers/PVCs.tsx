import { useEffect, useMemo, useState } from 'react';
import { Table, Button, Space, App, Modal, Form, Input, Select, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, CodeOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  createPVC,
  deleteWorkload,
  ensurePvcsLoaded,
  fetchResourceYaml,
  reloadPvcs,
  usePVCs,
  type PVC,
} from '@/data/workloads';
import { useApp } from '@/context/AppContext';
import { YamlViewer } from '@/components/YamlViewer';
import { buildPVCYaml } from '@/data/clusterResources';

export function PVCs() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = usePVCs();
  const data = useMemo(() => all.filter(p => p.namespace === namespace), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [yaml, setYaml] = useState<{ pvc: PVC; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);

  useEffect(() => {
    ensurePvcsLoaded(namespace);
  }, [namespace]);

  const openYaml = async (pvc: PVC) => {
    setYamlLoading(pvc.name);
    try {
      const text = await fetchResourceYaml('pvcs', namespace, pvc.name);
      setYaml({ pvc, text });
    } catch (e) {
      setYaml({ pvc, text: buildPVCYaml(pvc) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="PVC Volumes"
        description={`PersistentVolumeClaims in namespace ${namespace}`}
        extra={
          <Space>
            <Button onClick={() => reloadPvcs(namespace)}>Refresh</Button>
            <Tooltip title="Create a PersistentVolumeClaim in the selected namespace">
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setOpen(true)}
              >
                New PVC
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
          { title: 'StorageClass', dataIndex: 'storageClass' },
          { title: 'Capacity', dataIndex: 'capacity' },
          { title: 'Access mode', dataIndex: 'accessMode' },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          { title: 'Volume', dataIndex: 'volumeName', render: v => <span className="mono">{v || '—'}</span> },
          { title: 'Created', dataIndex: 'createdAt' },
          {
            title: 'Actions',
            width: 160,
            render: (_, r) => (
              <Space>
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
                      title: `Delete PVC ${r.name}?`,
                      content: 'Underlying PV will be released per the StorageClass reclaim policy.',
                      onOk: async () => {
                        try {
                          await deleteWorkload('pvcs', namespace, r.name);
                          message.success('PVC deleted');
                          reloadPvcs(namespace);
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
        title="New PVC"
        onCancel={() => setOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await createPVC(namespace, {
              name: v.name,
              storageClass: v.storageClass,
              capacity: v.capacity,
              accessMode: v.accessMode,
            });
            setOpen(false);
            form.resetFields();
            message.success('PVC created');
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to create PVC');
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="storageClass" label="StorageClass" initialValue="standard">
            <Select
              options={[
                { label: 'standard', value: 'standard' },
                { label: 'nvme-premium', value: 'nvme-premium' },
                { label: 'hdd-bulk', value: 'hdd-bulk' },
              ]}
            />
          </Form.Item>
          <Form.Item name="capacity" label="Capacity" initialValue="20Gi" rules={[{ required: true }]}>
            <Input placeholder="20Gi" />
          </Form.Item>
          <Form.Item name="accessMode" label="Access mode" initialValue="RWO">
            <Select
              options={[
                { label: 'ReadWriteOnce (RWO)', value: 'RWO' },
                { label: 'ReadWriteMany (RWX)', value: 'RWX' },
                { label: 'ReadOnlyMany (ROX)', value: 'ROX' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`PVC · ${yaml?.pvc.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
    </div>
  );
}
