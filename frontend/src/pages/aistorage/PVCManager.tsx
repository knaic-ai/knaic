import { useEffect, useState } from 'react';
import { App, Button, Dropdown, Form, Input, Modal, Select, Space, Spin, Table, Tag } from 'antd';
import {
  DeleteOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { RegisterAsModelModal } from '@/pages/models/RegisterAsModelModal';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import {
  createAIStoragePVC,
  deleteAIStoragePVC,
  pvcViewerGrant,
  pvcViewerStart,
  pvcViewerStop,
  pvcViewerUrl,
  type PVCEntryDTO,
} from '@/api/aiStorage';
import {
  ensurePVCsLoadedForAIStorage,
  reloadAIStoragePVCs,
  useAIStoragePVCs,
} from '@/data/aiStorage';

// AI Storage · PVC manager: create/list/delete PVCs and spin up a per-PVC
// filebrowser Deployment.
//
// UX contract:
//   - "Start viewer" returns immediately; the row reflects "starting"
//     until the backend reports ready. We don't block the user behind a
//     spinner, and we don't pop the viewer modal automatically.
//   - As long as any row is in the "starting" state, we poll the list
//     in the background (~2s) so the row flips to "ready" without the
//     user clicking Refresh.
//   - When a row is "ready", an explicit "Open viewer" button appears
//     so the iframe only loads on user intent.
//   - Start / Stop / Delete are bundled into one overflow menu — keeps
//     the actions column narrow and prevents accidental Delete clicks.
export function PVCManagerPage() {
  const { namespace } = useApp();
  const pvcs = useAIStoragePVCs(namespace);
  const { message, modal } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  // viewer is the PVC whose iframe is currently being shown in a modal.
  // Only set when the user clicks "Open viewer" on a ready PVC; never
  // auto-opened during start-up.
  const [openPVC, setOpenPVC] = useState<string | null>(null);
  // viewerReady tracks whether the grant cookie has been minted for the
  // currently-open PVC. The iframe only mounts once this is true so the
  // first request from the iframe carries the cookie.
  const [viewerReady, setViewerReady] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  // Register-as-model modal target. Held here (instead of opened from
  // the menu item) so the modal lives outside the per-row render and
  // doesn't unmount when the menu closes.
  const [registerTarget, setRegisterTarget] = useState<
    { uri: string; name: string } | null
  >(null);

  useEffect(() => {
    ensurePVCsLoadedForAIStorage(namespace);
  }, [namespace]);

  // Background poll: while any PVC has viewer === 'running' (i.e. the
  // Deployment is up but no replica is ready yet), re-fetch the list
  // every 2s so the row transitions to 'ready' on its own. We re-run
  // the effect when the list shape changes — once everything settles to
  // 'ready' or '', the interval clears itself and we stop hammering the
  // API.
  useEffect(() => {
    const anyStarting = pvcs.some(p => p.viewer === 'running');
    if (!anyStarting) return;
    const handle = setInterval(() => {
      void reloadAIStoragePVCs(namespace);
    }, 2000);
    return () => clearInterval(handle);
  }, [namespace, pvcs]);

  const start = async (pvc: string) => {
    setActing(pvc);
    try {
      // Fire-and-forget from the user's point of view: backend creates
      // the Deployment + Service synchronously, but the container takes
      // a few seconds to become Ready. The background polling effect
      // above will flip the row from 'starting' to 'ready' when it is.
      await pvcViewerStart(namespace, pvc);
      message.success(`Viewer starting for ${pvc}`);
      // Trigger an immediate reload so the row shows "starting" even
      // before the next poll tick.
      void reloadAIStoragePVCs(namespace);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActing(null);
    }
  };

  // open mints a path-scoped grant cookie via the backend, then opens
  // the iframe modal. Without the cookie, the iframe's first request
  // would 401 — `<iframe src>` requests don't carry our bearer header.
  const open = async (pvc: string) => {
    setOpenPVC(pvc);
    setViewerReady(false);
    try {
      await pvcViewerGrant(namespace, pvc);
      setViewerReady(true);
    } catch (e) {
      message.error((e as Error).message);
      setOpenPVC(null);
    }
  };

  const stop = async (pvc: string) => {
    setActing(pvc);
    try {
      await pvcViewerStop(namespace, pvc);
      message.success('Viewer stopped');
      if (openPVC === pvc) setOpenPVC(null);
      await reloadAIStoragePVCs(namespace);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActing(null);
    }
  };

  const remove = (pvc: string) => {
    modal.confirm({
      title: `Delete PVC ${pvc}?`,
      content: 'The viewer Deployment (if any) is stopped first; the PV will be released per the StorageClass reclaim policy.',
      onOk: async () => {
        try {
          await deleteAIStoragePVC(namespace, pvc);
          message.success('PVC deleted');
          if (openPVC === pvc) setOpenPVC(null);
          await reloadAIStoragePVCs(namespace);
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="AI Storage · PVC manager"
        description={`PersistentVolumeClaims in namespace "${namespace}". Start a per-PVC file browser to view/upload/download/delete files in the volume.`}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => reloadAIStoragePVCs(namespace)}>Refresh</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>New PVC</Button>
          </Space>
        }
      />
      <Table<PVCEntryDTO>
        rowKey="name"
        size="middle"
        dataSource={pvcs}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'StorageClass', dataIndex: 'storageClass', render: v => v || '—' },
          { title: 'Capacity', dataIndex: 'capacity' },
          { title: 'Access mode', dataIndex: 'accessMode', render: v => v || '—' },
          {
            title: 'Phase',
            dataIndex: 'phase',
            render: (v: string) => <Tag color={v === 'Bound' ? 'green' : v === 'Pending' ? 'gold' : 'default'}>{v || '—'}</Tag>,
          },
          {
            title: 'Viewer',
            dataIndex: 'viewer',
            width: 110,
            render: (v: string | undefined) => {
              if (v === 'ready') return <Tag color="green">ready</Tag>;
              if (v === 'running') return <Tag color="blue">starting</Tag>;
              return <Tag>—</Tag>;
            },
          },
          { title: 'Created', dataIndex: 'createdAt' },
          {
            title: 'Actions',
            width: 180,
            render: (_, r) => {
              // The action menu shows the operations that make sense
              // for the current viewer state. Delete is always present
              // (and confirmed) so it can't be hit by accident through
              // the overflow menu.
              // r.viewer can be undefined (omitempty on the Go side strips
              // the field entirely when no viewer is running), 'running',
              // or 'ready' — never literal '' over the wire.
              const items = [
                ...(!r.viewer
                  ? [{
                      key: 'start',
                      icon: <PlayCircleOutlined />,
                      label: 'Start viewer',
                      onClick: () => start(r.name),
                    }]
                  : []),
                ...(r.viewer === 'running' || r.viewer === 'ready'
                  ? [{
                      key: 'stop',
                      icon: <StopOutlined />,
                      label: 'Stop viewer',
                      onClick: () => stop(r.name),
                    }]
                  : []),
                {
                  key: 'register',
                  icon: <SaveOutlined />,
                  label: 'Register as private model',
                  // KServe consumes pvc://<pvc-name>/<sub-path>; rendering
                  // the trailing slash (with empty path) makes the modal's
                  // pre-filled URI obviously editable for the user to add
                  // a path to their model files inside the PVC.
                  onClick: () =>
                    setRegisterTarget({
                      uri: `pvc://${r.name}/`,
                      name: r.name,
                    }),
                },
                { type: 'divider' as const },
                {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  label: 'Delete PVC',
                  danger: true,
                  onClick: () => remove(r.name),
                },
              ];
              return (
                <Space>
                  {r.viewer === 'ready' && (
                    <Button
                      size="small"
                      type="primary"
                      icon={<FolderOpenOutlined />}
                      onClick={() => open(r.name)}
                    >
                      Open viewer
                    </Button>
                  )}
                  <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
                    <Button size="small" icon={<MoreOutlined />} loading={acting === r.name} />
                  </Dropdown>
                </Space>
              );
            },
          },
        ]}
      />
      <Modal
        open={createOpen}
        title="New PVC"
        destroyOnClose
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await createAIStoragePVC(namespace, {
              name: v.name,
              storageClass: v.storageClass,
              capacity: v.capacity,
              accessMode: v.accessMode,
            });
            setCreateOpen(false);
            form.resetFields();
            message.success('PVC created');
            await reloadAIStoragePVCs(namespace);
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="storageClass" label="StorageClass"><Input placeholder="leave blank for cluster default" /></Form.Item>
          <Form.Item name="capacity" label="Capacity" initialValue="20Gi" rules={[{ required: true }]}>
            <Input placeholder="20Gi" />
          </Form.Item>
          <Form.Item name="accessMode" label="Access mode" initialValue="ReadWriteOnce">
            <Select
              options={[
                { label: 'ReadWriteOnce (RWO)', value: 'ReadWriteOnce' },
                { label: 'ReadWriteMany (RWX)', value: 'ReadWriteMany' },
                { label: 'ReadOnlyMany (ROX)', value: 'ReadOnlyMany' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        open={!!openPVC}
        title={openPVC ? `Files in PVC ${openPVC}` : ''}
        width="80%"
        styles={{ body: { height: '70vh', padding: 0 } }}
        footer={null}
        onCancel={() => { setOpenPVC(null); setViewerReady(false); }}
        destroyOnClose
      >
        {openPVC && (viewerReady ? (
          <iframe
            title={`pvc-${openPVC}`}
            src={pvcViewerUrl(namespace, openPVC)}
            style={{ border: 0, width: '100%', height: '100%' }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Space direction="vertical" align="center">
              <Spin />
              <span>Preparing viewer for {openPVC}…</span>
            </Space>
          </div>
        ))}
      </Modal>
      <RegisterAsModelModal
        open={!!registerTarget}
        uri={registerTarget?.uri ?? ''}
        suggestedName={registerTarget?.name}
        sourceLabel="PVC"
        onClose={() => setRegisterTarget(null)}
        onCreated={() => setRegisterTarget(null)}
      />
    </div>
  );
}
