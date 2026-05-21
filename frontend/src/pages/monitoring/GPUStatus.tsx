import { useEffect, useMemo, useState } from 'react';
import { App, Card, Col, Empty, Row, Skeleton, Space, Spin, Statistic, Table, Tag, Tooltip } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import {
  fetchGPUDeviceUsage,
  fetchGPUStatus,
  type GPUDeviceUsage,
  type GPUPodUsage,
  type GPUStatus,
  type GPUVendorSummary,
} from '@/api/gpu';

// Donut palette — green for "free / available" reads as healthy, blue for
// "in use" matches the rest of the monitoring charts, and a tasteful set
// of accent colours for the plugin slice. Order matters: device plugins
// pull colours from this array in registration order.
const DONUT_USED = '#2468f2';
const DONUT_FREE = '#10b981';
const PLUGIN_PALETTE = ['#2468f2', '#a855f7', '#10b981', '#f8b418', '#e94f4f', '#06b6d4', '#8b5cf6', '#f97316'];

// HAMi replaces the vanilla NVIDIA device plugin and re-uses the
// `nvidia.com/*` namespace, so we identify a HAMi-managed node by the
// presence of any HAMi-specific auxiliary key: gpualloc (explicit slot
// count), gpucores (% of physical core per request), or gpumem (MiB per
// request). When any of those is on the node we treat the whole
// nvidia.com bucket as HAMi — including a bare nvidia.com/gpu, which
// HAMi 2.x re-advertises as a vGPU slot count.
const HAMI_AUX_KEYS = ['nvidia.com/gpualloc', 'nvidia.com/gpucores', 'nvidia.com/gpumem'] as const;

function isHAMiManaged(resources: Record<string, number>): boolean {
  return HAMI_AUX_KEYS.some(k => k in resources);
}

// hamiSlotCount picks the best available "GPU count" for a HAMi node or
// pod. Preference order:
//   1. gpualloc — explicit slot count (auxiliary HAMi key).
//   2. nvidia.com/gpu — HAMi 2.x re-uses this key as the slot count.
//   3. gpucores / 100 — physical-card approximation (cores are reported
//      as a percentage, so each whole physical card contributes 100).
// Returns 0 when none of the above is set, which the donut callers treat
// as "still HAMi-managed, just nothing to count yet".
function hamiSlotCount(resources: Record<string, number>): number {
  if (typeof resources['nvidia.com/gpualloc'] === 'number') return resources['nvidia.com/gpualloc'];
  if (typeof resources['nvidia.com/gpu'] === 'number') return resources['nvidia.com/gpu'];
  const cores = resources['nvidia.com/gpucores'];
  if (typeof cores === 'number' && cores > 0) return Math.max(1, Math.floor(cores / 100));
  return 0;
}

// classifyNodePlugin returns the device-plugin label that's exposing the
// GPU resources on a given node.
function classifyNodePlugin(capacity: Record<string, number>): { plugin: string; count: number } | null {
  const keys = Object.keys(capacity ?? {});
  if (isHAMiManaged(capacity)) {
    return { plugin: 'HAMi (vGPU)', count: hamiSlotCount(capacity) };
  }
  if (capacity['nvidia.com/gpu']) {
    return { plugin: 'NVIDIA Device Plugin', count: capacity['nvidia.com/gpu'] };
  }
  const huawei = keys.filter(k => k.startsWith('huawei.com/'));
  if (huawei.length > 0) {
    return { plugin: 'Huawei NPU', count: huawei.reduce((s, k) => s + (capacity[k] ?? 0), 0) };
  }
  if (capacity['amd.com/gpu']) {
    return { plugin: 'AMD', count: capacity['amd.com/gpu'] };
  }
  if (capacity['intel.com/gpu']) {
    return { plugin: 'Intel', count: capacity['intel.com/gpu'] };
  }
  return null;
}

