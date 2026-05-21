import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Table, Tag, Space, Button, App, Tooltip, Dropdown } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  FileTextOutlined,
  CodeOutlined,
  PauseOutlined,
  CaretRightOutlined,
  CopyOutlined,
  ExpandAltOutlined,
  ShrinkOutlined,
  EditOutlined,
  ExportOutlined,
  MoreOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  ApiOutlined,
  LineChartOutlined,
  DesktopOutlined,
  DatabaseOutlined,
  RocketOutlined,
  HddOutlined,
  DashboardOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  useInferenceServices,
  ensureInferenceServicesLoaded,
  reloadInferenceServices,
  deleteInferenceService,
  fetchInferenceServiceYaml,
  buildInferenceServiceYaml,
  setInferenceServiceStopped,
  updateInferenceServiceYaml,
  type InferenceService,
} from '@/data/inference';
import { useApp } from '@/context/AppContext';
import { LogViewer } from '@/components/LogViewer';
import { YamlViewer } from '@/components/YamlViewer';
import { YamlEditor } from '@/components/YamlEditor';
import { NewInferenceServiceModal } from './NewInferenceServiceModal';
import {
  fetchGatewayConfig,
  fetchServiceRouteStatus,
  type GatewayConfigDTO,
  type ServiceRouteStatusDTO,
} from '@/api/inference';

const MODEL_COLUMN_WIDTH = 280;
const MODEL_TRUNCATE_AFTER = 36;

function ModelUriCell({ uri }: { uri: string }) {
  const { message } = App.useApp();
  const [expanded, setExpanded] = useState(false);
  const tooLong = uri.length > MODEL_TRUNCATE_AFTER;
  return (
    <div style={{ width: MODEL_COLUMN_WIDTH, display: 'flex', alignItems: 'center', gap: 4 }}>
      <Tooltip title={tooLong && !expanded ? uri : null} placement="topLeft">
        <span
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            ...(expanded
              ? { whiteSpace: 'normal', wordBreak: 'break-all' }
              : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
          }}
        >
          {uri}
        </span>
      </Tooltip>
      {tooLong && (
        <Button
          type="text"
          size="small"
          icon={expanded ? <ShrinkOutlined /> : <ExpandAltOutlined />}
          onClick={() => setExpanded(v => !v)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        />
      )}
      <Button
        type="text"
        size="small"
        icon={<CopyOutlined />}
        onClick={() => {
          navigator.clipboard.writeText(uri).then(
            () => message.success('URI copied'),
            () => message.error('Copy failed'),
          );
        }}
        aria-label="Copy URI"
      />
    </div>
  );
}

