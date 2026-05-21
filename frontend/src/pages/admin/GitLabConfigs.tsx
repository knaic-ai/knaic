import { useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Select, Space, Table } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import {
  createGitLabConfig,
  deleteGitLabConfig,
  patchGitLabConfig,
  type GitLabConfigDTO,
  type PatchGitLabConfigInput,
} from '@/api/aiStorage';
import {
  ensureGitLabConfigsLoaded,
  reloadGitLabConfigs,
  useAIStorageGitLabConfigs,
} from '@/data/aiStorage';

// Admin page: configure per-namespace GitLab access. Multiple configs per
// namespace are allowed so a single team can hold tokens for different
// GitLab groups; each lives in a Secret in the namespace.
export function GitLabConfigsPage() {
  const { namespace, namespaces, setNamespace } = useApp();
  const items = useAIStorageGitLabConfigs(namespace);
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false);
  // editing is the config currently being edited. When non-null the Edit
  // modal is open and pre-filled with its values; null means closed. Name
  // is immutable post-creation (it's the underlying Secret name), so it's
  // shown read-only.
  const [editing, setEditing] = useState<GitLabConfigDTO | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  useEffect(() => {
    ensureGitLabConfigsLoaded(namespace);
  }, [namespace]);

  // Refresh the form's initial values whenever the editing target
  // changes. Token is intentionally left blank — the API doesn't return
  // it, and we want a no-op edit to mean "metadata only, keep the token".
  useEffect(() => {
    if (!editing) return;
    editForm.setFieldsValue({
      url: editing.url,
      username: editing.username ?? '',
      token: '',
    });
  }, [editing, editForm]);

  return (
    <div className="knaic-page">
      <PageHeader
        title="Admin · GitLab Configs"
        description={
          <>
            GitLab address + personal access token, scoped to a single
            namespace. Users in that namespace can list/upload/download
            files in any project the token can reach.
          </>
        }
        extra={
          <Space>
            <Select
              size="small"
              value={namespace}
              onChange={setNamespace}
              options={namespaces.map(n => ({ label: n, value: n }))}
              style={{ width: 220 }}
            />
            <Button onClick={() => reloadGitLabConfigs(namespace)}>Refresh</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              New GitLab config
            </Button>
          </Space>
        }
      />
      <Table<GitLabConfigDTO>
        rowKey="name"
        size="middle"
        dataSource={items}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'URL', dataIndex: 'url', render: v => <span className="mono">{v}</span> },
          { title: 'Username', dataIndex: 'username', render: v => v || '—' },
          { title: 'Created', dataIndex: 'createdAt' },
          {
            title: 'Actions',
            width: 120,
            render: (_, r) => (
              <Space>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => setEditing(r)}
                />
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete GitLab config ${r.name}?`,
                      onOk: async () => {
                        try {
                          await deleteGitLabConfig(namespace, r.name);
                          message.success('GitLab config deleted');
                          await reloadGitLabConfigs(namespace);
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
        title="New GitLab config"
        onCancel={() => setOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await createGitLabConfig(namespace, {
              name: v.name,
              url: v.url,
              username: v.username,
              token: v.token,
            });
            setOpen(false);
            form.resetFields();
            message.success('GitLab config created');
            await reloadGitLabConfigs(namespace);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
        width={520}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Config name" rules={[{ required: true }]}>
            <Input placeholder="my-gitlab" />
          </Form.Item>
          <Form.Item name="url" label="GitLab URL" rules={[{ required: true }]}>
            <Input placeholder="https://gitlab.example.com" />
          </Form.Item>
          <Form.Item name="username" label="Username (optional)">
            <Input placeholder="me" />
          </Form.Item>
          <Form.Item name="token" label="Personal access token" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit modal — name is immutable so it's shown disabled. Token is
          left blank by default; only sent if the user types a new value
          (so saving without re-entering it is a metadata-only edit). */}
      <Modal
        open={!!editing}
        title={editing ? `Edit GitLab config · ${editing.name}` : ''}
        onCancel={() => setEditing(null)}
        destroyOnClose
        width={520}
        onOk={async () => {
          if (!editing) return;
          const v = await editForm.validateFields();
          // Build a sparse patch: only token is gated (because the backend
          // treats empty token as "keep current"). URL + username always
          // get sent so a user clearing the username field actually clears it.
          const patch: PatchGitLabConfigInput = {
            url: v.url ?? '',
            username: v.username ?? '',
          };
          if (v.token) patch.token = v.token;
          try {
            await patchGitLabConfig(namespace, editing.name, patch);
            message.success('GitLab config updated');
            setEditing(null);
            await reloadGitLabConfigs(namespace);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        {editing && (
          <Form form={editForm} layout="vertical" preserve={false}>
            <Form.Item label="Config name">
              <Input value={editing.name} disabled />
            </Form.Item>
            <Form.Item name="url" label="GitLab URL" rules={[{ required: true }]}>
              <Input placeholder="https://gitlab.example.com" />
            </Form.Item>
            <Form.Item name="username" label="Username (optional)">
              <Input placeholder="me" />
            </Form.Item>
            <Form.Item
              name="token"
              label="Personal access token"
              tooltip="Leave blank to keep the existing token. Type a new value to rotate."
            >
              <Input.Password placeholder="(leave blank to keep current)" autoComplete="new-password" />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  );
}
