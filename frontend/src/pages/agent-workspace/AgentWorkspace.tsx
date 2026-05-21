// Per-user Codex Web workspace. Mirrors the cpea Agent Workspace view:
// embeds the iframe under /api/v1/me/workspace/proxy/, polls the backend
// while the pod is rolling, and exposes Restart + Resize actions in the page
// toolbar. Provisioning is implicit — the first GET 404 triggers a POST
// /me/workspace that creates the Deployment + Service + PVC.

import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Form, Input, Modal, Space, Spin } from 'antd';
import { ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  type AgentWorkspace,
  type ResourceUpdate,
  getOrCreateUserWorkspace,
  getUserWorkspace,
  grantWorkspaceProxy,
  proxyURL,
  restartWorkspace,
  updateWorkspaceResources,
} from '@/api/agentWorkspace';
import { ApiError } from '@/api/client';

type Phase = 'init' | 'starting' | 'ready' | 'unavailable' | 'error';

function phaseForStatus(status: string): Phase {
  switch (status) {
    case 'Running':
      return 'ready';
    case 'Starting':
      return 'starting';
    case 'Pending':
    case 'Stopped':
    case 'Failed':
    case 'Degraded':
      return 'unavailable';
    default:
      return status ? 'starting' : 'init';
  }
}