// classifyPodPlugin is the namespace-scope fallback — it derives the
// plugin from the pod's resource requests. Less authoritative than the
// node-capacity classifier but useful when the caller can't read nodes.
function classifyPodPlugin(resources: Record<string, number>): { plugin: string; count: number } | null {
  const keys = Object.keys(resources ?? {});
  if (isHAMiManaged(resources)) {
    // Pods commonly request HAMi via gpucores+gpumem and omit gpualloc,
    // so fall back to "at least one slot" when no count key is set —
    // otherwise the pod would silently drop out of the plugin tally.
    return { plugin: 'HAMi (vGPU)', count: hamiSlotCount(resources) || 1 };
  }
  if (resources['nvidia.com/gpu']) {
    return { plugin: 'NVIDIA Device Plugin', count: resources['nvidia.com/gpu'] };
  }
  const huawei = keys.filter(k => k.startsWith('huawei.com/'));
  if (huawei.length > 0) {
    return { plugin: 'Huawei NPU', count: huawei.reduce((s, k) => s + (resources[k] ?? 0), 0) };
  }
  if (resources['amd.com/gpu']) {
    return { plugin: 'AMD', count: resources['amd.com/gpu'] };
  }
  if (resources['intel.com/gpu']) {
    return { plugin: 'Intel', count: resources['intel.com/gpu'] };
  }
  return null;
}

// Format a per-key resource map into a compact tag row for tables.
function resourceTags(resources: Record<string, number>): React.ReactNode {
  const entries = Object.entries(resources).filter(([, v]) => v > 0);
  if (entries.length === 0) return <span className="knaic-sub">—</span>;
  return (
    <Space wrap size={4}>
      {entries.map(([k, v]) => (
        <Tag key={k} className="mono" style={{ fontSize: 11 }}>
          {k.split('/').pop()}={v}
        </Tag>
      ))}
    </Space>
  );
}

