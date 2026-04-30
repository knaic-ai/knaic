import { Table, Tag, Space, Button, App, Modal, Form, Select, Switch } from 'antd';
import { useEffect, useState } from 'react';
import { EditOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { ensureUsersLoaded, updateUser, useUsers, type UserRecord } from '@/data/users';
import { useApp, type NamespaceRole } from '@/context/AppContext';

const roleColor: Record<NamespaceRole, string> = {
  admin: 'gold',
  editor: 'blue',
  viewer: 'default',
};

export function UsersPage() {
  const { user, namespaces } = useApp();
  const { message } = App.useApp();
  const users = useUsers();
  const [edit, setEdit] = useState<UserRecord | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    ensureUsersLoaded();
  }, []);

  return (
    <div className="knaic-page">
      <PageHeader
        title="Users"
        description="Users are created the first time they authenticate via the OIDC provider (Dex). Platform admins can grant platform-admin and manage namespace memberships."
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={users}
        columns={[
          { title: 'Username', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'Email', dataIndex: 'email' },
          { title: 'OIDC subject', dataIndex: 'oidcSub', render: v => <span className="mono">{v}</span> },
          { title: 'First seen', dataIndex: 'firstSeen' },
          { title: 'Last seen', dataIndex: 'lastSeen' },
          {
            title: 'Platform admin',
            dataIndex: 'isPlatformAdmin',
            render: v => (v ? <Tag color="gold">Yes</Tag> : <Tag>No</Tag>),
          },
          {
            title: 'Memberships',
            dataIndex: 'memberships',
            render: (v: Record<string, NamespaceRole>) => (
              <Space wrap size={4}>
                {Object.entries(v).map(([ns, role]) => (
                  <Tag key={ns} color={roleColor[role]}>{ns} · {role}</Tag>
                ))}
                {Object.keys(v).length === 0 && <span className="knaic-sub">—</span>}
              </Space>
            ),
          },
          {
            title: 'Actions',
            width: 100,
            render: (_, r) =>
              user.isPlatformAdmin ? (
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEdit(r);
                    form.setFieldsValue({
                      isPlatformAdmin: r.isPlatformAdmin,
                      memberships: Object.entries(r.memberships).map(([ns, role]) => ({ ns, role })),
                    });
                  }}
                >
                  Edit
                </Button>
              ) : null,
          },
        ]}
      />
      <Modal
        open={!!edit}
        title={`Edit user · ${edit?.name ?? ''}`}
        onCancel={() => setEdit(null)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          const memberships: Record<string, NamespaceRole> = {};
          for (const e of (v.memberships ?? []) as { ns: string; role: NamespaceRole }[]) {
            if (e.ns) memberships[e.ns] = e.role;
          }
          try {
            await updateUser(edit!.id, { isPlatformAdmin: v.isPlatformAdmin, memberships });
            setEdit(null);
            message.success('User updated');
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to update user');
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="isPlatformAdmin" label="Platform admin" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.List name="memberships">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 6 }}>
                    <Form.Item name={[name, 'ns']} rules={[{ required: true }]}>
                      <Select
                        style={{ width: 220 }}
                        options={namespaces.map(n => ({ label: n, value: n }))}
                        placeholder="Namespace"
                      />
                    </Form.Item>
                    <Form.Item name={[name, 'role']} rules={[{ required: true }]} initialValue="editor">
                      <Select
                        style={{ width: 140 }}
                        options={[
                          { label: 'Admin', value: 'admin' },
                          { label: 'Editor', value: 'editor' },
                          { label: 'Viewer', value: 'viewer' },
                        ]}
                      />
                    </Form.Item>
                    <Button danger onClick={() => remove(name)}>Remove</Button>
                  </Space>
                ))}
                <Button block onClick={() => add({ ns: '', role: 'editor' })}>
                  Add membership
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  );
}