export function AgentWorkspacePage() {
  const { message } = App.useApp();
  const [workspace, setWorkspace] = useState<AgentWorkspace | null>(null);
  const [phase, setPhase] = useState<Phase>('init');
  const [error, setError] = useState('');
  // Bump on restart / resource change so the iframe fully remounts — keeping
  // the cached one through a pod restart strands the user on whatever the
  // proxy returned mid-roll (often 502).
  const [generation, setGeneration] = useState(0);
  const [resizeOpen, setResizeOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // Iframe-only auth gate. `<iframe src=...>` can't carry the Authorization
  // header, so before rendering we trade the bearer for an HttpOnly cookie
  // scoped to /api/v1/me/workspace/proxy/. Until that's been minted, hold
  // the iframe behind the "Starting…" placeholder.
  const [grantReady, setGrantReady] = useState(false);
  const cancelled = useRef(false);

  const apply = useCallback((ws: AgentWorkspace) => {
    setWorkspace(ws);
    setPhase(phaseForStatus(ws.status));
    setError('');
  }, []);

  const ensure = useCallback(async () => {
    try {
      const ws = await getOrCreateUserWorkspace();
      if (cancelled.current) return;
      apply(ws);
    } catch (err) {
      if (cancelled.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
      setPhase('error');
    }
  }, [apply]);

  const refresh = useCallback(async () => {
    try {
      const ws = await getUserWorkspace();
      if (cancelled.current) return;
      apply(ws);
    } catch (err) {
      if (cancelled.current) return;
      // A 404 mid-life means the workspace was deleted underneath us; flip
      // back to init and re-provision on the next poll cycle.
      if (err instanceof ApiError && err.status === 404) {
        setPhase('init');
        void ensure();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to refresh workspace');
      setPhase('error');
    }
  }, [apply, ensure]);

  // Initial provisioning / fetch.
  useEffect(() => {
    cancelled.current = false;
    void ensure();
    return () => {
      cancelled.current = true;
    };
  }, [ensure]);

  // Poll every 3s while reconciling. Stops on ready / error.
  useEffect(() => {
    if (phase === 'ready' || phase === 'error') return;
    const id = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => window.clearInterval(id);
  }, [phase, refresh]);

  // Mint the proxy grant cookie when the workspace is ready, and re-mint
  // every 9 minutes (cookie expires at 10). Cleared on unmount.
  useEffect(() => {
    if (phase !== 'ready') {
      setGrantReady(false);
      return;
    }
    let cancelledLocal = false;
    const mint = async () => {
      try {
        await grantWorkspaceProxy();
        if (!cancelledLocal) setGrantReady(true);
      } catch (err) {
        if (cancelledLocal) return;
        setError(err instanceof Error ? err.message : 'Failed to obtain proxy grant');
        setPhase('error');
      }
    };
    void mint();
    const id = window.setInterval(() => void mint(), 9 * 60 * 1000);
    return () => {
      cancelledLocal = true;
      window.clearInterval(id);
    };
  }, [phase]);

  const handleRestart = async () => {
    setRestarting(true);
    setPhase('starting');
    setGeneration(g => g + 1);
    try {
      const ws = await restartWorkspace();
      apply({ ...ws, status: 'Starting' });
      message.success('Workspace restarting');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restart failed');
      setPhase('error');
    } finally {
      setRestarting(false);
    }
  };

  const handleResize = async (spec: ResourceUpdate) => {
    setResizing(true);
    setPhase('starting');
    setGeneration(g => g + 1);
    try {
      const ws = await updateWorkspaceResources(spec);
      apply({ ...ws, status: 'Starting' });
      setResizeOpen(false);
      message.success('Resources updated; pod rolling');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resource update failed');
      setPhase('error');
    } finally {
      setResizing(false);
    }
  };

  const headerExtra = (
    <Space>
      <Button
        icon={<SettingOutlined />}
        disabled={phase === 'init' || phase === 'error'}
        onClick={() => setResizeOpen(true)}
      >
        Resize
      </Button>
      <Button
        icon={<ReloadOutlined />}
        loading={restarting}
        disabled={phase === 'init' || phase === 'error'}
        onClick={handleRestart}
      >
        Restart
      </Button>
    </Space>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title={
          <Space>
            <span>Agent Workspace</span>
            {workspace && <StatusTag value={workspace.status} />}
          </Space>
        }
        description={
          workspace ? (
            <span>
              <code>{workspace.name}</code> · {workspace.namespace} · {workspace.storage}
            </span>
          ) : (
            'Provisioning your personal Codex Web instance on first visit.'
          )
        }
        extra={headerExtra}
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <WorkspaceBody
          phase={phase}
          workspace={workspace}
          error={error}
          generation={generation}
          grantReady={grantReady}
        />
      </div>
      <ResizeModal
        open={resizeOpen}
        workspace={workspace}
        loading={resizing}
        onCancel={() => setResizeOpen(false)}
        onSubmit={handleResize}
      />
    </div>
  );
}

interface BodyProps {
  phase: Phase;
  workspace: AgentWorkspace | null;
  error: string;
  generation: number;
  grantReady: boolean;
}

function WorkspaceBody({ phase, workspace, error, generation, grantReady }: BodyProps) {
  if (phase === 'error') {
    return (
      <Placeholder
        title="Couldn't open the agent workspace"
        body={error}
        hint="Use the Restart button above, or contact your cluster admin if the issue persists."
        tone="error"
      />
    );
  }
  if (phase === 'init') {
    return (
      <Placeholder
        spinning
        title="Preparing your agent workspace…"
        body="Provisioning a persistent volume and the Codex Web container."
      />
    );
  }
  if (phase === 'starting') {
    return (
      <Placeholder
        spinning
        title="Starting workspace pod…"
        body={
          <span>
            {workspace?.name && <code>{workspace.name}</code>} is rolling out. This usually takes 15–40
            seconds.
          </span>
        }
      />
    );
  }
  if (phase === 'unavailable') {
    return (
      <Placeholder
        title="Workspace is unavailable"
        body={
          <span>
            {workspace?.name && <code>{workspace.name}</code>} is in state{' '}
            <strong>{workspace?.status || 'unknown'}</strong>. The pod isn't ready to serve requests.
          </span>
        }
        hint="Use the Restart button above, or check the pod via the Containers view if it keeps failing."
        tone="warn"
      />
    );
  }
  if (!grantReady) {
    return <Placeholder spinning title="Authorizing iframe…" body="Minting a short-lived proxy cookie." />;
  }
  return (
    <iframe
      key={generation}
      src={proxyURL()}
      title="Codex Web"
      style={{ flex: 1, border: 0, width: '100%', height: '100%', background: '#fff' }}
    />
  );
}

interface PlaceholderProps {
  title: string;
  body?: React.ReactNode;
  hint?: string;
  spinning?: boolean;
  tone?: 'default' | 'warn' | 'error';
}

function Placeholder({ title, body, hint, spinning, tone = 'default' }: PlaceholderProps) {
  const borderColor = tone === 'error' ? '#ff4d4f' : tone === 'warn' ? '#faad14' : 'var(--knaic-border, #d9d9d9)';
  return (
    <div
      style={{
        margin: 'auto',
        maxWidth: 460,
        padding: '32px 28px',
        textAlign: 'center',
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        background: 'var(--knaic-surface, #fff)',
      }}
    >
      {spinning && (
        <div style={{ marginBottom: 16 }}>
          <Spin />
        </div>
      )}
      <h3 style={{ margin: '8px 0 12px' }}>{title}</h3>
      {body && <div style={{ color: 'var(--knaic-muted, #666)' }}>{body}</div>}
      {hint && <div style={{ marginTop: 12, color: 'var(--knaic-muted, #888)', fontSize: 12 }}>{hint}</div>}
    </div>
  );
}

interface ResizeModalProps {
  open: boolean;
  workspace: AgentWorkspace | null;
  loading: boolean;
  onCancel: () => void;
  onSubmit: (spec: ResourceUpdate) => void;
}

function ResizeModal({ open, workspace, loading, onCancel, onSubmit }: ResizeModalProps) {
  const [form] = Form.useForm<ResourceUpdate>();

  // Pre-fill the storage value from the workspace so users can see what
  // they're growing from. Quantities other than storage aren't surfaced
  // through the API today, so we leave them blank for "no change".
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ storage: workspace?.storage });
    }
  }, [open, workspace, form]);

  return (
    <Modal
      title="Resize workspace"
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={loading}
      okText="Apply"
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={values => {
          const spec: ResourceUpdate = {};
          if (values.cpuRequest) spec.cpuRequest = values.cpuRequest;
          if (values.cpuLimit) spec.cpuLimit = values.cpuLimit;
          if (values.memoryRequest) spec.memoryRequest = values.memoryRequest;
          if (values.memoryLimit) spec.memoryLimit = values.memoryLimit;
          if (values.storage) spec.storage = values.storage;
          onSubmit(spec);
        }}
      >
        <Form.Item name="cpuRequest" label="CPU request" tooltip="Leave blank to keep current value">
          <Input placeholder="e.g. 500m" />
        </Form.Item>
        <Form.Item name="cpuLimit" label="CPU limit">
          <Input placeholder="e.g. 2" />
        </Form.Item>
        <Form.Item name="memoryRequest" label="Memory request">
          <Input placeholder="e.g. 1Gi" />
        </Form.Item>
        <Form.Item name="memoryLimit" label="Memory limit">
          <Input placeholder="e.g. 4Gi" />
        </Form.Item>
        <Form.Item
          name="storage"
          label="Storage"
          tooltip="PVC resize only grows on most CSI drivers; shrinks are rejected by Kubernetes."
        >
          <Input placeholder="e.g. 60Gi" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