export function InferenceServicesPage() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const nav = useNavigate();
  const all = useInferenceServices();
  const data = useMemo(() => all.filter(s => s.namespace === namespace), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<InferenceService | null>(null);
  const [yaml, setYaml] = useState<{ svc: InferenceService; text: string } | null>(null);
  const [yamlEdit, setYamlEdit] = useState<{ svc: InferenceService; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);
  const [yamlSaving, setYamlSaving] = useState(false);
  const [log, setLog] = useState<InferenceService | null>(null);
  // Gateway config + per-service route status. Cached cluster-wide; the
  // per-row chip falls back to "0 routes" when route-status returns an
  // error (typically because the AI Gateway CRDs are not installed).
  const [gateway, setGateway] = useState<GatewayConfigDTO | null>(null);
  const [routeStatuses, setRouteStatuses] = useState<
    Record<string, ServiceRouteStatusDTO | undefined>
  >({});

  useEffect(() => {
    ensureInferenceServicesLoaded(namespace);
  }, [namespace]);

  useEffect(() => {
    fetchGatewayConfig().then(setGateway).catch(() => setGateway(null));
  }, []);

  useEffect(() => {
    // Per-service route status. Sequential, since the backend already does
    // cluster-wide list calls for each invocation and we don't want a burst.
    let cancelled = false;
    (async () => {
      const out: Record<string, ServiceRouteStatusDTO | undefined> = {};
      for (const svc of data) {
        if (cancelled) return;
        try {
          out[`${svc.namespace}/${svc.name}`] = await fetchServiceRouteStatus(
            svc.namespace,
            svc.name,
          );
        } catch {
          out[`${svc.namespace}/${svc.name}`] = undefined;
        }
      }
      if (!cancelled) setRouteStatuses(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [data.map(d => `${d.namespace}/${d.name}`).join(',')]);

  const openYaml = async (svc: InferenceService) => {
    setYamlLoading(svc.name);
    try {
      const text = await fetchInferenceServiceYaml(namespace, svc.name, svc.kind);
      setYaml({ svc, text: text || buildInferenceServiceYaml(svc) });
    } catch (e) {
      setYaml({ svc, text: buildInferenceServiceYaml(svc) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  const openEditYaml = async (svc: InferenceService) => {
    setYamlLoading(svc.name);
    try {
      const text = await fetchInferenceServiceYaml(namespace, svc.name, svc.kind);
      setYamlEdit({ svc, text: text || buildInferenceServiceYaml(svc) });
    } catch (e) {
      setYamlEdit({ svc, text: buildInferenceServiceYaml(svc) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  const saveYaml = async () => {
    if (!yamlEdit) return;
    setYamlSaving(true);
    try {
      await updateInferenceServiceYaml(namespace, yamlEdit.svc.name, yamlEdit.svc.kind, yamlEdit.text);
      message.success('YAML updated');
      setYamlEdit(null);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setYamlSaving(false);
    }
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="Inference services"
        description="KServe InferenceService and LLMInferenceService resources in the current namespace."
        extra={
          <Space>
            <Button onClick={() => reloadInferenceServices(namespace)}>Refresh</Button>
            <Button
              icon={<ApiOutlined />}
              onClick={() => nav('/inference/gateway')}
            >
              Gateway
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              New inference service
            </Button>
          </Space>
        }
      />
      <GatewayBanner gateway={gateway} />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            render: (v: string, r: InferenceService) => (
              <a onClick={() => nav(`/inference/services/${encodeURIComponent(r.namespace)}/${encodeURIComponent(r.name)}`)}>
                <b>{v}</b>
              </a>
            ),
          },
          {
            title: 'Kind',
            dataIndex: 'kind',
            render: v => <Tag color={v === 'LLMInferenceService' ? 'blue' : 'purple'}>{v}</Tag>,
          },
          { title: 'Runtime', dataIndex: 'runtime' },
          {
            title: 'Deployment mode',
            dataIndex: 'deploymentMode',
            render: v => v ? <Tag color={v === 'RawDeployment' ? 'geekblue' : v === 'ModelMesh' ? 'magenta' : 'cyan'}>{v}</Tag> : '—',
          },
          {
            title: 'Model',
            dataIndex: 'modelUri',
            width: MODEL_COLUMN_WIDTH,
            render: v => <ModelUriCell uri={v} />,
          },
          { title: 'Replicas', render: (_, r) => r.minReplicas === r.maxReplicas ? r.minReplicas : `${r.minReplicas} – ${r.maxReplicas}` },
          {
            title: 'Resources',
            render: (_, r) => <ResourceChips svc={r} />,
          },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          {
            title: 'Route',
            render: (_, r) => {
              const rs = routeStatuses[`${r.namespace}/${r.name}`];
              if (!rs) return <Tag>—</Tag>;
              return (
                <Space size={4} wrap>
                  {rs.routes.length > 0 ? (
                    <Tooltip
                      title={rs.routes
                        .map(rt => `${rt.kind} ${rt.namespace}/${rt.name}`)
                        .join('\n')}
                    >
                      <Tag color="green" icon={<ApiOutlined />}>
                        {rs.routes.length}
                      </Tag>
                    </Tooltip>
                  ) : (
                    <Tag>0</Tag>
                  )}
                  {rs.rateLimits.length > 0 && (
                    <Tooltip
                      title={rs.rateLimits
                        .map(p => `${p.namespace}/${p.name} — ${(p.summaries ?? []).join(', ')}`)
                        .join('\n')}
                    >
                      <Tag color="orange" icon={<ThunderboltOutlined />}>
                        {rs.rateLimits.map(p => p.summaries?.[0] ?? 'limited').join(', ')}
                      </Tag>
                    </Tooltip>
                  )}
                </Space>
              );
            },
          },
          {
            title: 'Endpoint',
            dataIndex: 'endpoint',
            render: (v: string) => <EndpointCell endpoint={v} />,
          },
          {
            title: 'Actions',
            width: 90,
            render: (_, r) => {
              const isStopped = r.stopped || r.status === 'Stopped';
              // Everything moves under the overflow menu — keeps the row
              // narrow and turns the action column into a single click
              // target. Most users hit Details / Logs / YAML far more
              // often than Edit or Delete, so they sit at the top.
              return (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      {
                        key: 'details',
                        label: 'Details',
                        icon: <LineChartOutlined />,
                      },
                      {
                        key: 'toggle',
                        label: isStopped ? 'Start' : 'Stop',
                        icon: isStopped ? <CaretRightOutlined /> : <PauseOutlined />,
                      },
                      { key: 'logs', label: 'Logs', icon: <FileTextOutlined /> },
                      { key: 'yaml', label: 'YAML', icon: <CodeOutlined /> },
                      { type: 'divider' as const },
                      { key: 'edit', label: 'Edit', icon: <EditOutlined /> },
                      { key: 'edit-yaml', label: 'Edit YAML', icon: <EditOutlined /> },
                      { type: 'divider' as const },
                      { key: 'delete', label: 'Delete', icon: <DeleteOutlined />, danger: true },
                    ],
                    onClick: async ({ key, domEvent }) => {
                      domEvent.stopPropagation();
                      if (key === 'details') {
                        nav(`/inference/services/${encodeURIComponent(r.namespace)}/${encodeURIComponent(r.name)}`);
                      } else if (key === 'toggle') {
                        try {
                          await setInferenceServiceStopped(namespace, r.name, r.kind, !isStopped);
                          message.success(isStopped ? 'Starting…' : 'Stopping…');
                        } catch (e) {
                          message.error((e as Error).message);
                        }
                      } else if (key === 'logs') {
                        setLog(r);
                      } else if (key === 'yaml') {
                        openYaml(r);
                      } else if (key === 'edit') {
                        setEditing(r);
                        setOpen(true);
                      } else if (key === 'edit-yaml') {
                        openEditYaml(r);
                      } else if (key === 'delete') {
                        modal.confirm({
                          title: `Delete service ${r.name}?`,
                          onOk: async () => {
                            try {
                              await deleteInferenceService(namespace, r.name, r.kind);
                              message.success('Service deleted');
                            } catch (e) {
                              message.error((e as Error).message);
                            }
                          },
                        });
                      }
                    },
                  }}
                >
                  <Button
                    size="small"
                    icon={<MoreOutlined />}
                    loading={yamlLoading === r.name}
                    aria-label="Actions"
                  >
                    Actions
                  </Button>
                </Dropdown>
              );
            },
          },
        ]}
      />
      <NewInferenceServiceModal
        open={open}
        namespace={namespace}
        editing={editing}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
      />

      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`${yaml?.svc.kind ?? ''} · ${yaml?.svc.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
      <YamlEditor
        open={!!yamlEdit}
        onClose={() => setYamlEdit(null)}
        title={`Edit YAML · ${yamlEdit?.svc.kind ?? ''} · ${yamlEdit?.svc.name ?? ''}`}
        value={yamlEdit?.text ?? ''}
        saving={yamlSaving}
        onChange={text => setYamlEdit(cur => (cur ? { ...cur, text } : cur))}
        onSave={saveYaml}
      />
      <LogViewer
        open={!!log}
        onClose={() => setLog(null)}
        title={`Logs · ${log?.name ?? ''}`}
        containers={['kserve-container', 'queue-proxy']}
        inferenceRef={log ? { namespace: log.namespace, name: log.name, kind: log.kind } : undefined}
      />
    </div>
  );
}

// GatewayBanner renders a one-line summary of cluster-wide gateway state
// above the table. Two rows so the kserve-ingress-gateway status +
// addresses always read together (the user's "how do I reach my service?"
// answer), with the cluster-wide CRD/config tags below.
function GatewayBanner({ gateway }: { gateway: GatewayConfigDTO | null }) {
  if (!gateway) return null;
  const configTags: JSX.Element[] = [
    <Tag
      key="gw-api"
      color={gateway.ingressGatewayApiEnabled ? 'green' : 'default'}
      icon={<SafetyCertificateOutlined />}
    >
      Gateway API: {gateway.ingressGatewayApiEnabled ? 'on' : 'off'}
    </Tag>,
    <Tag
      key="aigw"
      color={gateway.envoyAiGatewayInstalled ? 'blue' : 'default'}
      icon={<ThunderboltOutlined />}
    >
      Envoy AI Gateway: {gateway.envoyAiGatewayInstalled ? 'installed' : 'missing'}
    </Tag>,
  ];
  if (gateway.defaultDeploymentMode) {
    configTags.push(
      <Tag key="mode" color="cyan">
        default mode: {gateway.defaultDeploymentMode}
      </Tag>,
    );
  }
  const gw = gateway.gateway;
  const statusColor =
    gw?.status === 'Accepted' ? 'green' : gw?.status === 'Failed' ? 'red' : 'gold';
  return (
    <Alert
      type={gw?.status === 'Accepted' ? 'success' : gw ? 'warning' : 'info'}
      showIcon
      icon={<ExportOutlined />}
      style={{ marginBottom: 12 }}
      message={
        <Space size={8} wrap>
          <b>kserve-ingress-gateway:</b>
          {gw ? (
            <>
              <Tag color={statusColor}>{gw.status}</Tag>
              <Tag color="default">
                <span className="mono">{`${gw.namespace}/${gw.name}`}</span>
              </Tag>
              {gw.gatewayClassName && (
                <Tag color="default">class: {gw.gatewayClassName}</Tag>
              )}
              {(gw.addresses ?? []).length > 0 ? (
                (gw.addresses ?? []).map(addr => (
                  <Tooltip key={addr} title="Click to copy">
                    <Tag
                      color="blue"
                      style={{ cursor: 'pointer' }}
                      onClick={() =>
                        navigator.clipboard.writeText(addr).catch(() => null)
                      }
                    >
                      <span className="mono">{addr}</span>
                    </Tag>
                  </Tooltip>
                ))
              ) : (
                <Tag color="gold">no address programmed</Tag>
              )}
            </>
          ) : (
            <Tag color="default">not installed</Tag>
          )}
        </Space>
      }
      description={<Space wrap>{configTags}</Space>}
    />
  );
}

// resourceMeta encodes the per-key icon + color for the Resources column.
// Keys are matched by full resource name (e.g. nvidia.com/gpu) or a unit
// fallback for arbitrary HAMi-style accelerator keys (gpualloc / gpumem).
const resourceMeta: Record<string, { color: string; Icon: typeof DesktopOutlined; label: string }> = {
  cpu: { color: '#2468f2', Icon: DesktopOutlined, label: 'CPU' },
  memory: { color: '#10b981', Icon: DatabaseOutlined, label: 'Mem' },
  'nvidia.com/gpu': { color: '#76b900', Icon: RocketOutlined, label: 'GPU' },
  'amd.com/gpu': { color: '#ed1c24', Icon: RocketOutlined, label: 'GPU' },
  'huawei.com/Ascend910': { color: '#c7000b', Icon: RocketOutlined, label: 'NPU' },
};

// resourceFor picks the right icon/color for an arbitrary HAMi-style key
// (e.g. nvidia.com/gpualloc, nvidia.com/gpumem). The trailing segment of
// the key drives the label and the icon family.
function resourceFor(key: string): { color: string; Icon: typeof DesktopOutlined; label: string } {
  if (resourceMeta[key]) return resourceMeta[key];
  const suffix = key.split('/').pop() ?? key;
  if (/mem/i.test(suffix)) {
    return { color: '#0ea5e9', Icon: HddOutlined, label: suffix };
  }
  if (/core|alloc/i.test(suffix)) {
    return { color: '#f59e0b', Icon: DashboardOutlined, label: suffix };
  }
  return { color: '#a855f7', Icon: RocketOutlined, label: suffix };
}

// ResourceChips renders the per-row resources column with one coloured
// chip per resource key (CPU, memory, GPU, plus any HAMi sub-keys). The
// chip stays compact — icon + value — so a row can fit four chips side by
// side without wrapping.
function ResourceChips({ svc }: { svc: InferenceService }) {
  const chips: { key: string; color: string; Icon: typeof DesktopOutlined; label: string; value: string }[] = [];
  if (svc.resources.cpu) {
    const m = resourceFor('cpu');
    chips.push({ key: 'cpu', ...m, value: svc.resources.cpu });
  }
  if (svc.resources.memory) {
    const m = resourceFor('memory');
    chips.push({ key: 'memory', ...m, value: svc.resources.memory });
  }
  // Prefer the structured gpuValues map (HAMi composite resources); fall
  // back to the legacy resources.gpu integer when not set.
  if (svc.gpuValues && Object.keys(svc.gpuValues).length > 0) {
    for (const [k, v] of Object.entries(svc.gpuValues)) {
      const m = resourceFor(k);
      chips.push({ key: k, ...m, value: String(v) });
    }
  } else if (svc.resources.gpu > 0) {
    const m = resourceFor('nvidia.com/gpu');
    chips.push({ key: 'gpu', ...m, value: `${svc.resources.gpu}` });
  }
  if (chips.length === 0) {
    return <span style={{ color: '#999' }}>—</span>;
  }
  return (
    <Space size={4} wrap>
      {chips.map(c => (
        <Tooltip key={c.key} title={c.key}>
          <Tag
            icon={<c.Icon style={{ color: c.color }} />}
            style={{
              background: `${c.color}1A`,
              borderColor: `${c.color}55`,
              color: c.color,
              fontWeight: 600,
              margin: 0,
            }}
          >
            {c.label} · {c.value}
          </Tag>
        </Tooltip>
      ))}
    </Space>
  );
}

// EndpointCell renders the predictor URL with a copy button. Truncated
// with ellipsis at the column width so the row stays scannable; the full
// URL is in the Tooltip and on copy.
function EndpointCell({ endpoint }: { endpoint: string }) {
  const { message } = App.useApp();
  if (!endpoint) return <span style={{ color: '#999' }}>—</span>;
  return (
    <Space size={4} style={{ display: 'flex', alignItems: 'center' }}>
      <Tooltip title={endpoint} placement="topLeft">
        <span
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'inline-block',
            verticalAlign: 'middle',
            fontSize: 12,
          }}
        >
          {endpoint}
        </span>
      </Tooltip>
      <Button
        type="text"
        size="small"
        icon={<CopyOutlined />}
        aria-label="Copy endpoint"
        onClick={() => {
          navigator.clipboard.writeText(endpoint).then(
            () => message.success('Endpoint copied'),
            () => message.error('Copy failed'),
          );
        }}
      />
    </Space>
  );
}
