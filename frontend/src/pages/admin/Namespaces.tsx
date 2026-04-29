import { useState } from 'react';
import { Table, Button, Space, Modal, Form, Input, InputNumber, App, Tag, Select } from 'antd';
import { PlusOutlined, UserAddOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { useApp, type NamespaceRole } from '@/context/AppContext';
import { useUsers, usersStore } from '@/data/users';
import { createStore, useStore } from '@/data/store';

interface NsQuota {
  name: string;
  cpu: number;
  memory: number;
  gpu: number;
  pods: number;
}

export const nsQuotasStore = createStore<Record<string, NsQuota>>({
  'team-ml': { name: 'team-ml', cpu: 128, memory: 512, gpu: 8, pods: 200 },
  'team-vision': { name: 'team-vision', cpu: 64, memory: 256, gpu: 4, pods: 100 },
  'team-llm': { name: 'team-llm', cpu: 256, memory: 2048, gpu: 16, pods: 300 },
  default: { name: 'default', cpu: 32, memory: 64, gpu: 0, pods: 50 },
});
const useQuotas = () => useStore(nsQuotasStore);

const roleColor: Record<NamespaceRole, string> = {
  admin: 'gold',
  editor: 'blue',
  viewer: 'default',
};

export function NamespacesPage() {
  const { namespaces, addNamespace, removeNamespace } = useApp();
  const quotas = useQuotas();
  const users = useUsers();
  const { message, modal } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [membersNs, setMembersNs] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [form] = Form.useForm<NsQuota>();
  const [assignForm] = Form.useForm();

  const data = namespaces.map(
    n => quotas[n] ?? { name: n, cpu: 0, memory: 0, gpu: 0, pods: 0 },
  );

  function membersIn(ns: string) {
    return users
      .filter(u => u.memberships[ns])
      .map(u => ({ user: u, role: u.memberships[ns] as NamespaceRole }));
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="Admin · Namespaces"
        description="Multi-tenant workspaces. Each namespace has a ResourceQuota and member list with platform-admin / namespace-admin / editor / viewer roles."
        extra={
          <Button icon={<PlusOutlined />} type="primary" onClick={() => setCreateOpen(true)}>
            Create namespace
          </Button>
        }
      />
      <Table
        rowKey="name"
        size="middle"
        dataSource={data}
        pagination={false}
        columns={[
          { title: 'Namespace', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'CPU', dataIndex: 'cpu', render: v => `${v} cores` },
          { title: 'Memory', dataIndex: 'memory', render: v => `${v} Gi` },
          { title: 'GPU', dataIndex: 'gpu' },
          { title: 'Max pods', dataIndex: 'pods' },
          {
            title: 'Members',
            render: (_, r) => (
              <Space wrap size={4}>
                {membersIn(r.name)
                  .slice(0, 4)
                  .map(m => (
                    <Tag key={m.user.name} color={roleColor[m.role]}>
                      {m.user.name} · {m.role}
                    </Tag>
                  ))}
                {membersIn(r.name).length > 4 && (
                  <Tag>+{membersIn(r.name).length - 4}</Tag>
                )}
              </Space>
            ),
          },
          {
            title: 'Actions',
            width: 200,
            render: (_, r) => (
              <Space>
                <Button size="small" onClick={() => setMembersNs(r.name)}>Manage members</Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={r.name === 'default'}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete namespace ${r.name}?`,
                      content: 'All workloads and memberships in this namespace will be detached.',
                      onOk: () => {
                        removeNamespace(r.name);
                        message.success('Namespace deleted');
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
        open={createOpen}
        title="Create namespace"
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          addNamespace(v.name);
          nsQuotasStore.set(prev => ({ ...prev, [v.name]: v }));
          setCreateOpen(false);
          form.resetFields();
          message.success(`Namespace ${v.name} created`);
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true, pattern: /^[a-z0-9-]+$/, message: 'lowercase letters, digits, hyphens' }]}>
            <Input placeholder="team-foo" />
          </Form.Item>
          <Form.Item name="cpu" label="CPU (cores)" initialValue={32}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="memory" label="Memory (Gi)" initialValue={64}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="gpu" label="GPU count" initialValue={0}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="pods" label="Max pods" initialValue={100}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!membersNs}
        title={`Members · ${membersNs ?? ''}`}
        onCancel={() => setMembersNs(null)}
        destroyOnClose
        footer={null}
        width={720}
      >
        {membersNs && (
          <>
            <Space style={{ marginBottom: 8 }}>
              <Button icon={<UserAddOutlined />} type="primary" onClick={() => { assignForm.resetFields(); setAssignOpen(true); }}>
                Add member
              </Button>
            </Space>
            <Table
              rowKey={r => r.user.name}
              size="small"
              dataSource={membersIn(membersNs)}
              pagination={false}
              columns={[
                { title: 'User', render: (_, r) => <b>{r.user.name}</b> },
                { title: 'Email', render: (_, r) => r.user.email },
                {
                  title: 'Role',
                  render: (_, r) => (
                    <Select
                      size="small"
                      value={r.role}
                      onChange={role => {
                        usersStore.set(prev => prev.map(u =>
                          u.name === r.user.name
                            ? { ...u, memberships: { ...u.memberships, [membersNs]: role as NamespaceRole } }
                            : u,
                        ));
                      }}
                      options={[
                        { label: 'Admin', value: 'admin' },
                        { label: 'Editor', value: 'editor' },
                        { label: 'Viewer', value: 'viewer' },
                      ]}
                      style={{ width: 120 }}
                    />
                  ),
                },
                {
                  title: '',
                  width: 80,
                  render: (_, r) => (
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => {
                        usersStore.set(prev => prev.map(u => {
                          if (u.name !== r.user.name) return u;
                          const m = { ...u.memberships };
                          delete m[membersNs];
                          return { ...u, memberships: m };
                        }));
                      }}
                    />
                  ),
                },
              ]}
            />
          </>
        )}
      </Modal>

      <Modal
        open={assignOpen}
        title="Add member"
        onCancel={() => setAssignOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await assignForm.validateFields();
          usersStore.set(prev => prev.map(u =>
            u.name === v.user
              ? { ...u, memberships: { ...u.memberships, [membersNs!]: v.role as NamespaceRole } }
              : u,
          ));
          setAssignOpen(false);
          assignForm.resetFields();
          message.success(`${v.user} added as ${v.role}`);
        }}
      >
        <Form form={assignForm} layout="vertical" preserve={false}>
          <Form.Item name="user" label="User" rules={[{ required: true }]}>
            <Select
              options={users
                .filter(u => membersNs && !u.memberships[membersNs])
                .map(u => ({ label: `${u.name} — ${u.email}`, value: u.name }))}
            />
          </Form.Item>
          <Form.Item name="role" label="Role" initialValue="editor" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'Admin', value: 'admin' },
                { label: 'Editor', value: 'editor' },
                { label: 'Viewer', value: 'viewer' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
