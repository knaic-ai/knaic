import { useEffect, useState } from 'react';
import {
  Table, Tag, Space, Button, Modal, Form, Input, InputNumber, Select, App,
} from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import {
  useGPUProfiles, addGPUProfile, ensureGPUProfilesLoaded, reloadGPUProfiles, removeGPUProfile, type GPUProfile,
} from '@/data/gpuProfiles';
import { useApp } from '@/context/AppContext';

const kindColor: Record<GPUProfile['kind'], string> = {
  hami: 'geekblue',
  nvidia: 'green',
  npu: 'volcano',
  custom: 'purple',
};

export function GPUProfilesPage() {
  const { user } = useApp();
  const profiles = useGPUProfiles();
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  // Built-ins load fast, but custom profiles round-trip through a
  // ConfigMap; trigger the load on mount so the table reflects what
  // operators have configured cluster-wide.
  useEffect(() => {
    ensureGPUProfilesLoaded();
  }, []);
  // The backend gates writes to platform admins (auth.RequirePlatformAdmin
  // on POST/PUT/DELETE); hide the controls for everyone else.
  const canWrite = user.isPlatformAdmin;

  return (
    <div className="knaic-page">
      <PageHeader
        title="Admin · GPU / accelerator profiles"
        description="Resource templates offered to users when creating inference / train / notebook workloads. Built-in profiles cover HAMi, NVIDIA and Ascend NPU; platform admins can add profiles for new hardware."
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => reloadGPUProfiles()}>Refresh</Button>
            {canWrite && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setOpen(true); }}>
                Add profile
              </Button>
            )}
          </Space>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        pagination={false}
        dataSource={profiles}
        expandable={{
          expandedRowRender: p => (
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={p.fields}
              columns={[
                { title: 'Resource key', dataIndex: 'key', render: v => <span className="mono">{v}</span> },
                { title: 'Label', dataIndex: 'label' },
                { title: 'Unit', dataIndex: 'unit', render: v => v ?? '—' },
                { title: 'Default', dataIndex: 'defaultValue' },
                { title: 'Min', dataIndex: 'min', render: v => v ?? '—' },
                { title: 'Max', dataIndex: 'max', render: v => v ?? '—' },
              ]}
            />
          ),
        }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'Kind', dataIndex: 'kind', render: v => <Tag color={kindColor[v as GPUProfile['kind']]}>{v}</Tag> },
          { title: 'Description', dataIndex: 'description' },
          {
            title: 'Source',
            render: (_, r) => r.builtin ? <Tag color="blue">built-in</Tag> : <Tag color="purple">custom</Tag>,
          },
          {
            title: 'Actions',
            width: 120,
            render: (_, r) => canWrite ? (
              <Button
                size="small"
                danger
                disabled={r.builtin}
                icon={<DeleteOutlined />}
                onClick={() =>
                  modal.confirm({
                    title: `Delete profile ${r.name}?`,
                    content: 'Workloads that already reference this profile keep working — only new pickers stop offering it.',
                    onOk: async () => {
                      try {
                        await removeGPUProfile(r.id);
                        message.success('Profile removed');
                      } catch (e) {
                        message.error((e as Error).message);
                      }
                    },
                  })
                }
              />
            ) : <span className="knaic-sub">—</span>,
          },
        ]}
      />
      <Modal
        open={open}
        title="Add GPU profile"
        onCancel={() => setOpen(false)}
        destroyOnClose
        width={680}
        confirmLoading={submitting}
        onOk={async () => {
          const v = await form.validateFields();
          setSubmitting(true);
          try {
            await addGPUProfile({
              name: v.name,
              kind: v.kind,
              description: v.description ?? '',
              fields: (v.fields ?? []).map((f: {
                key: string; label: string; unit?: string; defaultValue: number; min?: number; max?: number; step?: number;
              }) => ({
                key: f.key,
                label: f.label,
                unit: f.unit,
                defaultValue: f.defaultValue,
                min: f.min,
                max: f.max,
                step: f.step,
              })),
            });
            message.success(`Profile ${v.name} added`);
            setOpen(false);
            form.resetFields();
          } catch (e) {
            message.error((e as Error).message);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false} initialValues={{ kind: 'custom' }}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. AMD MI300X" />
          </Form.Item>
          <Form.Item name="kind" label="Kind" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'HAMi (shared)', value: 'hami' },
                { label: 'NVIDIA', value: 'nvidia' },
                { label: 'NPU', value: 'npu' },
                { label: 'Custom', value: 'custom' },
              ]}
            />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="Resource fields" required>
            <Form.List name="fields">
              {(fs, { add, remove }) => (
                <>
                  {fs.map(({ key, name }) => (
                    <Space key={key} style={{ display: 'flex', marginBottom: 6 }} align="start" wrap>
                      <Form.Item name={[name, 'key']} rules={[{ required: true }]}>
                        <Input placeholder="nvidia.com/gpu" style={{ width: 220 }} />
                      </Form.Item>
                      <Form.Item name={[name, 'label']} rules={[{ required: true }]}>
                        <Input placeholder="label" style={{ width: 140 }} />
                      </Form.Item>
                      <Form.Item name={[name, 'unit']}>
                        <Input placeholder="unit" style={{ width: 80 }} />
                      </Form.Item>
                      <Form.Item name={[name, 'defaultValue']} rules={[{ required: true }]}>
                        <InputNumber placeholder="default" style={{ width: 90 }} />
                      </Form.Item>
                      <Form.Item name={[name, 'min']}>
                        <InputNumber placeholder="min" style={{ width: 70 }} />
                      </Form.Item>
                      <Form.Item name={[name, 'max']}>
                        <InputNumber placeholder="max" style={{ width: 70 }} />
                      </Form.Item>
                      <Button danger icon={<DeleteOutlined />} onClick={() => remove(name)} />
                    </Space>
                  ))}
                  <Button block icon={<PlusOutlined />} onClick={() => add({ key: '', label: '', defaultValue: 1 })}>
                    Add field
                  </Button>
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
