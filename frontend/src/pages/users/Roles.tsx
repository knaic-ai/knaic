import { useEffect, useMemo, useState } from 'react';
import { Card, Row, Col, Table, Button, Space, App, Modal, Form, Input, Select, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import {
  ensureBindingsLoaded,
  ensureRolesLoaded,
  ensureUsersLoaded,
  removeBinding,
  removeRole,
  saveBinding,
  saveRole,
  useBindings,
  useRoles,
  useUsers,
  type Role,
  type RoleBinding,
} from '@/data/users';
import { useApp } from '@/context/AppContext';

const VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];
const GROUPS = ['', 'apps', 'batch', 'serving.kserve.io', 'trainer.kubeflow.org', 'kubeflow.org', '*'];

function parseRuleList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(s => s.trim()).filter(Boolean);
  return (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

export function RolesPage() {
  const { namespace, user } = useApp();
  const { message, modal } = App.useApp();
  const roles = useRoles();
  const bindings = useBindings();
  const users = useUsers();

  const nsRoles = useMemo(() => roles.filter(r => r.namespace === namespace), [roles, namespace]);
  const nsBindings = useMemo(() => bindings.filter(b => b.namespace === namespace), [bindings, namespace]);

  const [roleOpen, setRoleOpen] = useState(false);
  const [bindingOpen, setBindingOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [editingBinding, setEditingBinding] = useState<RoleBinding | null>(null);
  const [roleForm] = Form.useForm();
  const [bindingForm] = Form.useForm();

  useEffect(() => {
    ensureUsersLoaded();
    ensureRolesLoaded(namespace);
    ensureBindingsLoaded(namespace);
  }, [namespace]);

  return (
    <div className="knaic-page">
      <PageHeader
        title="Roles & Role bindings"
        description={`Kubernetes RBAC in namespace ${namespace}. Cluster admins and namespace admins can modify these.`}
      />
      <Row gutter={12}>
        <Col span={12}>
          <Card
            title="Roles"
            size="small"
            extra={
              <Button
                type="link"
                icon={<PlusOutlined />}
                onClick={() => {
                  setEditingRole(null);
                  roleForm.resetFields();
                  setRoleOpen(true);
                }}
              >
                New role
              </Button>
            }
          >
            <Table
              rowKey="id"
              size="small"
              dataSource={nsRoles}
              pagination={false}
              columns={[
                { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
                { title: 'Kind', dataIndex: 'kind', render: v => <Tag>{v}</Tag> },
                { title: 'Rules', dataIndex: 'rules', render: v => `${v.length}` },
                {
                  title: '',
                  width: 110,
                  render: (_, r) => (
                    <Space>
                      <Button
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => {
                          setEditingRole(r);
                          roleForm.setFieldsValue({
                            name: r.name,
                            kind: r.kind,
                            rules: r.rules.map(x => ({
                              apiGroups: x.apiGroups,
                              resources: x.resources.join(','),
                              verbs: x.verbs,
                            })),
                          });
                          setRoleOpen(true);
                        }}
                      />
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() =>
                          modal.confirm({
                            title: `Delete role ${r.name}?`,
                            onOk: async () => {
                              try {
                                await removeRole(namespace, r.kind, r.name, r.id);
                                message.success('Role deleted');
                              } catch (err) {
                                message.error(err instanceof Error ? err.message : 'Failed to delete role');
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
              expandable={{
                expandedRowRender: r => (
                  <Table
                    size="small"
                    pagination={false}
                    rowKey={(_, i) => String(i)}
                    dataSource={r.rules}
                    columns={[
                      { title: 'apiGroups', dataIndex: 'apiGroups', render: (v: string[]) => v.join(',') || '""' },
                      { title: 'resources', dataIndex: 'resources', render: (v: string[]) => v.join(',') },
                      { title: 'verbs', dataIndex: 'verbs', render: (v: string[]) => v.join(',') },
                    ]}
                  />
                ),
              }}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title="Role bindings"
            size="small"
            extra={
              <Button
                type="link"
                icon={<PlusOutlined />}
                onClick={() => {
                  setEditingBinding(null);
                  bindingForm.resetFields();
                  setBindingOpen(true);
                }}
              >
                New binding
              </Button>
            }
          >
            <Table
              rowKey="id"
              size="small"
              dataSource={nsBindings}
              pagination={false}
              columns={[
                { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
                { title: 'Role', render: (_, r) => `${r.roleRef.kind}/${r.roleRef.name}` },
                {
                  title: 'Subjects',
                  render: (_, r) => (
                    <Space wrap size={4}>
                      {r.subjects.map(s => (
                        <Tag key={s.name}>{s.kind}:{s.name}</Tag>
                      ))}
                    </Space>
                  ),
                },
                {
                  title: '',
                  width: 110,
                  render: (_, r) => (
                    <Space>
                      <Button
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => {
                          setEditingBinding(r);
                          bindingForm.setFieldsValue({
                            name: r.name,
                            roleRef: `${r.roleRef.kind}:${r.roleRef.name}`,
                            users: r.subjects.filter(s => s.kind === 'User').map(s => s.name),
                          });
                          setBindingOpen(true);
                        }}
                      />
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() =>
                          modal.confirm({
                            title: `Delete binding ${r.name}?`,
                            onOk: async () => {
                              try {
                                await removeBinding(namespace, r.name, r.id);
                                message.success('Binding deleted');
                              } catch (err) {
                                message.error(err instanceof Error ? err.message : 'Failed to delete binding');
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
          </Card>
        </Col>
      </Row>

      <Modal
        open={roleOpen}
        title={editingRole ? `Edit role ${editingRole.name}` : 'New role'}
        width={720}
        onCancel={() => setRoleOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await roleForm.validateFields();
          const rules = (v.rules ?? []).map((r: { apiGroups: string | string[]; resources: string; verbs: string[] }) => ({
            apiGroups: parseRuleList(r.apiGroups),
            resources: parseRuleList(r.resources),
            verbs: r.verbs,
          }));
          try {
            await saveRole(namespace, {
              name: v.name,
              kind: v.kind ?? 'Role',
              rules,
            });
            message.success(editingRole ? 'Role updated' : 'Role created');
            setRoleOpen(false);
            roleForm.resetFields();
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to save role');
          }
        }}
      >
        <Form form={roleForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input disabled={!!editingRole} />
          </Form.Item>
          <Form.Item name="kind" label="Kind" initialValue="Role">
            <Select
              disabled={!user.isPlatformAdmin}
              options={[
                { label: 'Role', value: 'Role' },
                { label: 'ClusterRole', value: 'ClusterRole' },
              ]}
            />
          </Form.Item>
          <Form.List name="rules" initialValue={[{ apiGroups: [], resources: '', verbs: ['get', 'list'] }]}>
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name }) => (
                  <Card key={key} size="small" style={{ marginBottom: 8 }}>
                    <Space align="start" style={{ width: '100%' }}>
                      <Form.Item name={[name, 'apiGroups']} label="apiGroups" rules={[{ required: true }]}>
                        <Select
                          mode="tags"
                          style={{ minWidth: 160 }}
                          options={GROUPS.map(g => ({ label: g || '""', value: g }))}
                        />
                      </Form.Item>
                      <Form.Item name={[name, 'resources']} label="resources" rules={[{ required: true }]}>
                        <Input style={{ minWidth: 200 }} placeholder="pods, deployments" />
                      </Form.Item>
                      <Form.Item name={[name, 'verbs']} label="verbs" rules={[{ required: true }]}>
                        <Select mode="multiple" options={VERBS.concat('*').map(v => ({ label: v, value: v }))} style={{ minWidth: 200 }} />
                      </Form.Item>
                      <Button danger onClick={() => remove(name)} icon={<DeleteOutlined />} style={{ marginTop: 28 }} />
                    </Space>
                  </Card>
                ))}
                <Button block icon={<PlusOutlined />} onClick={() => add({ apiGroups: [], resources: '', verbs: ['get'] })}>
                  Add rule
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Modal
        open={bindingOpen}
        title={editingBinding ? `Edit binding ${editingBinding.name}` : 'New role binding'}
        onCancel={() => setBindingOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await bindingForm.validateFields();
          const [kind, roleName] = (v.roleRef as string).split(':') as ['Role' | 'ClusterRole', string];
          const subjects = (v.users as string[]).map(n => ({ kind: 'User' as const, name: n }));
          try {
            await saveBinding(namespace, {
              name: v.name,
              roleRef: { kind, name: roleName },
              subjects,
            });
            message.success(editingBinding ? 'Binding updated' : 'Binding created');
            setBindingOpen(false);
            bindingForm.resetFields();
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to save binding');
          }
        }}
      >
        <Form form={bindingForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input disabled={!!editingBinding} />
          </Form.Item>
          <Form.Item name="roleRef" label="Role" rules={[{ required: true }]}>
            <Select
              options={nsRoles.map(r => ({ label: `${r.kind}/${r.name}`, value: `${r.kind}:${r.name}` }))}
            />
          </Form.Item>
          <Form.Item name="users" label="Users" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              options={users.map(u => ({ label: `${u.name} (${u.email})`, value: u.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