export function GPUStatus() {
  const { user, namespace } = useApp();
  const { message } = App.useApp();
  const isAdmin = user.isPlatformAdmin;
  // clusterStatus drives the headline charts (usage, plugin breakdown,
  // per-vendor) for every caller — admins via the SA-backed apiserver path,
  // non-admins via the VictoriaMetrics-backed monitoring path.
  const [clusterStatus, setClusterStatus] = useState<GPUStatus | null>(null);
  const [clusterLoading, setClusterLoading] = useState(true);
  // nsStatus only fetched for non-admins, used solely for the pod table.
  // Admins read pods from clusterStatus.pods directly.
  const [nsStatus, setNsStatus] = useState<GPUStatus | null>(null);
  const [nsLoading, setNsLoading] = useState(false);
  const [devices, setDevices] = useState<GPUDeviceUsage[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  // True only on the very first render before any data has arrived. While
  // it's true we show a single big "Waiting" overlay on the whole content
  // area; subsequent reloads (namespace change) get the smaller section-
  // level spinners so users keep their context.
  const isInitialLoad = clusterStatus === null && clusterLoading;

  // Cluster-wide status: fetched once per mount (admin status doesn't
  // change inside a session, and the cluster view doesn't depend on the
  // selected namespace).
  useEffect(() => {
    let cancelled = false;
    setClusterLoading(true);
    fetchGPUStatus('cluster')
      .then(s => { if (!cancelled) setClusterStatus(s); })
      .catch(e => { if (!cancelled) message.error((e as Error).message); })
      .finally(() => { if (!cancelled) setClusterLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Namespace pod table — non-admin only, refetched on namespace change.
  // Apiserver via impersonation gates visibility; matches RBAC exactly.
  useEffect(() => {
    if (isAdmin) {
      setNsStatus(null);
      setNsLoading(false);
      return;
    }
    let cancelled = false;
    setNsLoading(true);
    fetchGPUStatus('namespace', namespace)
      .then(s => { if (!cancelled) setNsStatus(s); })
      .catch(e => { if (!cancelled) message.error((e as Error).message); })
      .finally(() => { if (!cancelled) setNsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, namespace]);

  // Per-card DCGM time series — admin only. Empty array on clusters
  // without DCGM scraping.
  useEffect(() => {
    if (!isAdmin) {
      setDevices([]);
      setDevicesLoading(false);
      return;
    }
    let cancelled = false;
    setDevicesLoading(true);
    fetchGPUDeviceUsage()
      .then(d => { if (!cancelled) setDevices(d); })
      .catch(() => { if (!cancelled) setDevices([]); })
      .finally(() => { if (!cancelled) setDevicesLoading(false); });
    return () => { cancelled = true; };
  }, [isAdmin]);

  const vendors = clusterStatus?.vendors ?? [];
  const summary = clusterStatus?.summary ?? { total: 0, used: 0, available: 0 };
  const nodes = clusterStatus?.nodes ?? [];
  // Pod source diverges by role: admins get the cluster-wide list (with
  // namespace column); non-admins get the namespace-scoped list.
  const pods = isAdmin ? (clusterStatus?.pods ?? []) : (nsStatus?.pods ?? []);
  const podsLoading = isAdmin ? clusterLoading : nsLoading;

  // Donut #1: used / available, total in the centre. We force a tiny
  // sentinel slice when the cluster has no GPUs at all so the donut still
  // renders an empty ring rather than collapsing.
  const usageDonut = useMemo(() => {
    if (summary.total <= 0) {
      return [{ name: 'No GPUs', value: 1, color: '#d9d9d9', placeholder: true }];
    }
    return [
      { name: 'In use', value: summary.used, color: DONUT_USED },
      { name: 'Available', value: summary.available, color: DONUT_FREE },
    ];
  }, [summary]);

  // Donut #2: physical GPUs grouped by managing device plugin. Prefer the
  // node-capacity classifier (only available cluster-scope/admin); fall
  // back to the pod-resource classifier so namespace users still see a
  // breakdown of the plugins their workloads consume.
  const pluginsDonut = useMemo(() => {
    const tally: Record<string, number> = {};
    if (nodes.length > 0) {
      for (const n of nodes) {
        const r = classifyNodePlugin(n.capacity ?? {});
        if (!r) continue;
        tally[r.plugin] = (tally[r.plugin] ?? 0) + r.count;
      }
    } else {
      for (const p of pods) {
        const r = classifyPodPlugin(p.resources ?? {});
        if (!r) continue;
        tally[r.plugin] = (tally[r.plugin] ?? 0) + r.count;
      }
    }
    const entries = Object.entries(tally).filter(([, v]) => v > 0);
    return entries.map(([name, value], i) => ({
      name,
      value,
      color: PLUGIN_PALETTE[i % PLUGIN_PALETTE.length],
    }));
  }, [nodes, pods]);

  return (
    <div className="knaic-page">
      <PageHeader
        title="GPU status"
        description={
          isAdmin
            ? 'Cluster-wide GPU inventory and pod-to-card assignment.'
            : `Cluster-wide GPU inventory. Pod assignment shown for namespace ${namespace}.`
        }
      />

      {/*
        First-paint loading: a single big spinner over a placeholder
        skeleton, so the user sees "Waiting" rather than misleading zeros
        while the cluster scan + DCGM probe are in flight.
      */}
      {isInitialLoad ? (
        <Card size="small" style={{ marginBottom: 12 }}>
          <Spin
            spinning
            size="large"
            tip="Loading GPU inventory…"
            indicator={<LoadingOutlined style={{ fontSize: 28 }} spin />}
          >
            <div style={{ minHeight: 220 }}>
              <Skeleton active paragraph={{ rows: 4 }} />
            </div>
          </Spin>
        </Card>
      ) : (
        <Spin spinning={clusterLoading} indicator={<LoadingOutlined spin />}>
          {/*
            Headline visualisation: two doughnut charts side-by-side.
            #1 — cluster-wide capacity (Used / Available), total in the centre.
            #2 — physical GPUs grouped by managing device plugin (HAMi,
                 NVIDIA Device Plugin, Huawei NPU, …).
            Both reflect the whole cluster regardless of caller role; the
            namespace-scoped drill-down lives in the pod table below.
          */}
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24} md={12}>
              <Card size="small" title="GPU capacity (cluster)">
                <UsageDonut
                  data={usageDonut}
                  total={summary.total}
                  used={summary.used}
                  available={summary.available}
                />
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card
                size="small"
                title={
                  <Space>
                    <span>By device plugin</span>
                    <Tooltip
                      title="Physical GPUs grouped by which device plugin manages them. Inferred per-node from the resource keys the kubelet advertises."
                    >
                      <Tag color="default" style={{ marginRight: 0 }}>{pluginsDonut.length || 0} plugin{pluginsDonut.length === 1 ? '' : 's'}</Tag>
                    </Tooltip>
                  </Space>
                }
              >
                <PluginsDonut data={pluginsDonut} />
              </Card>
            </Col>
          </Row>
        </Spin>
      )}

      {vendors.length === 0 && !clusterLoading && !isInitialLoad && (
        <Empty description="No GPU resources detected on the cluster." style={{ margin: '40px 0' }} />
      )}

      {/* Per-vendor breakdown — primary count + auxiliary keys. */}
      {vendors.length > 0 && (
        <VendorBreakdown vendors={vendors} />
      )}

      {/*
        Per-node breakdown — admin only. Non-admins can't read individual
        node names via impersonation, and exposing them would leak cluster
        topology we'd rather keep gated.
      */}
      {isAdmin && nodes.length > 0 && (
        <Card title="Per-node breakdown" size="small" style={{ marginBottom: 12 }}>
          <Table
            rowKey="node"
            size="small"
            pagination={false}
            dataSource={nodes}
            columns={[
              { title: 'Node', dataIndex: 'node', render: v => <span className="mono">{v}</span> },
              { title: 'Capacity', dataIndex: 'capacity', render: v => resourceTags(v ?? {}) },
              { title: 'Allocated', dataIndex: 'allocated', render: v => resourceTags(v ?? {}) },
              { title: 'GPU pods', dataIndex: 'pods', width: 120 },
            ]}
          />
        </Card>
      )}

      {/* Pod-to-GPU assignment table — admin sees cluster-wide, ns user only their namespace's pods. */}
      <Card
        title={isAdmin ? 'Pods using GPU (cluster-wide)' : `Pods using GPU in namespace ${namespace}`}
        size="small"
        style={{ marginBottom: 12 }}
      >
        <Spin spinning={podsLoading && pods.length === 0} indicator={<LoadingOutlined spin />}>
          <PodTable pods={pods} showNamespace={isAdmin} />
        </Spin>
      </Card>

      {/*
        DCGM-backed per-card chart grid — admin only. Capped to 24 charts
        per render so a 200-GPU cluster doesn't melt the browser; the user
        can scroll to see more (or we can paginate later).
      */}
      {isAdmin && (
        <DeviceChartGrid devices={devices} loading={devicesLoading} />
      )}
    </div>
  );
}

// UsageDonut renders the Used / Available pair around a centred total.
// Recharts doesn't have a built-in centre label, so we paint our own
// absolutely-positioned stack on top of the SVG.
function UsageDonut({
  data,
  total,
  used,
  available,
}: {
  data: Array<{ name: string; value: number; color: string; placeholder?: boolean }>;
  total: number;
  used: number;
  available: number;
}) {
  return (
    <div style={{ position: 'relative', height: 220 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="60%"
            outerRadius="85%"
            paddingAngle={data.length > 1 ? 2 : 0}
            stroke="none"
            startAngle={90}
            endAngle={-270}
          >
            {data.map(d => (
              <Cell key={d.name} fill={d.color} />
            ))}
          </Pie>
          {!data[0]?.placeholder && <ChartTooltip formatter={(v: number) => `${v} GPU${v === 1 ? '' : 's'}`} />}
          {!data[0]?.placeholder && <Legend verticalAlign="bottom" height={28} iconType="circle" />}
        </PieChart>
      </ResponsiveContainer>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          // Account for the legend taking the bottom 28px so the centre label
          // lands in the donut's hole, not on the legend.
          paddingBottom: 28,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div style={{ fontSize: 32, fontWeight: 600, lineHeight: 1 }}>{total}</div>
        <div className="knaic-sub" style={{ fontSize: 12, marginTop: 4 }}>
          {total === 0 ? 'no GPUs' : `${used} used · ${available} free`}
        </div>
      </div>
    </div>
  );
}

// PluginsDonut shows the share each device plugin contributes to the
// total physical-GPU count. When no plugin is detected we render an empty
// state inside the same card so the layout doesn't shift.
function PluginsDonut({ data }: { data: Array<{ name: string; value: number; color: string }> }) {
  if (data.length === 0) {
    return (
      <div style={{ height: 220, display: 'grid', placeItems: 'center' }}>
        <Empty description="No device plugin detected." />
      </div>
    );
  }
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div style={{ position: 'relative', height: 220 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="60%"
            outerRadius="85%"
            paddingAngle={data.length > 1 ? 2 : 0}
            stroke="none"
            startAngle={90}
            endAngle={-270}
          >
            {data.map(d => (
              <Cell key={d.name} fill={d.color} />
            ))}
          </Pie>
          <ChartTooltip formatter={(v: number) => `${v} GPU${v === 1 ? '' : 's'}`} />
          <Legend verticalAlign="bottom" height={28} iconType="circle" />
        </PieChart>
      </ResponsiveContainer>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          paddingBottom: 28,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div style={{ fontSize: 32, fontWeight: 600, lineHeight: 1 }}>{total}</div>
        <div className="knaic-sub" style={{ fontSize: 12, marginTop: 4 }}>
          GPU{total === 1 ? '' : 's'} total
        </div>
      </div>
    </div>
  );
}

function VendorBreakdown({ vendors }: { vendors: GPUVendorSummary[] }) {
  return (
    <Card title="Per-vendor breakdown" size="small" style={{ marginBottom: 12 }}>
      <Row gutter={[12, 12]}>
        {vendors.map(v => (
          <Col xs={24} md={12} key={v.vendor}>
            <Card size="small" type="inner" title={
              <Space>
                <span>{v.vendor}</span>
                <Tag color="blue" className="mono">{v.primary}</Tag>
              </Space>
            }>
              <Row gutter={12}>
                <Col span={8}><Statistic title="Total" value={v.counts.total} /></Col>
                <Col span={8}><Statistic title="Used" value={v.counts.used} /></Col>
                <Col span={8}><Statistic title="Available" value={v.counts.available} /></Col>
              </Row>
              {/* Drilldown — per-key counts for vendors with auxiliary metrics
                  (HAMi's gpucores/gpumem). Hidden when there's only one key. */}
              {v.keys.length > 1 && (
                <Table
                  size="small"
                  pagination={false}
                  rowKey="key"
                  style={{ marginTop: 8 }}
                  dataSource={v.keys.map(k => ({ key: k, ...v.byKey[k] }))}
                  columns={[
                    { title: 'Resource', dataIndex: 'key', render: v => <span className="mono">{v}</span> },
                    { title: 'Total', dataIndex: 'total' },
                    { title: 'Used', dataIndex: 'used' },
                    { title: 'Available', dataIndex: 'available' },
                  ]}
                />
              )}
            </Card>
          </Col>
        ))}
      </Row>
    </Card>
  );
}

function PodTable({ pods, showNamespace }: { pods: GPUPodUsage[]; showNamespace: boolean }) {
  if (pods.length === 0) {
    return <Empty description="No pods are requesting GPU resources." />;
  }
  return (
    <Table
      rowKey={r => `${r.namespace}/${r.name}`}
      size="small"
      pagination={pods.length > 20 ? { pageSize: 20 } : false}
      dataSource={pods}
      columns={[
        ...(showNamespace ? [{ title: 'Namespace', dataIndex: 'namespace', width: 180 }] : []),
        { title: 'Pod', dataIndex: 'name', render: v => <span className="mono">{v}</span> },
        { title: 'Node', dataIndex: 'node', render: v => <span className="mono">{v ?? '—'}</span> },
        {
          title: 'Phase',
          dataIndex: 'phase',
          width: 110,
          render: v => <Tag color={v === 'Running' ? 'success' : v === 'Pending' ? 'processing' : 'default'}>{v}</Tag>,
        },
        { title: 'Resources', dataIndex: 'resources', render: v => resourceTags(v ?? {}) },
      ]}
    />
  );
}

function DeviceChartGrid({ devices, loading }: { devices: GPUDeviceUsage[]; loading: boolean }) {
  // Fold to "one chart per (node, gpu)". DCGM emits decimal percentages —
  // round to integer for the Y axis so 73.4127 doesn't clutter the label.
  const cards = useMemo(
    () =>
      devices.map(d => ({
        key: `${d.node}::${d.gpu}::${d.uuid ?? ''}`,
        title: `${d.node} · GPU ${d.gpu}${d.modelName ? ` · ${d.modelName}` : ''}`,
        data: d.points.map(p => ({ t: p.t, v: Math.round(p.v) })),
      })),
    [devices],
  );

  if (loading) {
    // Show a "Waiting" pane while DCGM range query is in flight. The probe
    // can take a couple of seconds the first time around, so without this
    // the user sees a flash-of-empty before the chart grid appears.
    return (
      <Card title="Per-card utilisation" size="small" style={{ marginBottom: 12 }}>
        <Spin
          spinning
          tip="Loading per-GPU metrics…"
          indicator={<LoadingOutlined style={{ fontSize: 24 }} spin />}
        >
          <div style={{ minHeight: 160 }}>
            <Skeleton active paragraph={{ rows: 3 }} />
          </div>
        </Spin>
      </Card>
    );
  }

  if (devices.length === 0) {
    return (
      <Card size="small" style={{ marginBottom: 12 }}>
        <Empty
          description={
            <span>
              No per-card metrics available — install DCGM exporter and verify it scrapes <code className="mono">DCGM_FI_DEV_GPU_UTIL</code>.
            </span>
          }
        />
      </Card>
    );
  }

  return (
    <Card
      title={
        <Space>
          <span>Per-card utilisation</span>
          <Tooltip title="Sourced from DCGM_FI_DEV_GPU_UTIL via the configured Prometheus / VictoriaMetrics backend.">
            <Tag color="blue">{devices.length} GPU{devices.length === 1 ? '' : 's'}</Tag>
          </Tooltip>
        </Space>
      }
      size="small"
    >
      {/*
        With many GPUs the chart grid can balloon; cap each row at 4 cards
        on wide screens, then 2 / 1 on narrower ones. Charts are kept small
        (140px tall) so 24 GPUs fit a single page-fold without scrolling.
      */}
      <Row gutter={[12, 12]}>
        {cards.map(c => (
          <Col xs={24} md={12} lg={8} xl={6} key={c.key}>
            <Card size="small" type="inner" title={
              <Tooltip title={c.title}>
                <span className="mono" style={{ fontSize: 12 }}>{c.title}</span>
              </Tooltip>
            }>
              <div style={{ height: 140 }}>
                <ResponsiveContainer>
                  <AreaChart data={c.data}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                    <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} width={32} unit="%" />
                    <ChartTooltip formatter={(v: number) => `${v}%`} />
                    <Area type="monotone" dataKey="v" stroke="#2468f2" fill="#2468f2" fillOpacity={0.18} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </Card>
  );
}
