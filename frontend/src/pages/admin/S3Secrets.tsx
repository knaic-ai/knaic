import { useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Select, Space, Switch, Table, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import {
  createS3Secret,
  deleteS3Secret,
  patchS3Secret,
  type PatchS3SecretInput,
  type S3SecretDTO,
} from '@/api/aiStorage';
import {
  ensureS3SecretsLoaded,
  reloadS3Secrets,
  useAIStorageS3Secrets,
} from '@/data/aiStorage';

// Admin page: configure S3 / S3-compatible credentials per namespace. The
// secrets we create are KServe-compatible (see
// https://kserve.github.io/website/docs/model-serving/storage/providers/s3)
// — they pair with optional ServiceAccounts so the storage-initializer can
// look them up by SA name at pod-spawn time.
export function S3SecretsPage() {
  const { namespace, namespaces, setNamespace } = useApp();
  const items = useAIStorageS3Secrets(namespace);
  const { message, modal } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  // editing is the secret currently being edited. When non-null the
  // Edit modal is open and pre-filled with its values; null means closed.
  // Name + Kind are immutable post-creation, so they're shown read-only.
  const [editing, setEditing] = useState<S3SecretDTO | null>(null);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  useEffect(() => {
    ensureS3SecretsLoaded(namespace);
  }, [namespace]);

  // When the editing target changes, refresh the form's initial values.
  // The modal is mounted with destroyOnClose so the form state resets
  // between opens regardless.
  useEffect(() => {
    if (!editing) return;
    editForm.setFieldsValue({
      endpoint: editing.endpoint,
      region: editing.region,
      useHttps: editing.useHttps,
      bucket: editing.bucket,
      accessKeyId: '',
      secretAccessKey: '',
    });
  }, [editing, editForm]);

  return (
    <div className="knaic-page">
      <PageHeader
        title="Admin · S3 Object Store Secrets"
        description={
          <>
            S3 / S3-compatible credentials, scoped to a single namespace.
            Workloads in that namespace can mount the listed ServiceAccount
            to authenticate. Layout follows the KServe storage-initializer
            convention.
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
            <Button onClick={() => reloadS3Secrets(namespace)}>Refresh</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              New S3 secret
            </Button>
          </Space>
        }
      />
      <Table<S3SecretDTO>
        rowKey="name"
        size="middle"
        dataSource={items}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          {
            title: 'Type',
            dataIndex: 'kind',
            render: v => <Tag color={v === 'aws' ? 'gold' : 'blue'}>{v === 'aws' ? 'AWS S3' : 'S3 Compatible'}</Tag>,
          },
          { title: 'Endpoint', dataIndex: 'endpoint', render: v => <span className="mono">{v || '—'}</span> },
          { title: 'Region', dataIndex: 'region', render: v => v || '—' },
          { title: 'Bucket', dataIndex: 'bucket', render: v => v || '—' },
          { title: 'HTTPS', dataIndex: 'useHttps', render: v => (v ? 'yes' : 'no') },
          { title: 'ServiceAccount', dataIndex: 'serviceAccount', render: v => v || '—' },
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
                      title: `Delete S3 secret ${r.name}?`,
                      content: 'Workloads referencing this secret will fail to fetch from S3 until re-created.',
                      onOk: async () => {
                        try {
                          await deleteS3Secret(namespace, r.name);
                          message.success('S3 secret deleted');
                          await reloadS3Secrets(namespace);
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

      {/* Create modal */}
      <Modal
        open={createOpen}
        title="New S3 secret"
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await createForm.validateFields();
          try {
            await createS3Secret(namespace, {
              name: v.name,
              kind: v.kind,
              endpoint: v.endpoint || '',
              region: v.region,
              useHttps: v.useHttps ?? true,
              bucket: v.bucket,
              accessKeyId: v.accessKeyId,
              secretAccessKey: v.secretAccessKey,
              serviceAccount: v.serviceAccount,
            });
            setCreateOpen(false);
            createForm.resetFields();
            message.success('S3 secret created');
            await reloadS3Secrets(namespace);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
        width={560}
      >
        <Form form={createForm} layout="vertical" preserve={false} initialValues={{ kind: 'compatible', useHttps: true }}>
          <Form.Item name="name" label="Secret name" rules={[{ required: true }]}>
            <Input placeholder="my-s3" />
          </Form.Item>
          <Form.Item name="kind" label="Type" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'AWS S3', value: 'aws' },
                { label: 'S3 Compatible (MinIO, Ceph, …)', value: 'compatible' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="endpoint"
            label="Endpoint"
            tooltip="Bare host:port for S3-compatible; AWS lets you leave blank to use the regional default."
          >
            <Input placeholder="minio.example.com:9000 or https://s3.us-east-1.amazonaws.com" />
          </Form.Item>
          <Form.Item name="region" label="Region">
            <Input placeholder="us-east-1" />
          </Form.Item>
          <Form.Item name="useHttps" label="Use HTTPS" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="bucket" label="Default bucket">
            <Input placeholder="my-bucket" />
          </Form.Item>
          <Form.Item name="accessKeyId" label="Access key ID" rules={[{ required: true }]}>
            <Input.Password placeholder="AKIA…" />
          </Form.Item>
          <Form.Item name="secretAccessKey" label="Secret access key" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="serviceAccount" label="ServiceAccount (optional)" tooltip="If set, the SA is created (or patched) so KServe can resolve this secret by SA name.">
            <Input placeholder="sa-s3" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit modal — name + kind are immutable so they're shown disabled.
          Access key / secret are left blank by default; only sent if the
          user types a new value (so saving without re-entering them is
          a metadata-only edit). */}
      <Modal
        open={!!editing}
        title={editing ? `Edit S3 secret · ${editing.name}` : ''}
        onCancel={() => setEditing(null)}
        destroyOnClose
        width={560}
        onOk={async () => {
          if (!editing) return;
          const v = await editForm.validateFields();
          // Build the patch with only the fields the user actually
          // changed. PatchS3SecretInput uses pointers on the wire so a
          // bare `null` means "leave alone", a value (including empty
          // string) means "set to this".
          const patch: PatchS3SecretInput = {
            endpoint: v.endpoint ?? '',
            region: v.region ?? '',
            useHttps: v.useHttps ?? false,
            bucket: v.bucket ?? '',
          };
          if (v.accessKeyId) patch.accessKeyId = v.accessKeyId;
          if (v.secretAccessKey) patch.secretAccessKey = v.secretAccessKey;
          try {
            await patchS3Secret(namespace, editing.name, patch);
            message.success('S3 secret updated');
            setEditing(null);
            await reloadS3Secrets(namespace);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        {editing && (
          <Form form={editForm} layout="vertical" preserve={false}>
            <Form.Item label="Secret name">
              <Input value={editing.name} disabled />
            </Form.Item>
            <Form.Item label="Type">
              <Input value={editing.kind === 'aws' ? 'AWS S3' : 'S3 Compatible'} disabled />
            </Form.Item>
            <Form.Item name="endpoint" label="Endpoint">
              <Input placeholder="minio.example.com:9000 or https://s3.us-east-1.amazonaws.com" />
            </Form.Item>
            <Form.Item name="region" label="Region">
              <Input placeholder="us-east-1" />
            </Form.Item>
            <Form.Item name="useHttps" label="Use HTTPS" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="bucket" label="Default bucket">
              <Input placeholder="my-bucket" />
            </Form.Item>
            <Form.Item
              name="accessKeyId"
              label="Access key ID"
              tooltip="Leave blank to keep the existing key. Type a new value to rotate."
            >
              <Input.Password placeholder="(leave blank to keep current)" autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="secretAccessKey"
              label="Secret access key"
              tooltip="Leave blank to keep the existing secret. Type a new value to rotate."
            >
              <Input.Password placeholder="(leave blank to keep current)" autoComplete="new-password" />
            </Form.Item>
            {editing.serviceAccount && (
              <Form.Item label="ServiceAccount">
                <Input value={editing.serviceAccount} disabled />
              </Form.Item>
            )}
          </Form>
        )}
      </Modal>
    </div>
  );
}
