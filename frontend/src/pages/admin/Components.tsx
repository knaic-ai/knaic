import { useEffect, useMemo, useState } from 'react';
import {
  Table,
  Tag,
  Button,
  Space,
  Select,
  App,
  Modal,
  Descriptions,
  Input,
  Form,
  Progress,
  Spin,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DownloadOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CloudDownloadOutlined,
  ImportOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  useComponents,
  installComponent,
  uninstallComponent,
  reconcileComponent,
  updateComponent,
  addImportedComponent,
  removeComponent,
  useRegistry,
  syncAllImages,
  ensureInitialLoad,
  ensureRegistryLoaded,
  loadFromApi,
  useComponentStatusLoading,
  type ComponentItem,
} from '@/data/components';
import { apiEnabled } from '@/api/client';
import { useApp } from '@/context/AppContext';
import { Link } from 'react-router-dom';

export function ComponentsPage() {
  const { user } = useApp();
  const { message, modal } = App.useApp();
  const components = useComponents();
  const statusLoading = useComponentStatusLoading();
  const registry = useRegistry();
  const [filter, setFilter] = useState('');
  const [detail, setDetail] = useState<ComponentItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    ensureInitialLoad();
    ensureRegistryLoaded();
    if (apiEnabled) {
      loadFromApi().catch(e => setLoadError((e as Error).message));
    }
  }, []);

  const filtered = useMemo(
    () =>
      components.filter(c =>
        (c.displayName + c.name + c.category).toLowerCase().includes(filter.toLowerCase()),
      ),
    [components, filter],
  );

  const syncPct = Math.round((registry.syncedImages / registry.totalImages) * 100);

  const columns: ColumnsType<ComponentItem> = [
    {
      title: 'Component',
      dataIndex: 'displayName',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Space>
            <a onClick={() => setDetail(r)} style={{ fontWeight: 600 }}>{r.displayName}</a>
            {!r.builtin && <Tag color="purple">imported</Tag>}
            {r.status === 'Installed' && r.managedBy && r.managedBy !== 'knaic' && (
              <Tag color="magenta">via {r.managedBy}</Tag>
            )}
          </Space>
          <span className="knaic-sub mono">{r.name}</span>
        </Space>
      ),
    },
    { title: 'Category', dataIndex: 'category', render: v => <Tag>{v}</Tag> },
    {
      title: 'Version',
      render: (_, r) => (
        <Select
          size="small"
          value={r.selectedVersion}
          onChange={v => updateComponent(r.name, { selectedVersion: v })}
          options={r.versions.map(v => ({ label: v, value: v }))}
          style={{ width: 140 }}
          disabled={r.status === 'Installed' || r.status === 'Installing'}
        />
      ),
    },
    { title: 'Namespace', dataIndex: 'namespace' },
    {
      title: 'Status',
      dataIndex: 'status',
      render: (v, r) => (
        <Space size={6}>
          <StatusTag value={v} />
          {statusLoading.has(r.name) && <Spin size="small" />}
        </Space>
      ),
    },
    {
      title: 'Images synced',
      dataIndex: 'imageSync',
      render: v => <StatusTag value={v === 'Synced' ? 'Succeeded' : v === 'Pending' ? 'Progressing' : v} />,
    },
    {
      title: 'Actions',
      width: 280,
      render: (_, r) => {
        if (r.status === 'Installed') {
          // Components installed by anything other than knaic stay visible
          // but offer no actions — knaic refuses to mutate something it
          // doesn't own.
          if (r.managedBy && r.managedBy !== 'knaic') {
            return <span className="knaic-sub">unmanaged · {r.managedBy}</span>;
          }
          return (
            <Space>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={async () => {
                  try {
                    message.info(`Reconciling ${r.displayName}`);
                    await reconcileComponent(r.name);
                  } catch (e) {
                    message.error((e as Error).message);
                  }
                }}
              >
                Reconcile
              </Button>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() =>
                  modal.confirm({
                    title: `Uninstall ${r.displayName}?`,
                    onOk: async () => {
                      try {
                        await uninstallComponent(r.name);
                        message.success(`${r.displayName} uninstalled`);
                      } catch (e) {
                        message.error((e as Error).message);
                      }
                    },
                  })
                }
              >
                Uninstall
              </Button>
              {!r.builtin && (
                <Button
                  size="small"
                  danger
                  onClick={() =>
                    modal.confirm({
                      title: `Remove chart ${r.displayName} from knaic?`,
                      onOk: async () => {
                        try {
                          await removeComponent(r.name);
                        } catch (e) {
                          message.error((e as Error).message);
                        }
                      },
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </Space>
          );
        }
        return (
          <Space>
            <Button
              size="small"
              type="primary"
              icon={<CloudDownloadOutlined />}
              loading={r.status === 'Installing'}
              onClick={async () => {
                message.info(`Installing ${r.displayName} ${r.selectedVersion} to ${r.namespace}`);
                try {
                  await installComponent(r.name);
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              Install
            </Button>
            {!r.builtin && (
              <Button
                size="small"
                danger
                onClick={async () => {
                  try {
                    await removeComponent(r.name);
                  } catch (e) {
                    message.error((e as Error).message);
                  }
                }}
              >
                Remove
              </Button>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div className="knaic-page">
      <PageHeader
        title="Admin · Components"
        description="Helm-chart packaged dependencies. The backend can detect components already installed via OLM or manual means and mark them Unmanaged."
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder="Filter components"
              onChange={e => setFilter(e.target.value)}
              style={{ width: 220 }}
            />
            <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
              Import Helm chart
            </Button>
            <Button
              icon={<DownloadOutlined />}
              onClick={async () => {
                try {
                  await syncAllImages();
                  message.success('Synced all images to registry');
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              Sync all images
            </Button>
          </Space>
        }
      />
      <div className="knaic-banner">
        <Space wrap size={16}>
          <span>
            <b>Image registry:</b> <span className="mono">{registry.endpoint}/{registry.project}</span>
            {registry.useBuiltin && <Tag color="blue" style={{ marginLeft: 8 }}>built-in</Tag>}
          </span>
          <Space>
            <span>Sync</span>
            <Progress percent={syncPct} size="small" style={{ width: 160 }} />
            <span className="mono">{registry.syncedImages}/{registry.totalImages}</span>
          </Space>
          <Space>
            <span>Disk</span>
            <Progress percent={Math.round((registry.diskUsageGi / registry.capacityGi) * 100)} size="small" style={{ width: 120 }} />
            <span className="mono">{registry.diskUsageGi} / {registry.capacityGi} GiB</span>
          </Space>
          <Link to="/admin/registry">Configure →</Link>
        </Space>
      </div>

      {loadError && (
        <Tag color="error" style={{ marginBottom: 8 }}>
          Backend unreachable — showing cached catalog. ({loadError})
        </Tag>
      )}
      {!user.isPlatformAdmin && (
        <Tag color="warning" style={{ marginBottom: 8 }}>
          View-only — platform admin role required to install or modify components.
        </Tag>
      )}
      <Table
        rowKey="name"
        columns={columns}
        dataSource={filtered}
        size="middle"
        pagination={{ pageSize: 20 }}
      />

      <Modal
        open={!!detail}
        onCancel={() => setDetail(null)}
        title={detail?.displayName}
        width={720}
        footer={null}
        destroyOnClose
      >
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Chart name">{detail.name}</Descriptions.Item>
            <Descriptions.Item label="Category">{detail.category}</Descriptions.Item>
            <Descriptions.Item label="Description">{detail.description}</Descriptions.Item>
            <Descriptions.Item label="Install namespace">{detail.namespace}</Descriptions.Item>
            <Descriptions.Item label="Versions available">{detail.versions.join(', ')}</Descriptions.Item>
            <Descriptions.Item label="Managed by">{detail.managedBy ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag value={detail.status} /></Descriptions.Item>
            {detail.notes && <Descriptions.Item label="Notes">{detail.notes}</Descriptions.Item>}
            <Descriptions.Item label="Images">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {detail.images.map(i => (
                  <li key={i} className="mono">{i}</li>
                ))}
              </ul>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>

      <Modal
        open={importOpen}
        title="Import Helm chart"
        onCancel={() => setImportOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await addImportedComponent({
              name: v.name,
              displayName: v.displayName ?? v.name,
              description: v.description ?? 'Imported Helm chart',
              category: v.category,
              versions: [v.version],
              selectedVersion: v.version,
              status: 'NotInstalled',
              namespace: v.namespace ?? 'knaic-system',
              images: (v.images as string).split('\n').map(s => s.trim()).filter(Boolean),
              imageSync: 'Pending',
            });
            setImportOpen(false);
            form.resetFields();
            message.success(`Imported chart ${v.name}`);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Chart name" rules={[{ required: true }]}>
            <Input placeholder="my-operator" />
          </Form.Item>
          <Form.Item name="displayName" label="Display name">
            <Input placeholder="My Operator" />
          </Form.Item>
          <Form.Item name="version" label="Version" rules={[{ required: true }]}>
            <Input placeholder="1.0.0" />
          </Form.Item>
          <Form.Item name="category" label="Category" initialValue="Inference" rules={[{ required: true }]}>
            <Select
              options={['Inference', 'Training', 'GPU', 'Networking', 'Observability', 'Notebook', 'Scheduling', 'Experiment'].map(c => ({ label: c, value: c }))}
            />
          </Form.Item>
          <Form.Item name="namespace" label="Install namespace" initialValue="knaic-system">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item
            name="images"
            label="Images (one per line)"
            help="These will be mirrored to the built-in image registry."
          >
            <Input.TextArea rows={3} placeholder="registry.example.com/my-operator:1.0.0" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
