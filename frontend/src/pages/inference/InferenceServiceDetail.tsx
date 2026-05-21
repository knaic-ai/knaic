import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Result,
  Row,
  Skeleton,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ApiOutlined,
  ArrowLeftOutlined,
  CodeOutlined,
  CopyOutlined,
  GlobalOutlined,
  LineChartOutlined,
  LockOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip as ReTooltip,
  LineChart,
  Line,
} from 'recharts';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { useApp } from '@/context/AppContext';
import {
  ensureInferenceServicesLoaded,
  useInferenceServices,
  type InferenceService,
} from '@/data/inference';
import {
  fetchGatewayConfig,
  fetchServiceRouteStatus,
  type GatewayConfigDTO,
  type ServiceRouteStatusDTO,
} from '@/api/inference';
import { queryLLMMonitoring, type MonitoringSource } from '@/api/monitoring';
import { syntheticMode } from '@/api/client';

const { Paragraph, Text } = Typography;

// LLMPoint mirrors what the monitoring page uses but lives here to keep this
// detail page self-contained — the monitoring page can stay focused on its
// own selector + chart layout.
interface LLMPoint {
  t: string;
  tokensPerSec: number;
  rps: number;
  p95: number;
  promptTokens: number;
  completionTokens: number;
}

// seed/buildLLMSeries match the prior in-frontend synthetic shape so the
// detail page degrades gracefully when Prometheus isn't reachable.
function seedFn(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return () => {
    h = (h * 1103515245 + 12345) | 0;
    return ((h >>> 16) & 0x7fff) / 0x7fff;
  };
}

function buildLLMSeries(id: string, points = 36): LLMPoint[] {
  const rand = seedFn(id);
  const out: LLMPoint[] = [];
  const now = Date.now();
  for (let i = points - 1; i >= 0; i--) {
    const t = new Date(now - i * 5 * 60 * 1000);
    const load = 0.6 + Math.sin(i / 4) * 0.25 + (rand() - 0.5) * 0.15;
    const rps = +(20 * load).toFixed(1);
    const tps = +(950 * load + (rand() - 0.5) * 60).toFixed(0);
    const p50 = +(80 + 40 * load + (rand() - 0.5) * 10).toFixed(1);
    const p95 = +(p50 * 1.8 + rand() * 30).toFixed(1);
    out.push({
      t: t.toISOString().slice(11, 16),
      tokensPerSec: tps,
      rps,
      p95,
      promptTokens: +(180 * load * 60).toFixed(0),
      completionTokens: +(220 * load * 60).toFixed(0),
    });
  }
  return out;
}

const sourceColor: Record<MonitoringSource | 'fallback', string> = {
  prometheus: 'green',
  synthetic: 'gold',
  fallback: 'orange',
};

// Inference Service detail page (/inference/services/:namespace/:name).
//
// Single page that stacks four cards:
//   1. Identity + endpoint (top banner)
//   2. Gateway access (kserve-ingress-gateway status, sample curl)
//   3. Routes + rate limits (per-service Envoy AI Gateway picture)
//   4. Monitor (last 3h: tokens/s, rps, p95, prompt+completion)
//
// Most cards degrade independently: if the backend can't reach Prometheus
// or the gateway CRDs aren't installed, the rest of the page still works.
export function InferenceServiceDetailPage() {
  const { namespace: nsParam, name } = useParams<{ namespace: string; name: string }>();
  const { namespace } = useApp();
  const { message } = App.useApp();
  const nav = useNavigate();
  const services = useInferenceServices();

  // The :namespace URL param wins so a bookmarked detail link survives a
  // namespace switch — we just adopt that namespace when entering the page.
  const targetNS = nsParam ?? namespace;

  useEffect(() => {
    ensureInferenceServicesLoaded(targetNS);
  }, [targetNS]);

  const svc: InferenceService | undefined = useMemo(
    () => services.find(s => s.namespace === targetNS && s.name === name),
    [services, targetNS, name],
  );

  // Gateway config: cluster-wide so we don't gate it on having a service.
  const [gateway, setGateway] = useState<GatewayConfigDTO | null>(null);
  const [routes, setRoutes] = useState<ServiceRouteStatusDTO | null>(null);
  const [series, setSeries] = useState<LLMPoint[]>([]);
  const [source, setSource] = useState<MonitoringSource | 'fallback'>(
    syntheticMode ? 'synthetic' : 'prometheus',
  );

  useEffect(() => {
    fetchGatewayConfig()
      .then(setGateway)
      .catch(() => setGateway(null));
  }, []);

  useEffect(() => {
    if (!name) return;
    fetchServiceRouteStatus(targetNS, name)
      .then(setRoutes)
      .catch(() => setRoutes(null));
  }, [targetNS, name]);

  useEffect(() => {
    if (!svc) {
      setSeries([]);
      return;
    }
    if (syntheticMode) {
      setSeries(buildLLMSeries(svc.id));
      setSource('synthetic');
      return;
    }
    let cancelled = false;
    queryLLMMonitoring({ namespace: svc.namespace, service: svc.name })
      .then(bundle => {
        if (cancelled) return;
        // bundleToPoints inlined — only the metrics we render here.
        const pts: LLMPoint[] = [];
        const axis = bundle.series['tokensPerSec']?.points ?? [];
        for (let i = 0; i < axis.length; i++) {
          pts.push({
            t: axis[i].t,
            tokensPerSec: bundle.series['tokensPerSec']?.points[i]?.v ?? 0,
            rps: bundle.series['rps']?.points[i]?.v ?? 0,
            p95: bundle.series['p95']?.points[i]?.v ?? 0,
            promptTokens: bundle.series['promptTokens']?.points[i]?.v ?? 0,
            completionTokens: bundle.series['completionTokens']?.points[i]?.v ?? 0,
          });
        }
        setSeries(pts);
        setSource(bundle.source);
      })
      .catch(() => {
        if (cancelled) return;
        setSeries(buildLLMSeries(svc.id));
        setSource('fallback');
      });
    return () => {
      cancelled = true;
    };
  }, [svc]);

  if (!svc) {
    return (
      <div className="knaic-page">
        <PageHeader
          title={name ?? 'Inference service'}
          description={`Namespace: ${targetNS}`}
        />
        <Result
          status="404"
          title="Inference service not found"
          subTitle={`No InferenceService or LLMInferenceService named "${name}" in namespace "${targetNS}".`}
          extra={
            <Button onClick={() => nav('/inference/services')} icon={<ArrowLeftOutlined />}>
              Back to list
            </Button>
          }
        />
      </div>
    );
  }

  const last = series[series.length - 1];
  const avg = (key: keyof LLMPoint) =>
    series.length
      ? +(
          series.reduce((s, p) => s + (p[key] as number), 0) /
          series.length
        ).toFixed(1)
      : 0;

  // Suggested cluster-internal endpoint when KServe didn't publish one yet
  // (e.g. Progressing state). The shape mirrors KServe's status.url default
  // for the cluster-local protocol port.
  const internalURL =
    svc.endpoint ||
    `http://${svc.name}-predictor.${svc.namespace}.svc.cluster.local/v1`;

  const gatewayHost =
    gateway?.ingressDomain && gateway.urlScheme
      ? `${gateway.urlScheme}://${svc.name}-${svc.namespace}.${gateway.ingressDomain}`
      : '';

  const copy = (s: string) => {
    navigator.clipboard.writeText(s).then(
      () => message.success('Copied'),
      () => message.error('Copy failed'),
    );
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title={svc.name}
        description={`Namespace: ${svc.namespace} · Kind: ${svc.kind}`}
        extra={
          <Space>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => nav('/inference/services')}
            >
              Back
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                if (name) {
                  fetchServiceRouteStatus(targetNS, name).then(setRoutes).catch(() => null);
                }
                fetchGatewayConfig().then(setGateway).catch(() => null);
              }}
            >
              Refresh
            </Button>
          </Space>
        }
      />

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space size={12} wrap>
          <Tag color={svc.kind === 'LLMInferenceService' ? 'blue' : 'purple'}>
            {svc.kind}
          </Tag>
          <StatusTag value={svc.status} />
          {svc.deploymentMode && <Tag color="cyan">{svc.deploymentMode}</Tag>}
          {svc.runtime && <Tag>runtime: {svc.runtime}</Tag>}
          <Tag color="default" style={{ fontFamily: 'monospace' }}>
            {svc.modelUri}
          </Tag>
          <Tag>
            replicas: {svc.minReplicas}
            {svc.maxReplicas !== svc.minReplicas ? ` – ${svc.maxReplicas}` : ''}
          </Tag>
        </Space>
        <Paragraph style={{ marginTop: 12, marginBottom: 0 }}>
          <Text type="secondary">Internal endpoint: </Text>
          <Text code copyable={{ text: internalURL, onCopy: () => message.success('Copied') }}>
            {internalURL}
          </Text>
        </Paragraph>
      </Card>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <GlobalOutlined /> Gateway access
              </Space>
            }
          >
            <GatewayAccessPanel
              gateway={gateway}
              svc={svc}
              gatewayHost={gatewayHost}
              onCopy={copy}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <ApiOutlined /> Routes &amp; rate limits
              </Space>
            }
          >
            <RoutesPanel routes={routes} />
          </Card>
        </Col>
        <Col span={24}>
          <Card
            size="small"
            title={
              <Space>
                <LineChartOutlined /> Monitor (last 3h)
                <Tag color={sourceColor[source]} style={{ marginLeft: 4 }}>
                  {source}
                </Tag>
              </Space>
            }
          >
            {series.length === 0 ? (
              <Empty description="No metric data" />
            ) : (
              <>
                <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                  <Col span={6}>
                    <Statistic
                      title="Tokens / s"
                      value={last?.tokensPerSec ?? 0}
                      suffix="tok/s"
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="Requests / s (avg)"
                      value={avg('rps')}
                      suffix="rps"
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="p95 latency"
                      value={last?.p95 ?? 0}
                      suffix="ms"
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="Tokens (3h)"
                      value={series.reduce(
                        (s, p) => s + p.promptTokens + p.completionTokens,
                        0,
                      )}
                    />
                  </Col>
                </Row>
                <Row gutter={[12, 12]}>
                  <Col xs={24} md={12}>
                    <div style={{ height: 200 }}>
                      <ResponsiveContainer>
                        <AreaChart data={series}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                          <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                          <YAxis tick={{ fontSize: 10 }} />
                          <ReTooltip />
                          <Area
                            type="monotone"
                            dataKey="tokensPerSec"
                            stroke="#2468f2"
                            fill="#2468f2"
                            fillOpacity={0.18}
                            name="tok/s"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </Col>
                  <Col xs={24} md={12}>
                    <div style={{ height: 200 }}>
                      <ResponsiveContainer>
                        <LineChart data={series}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                          <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                          <YAxis tick={{ fontSize: 10 }} />
                          <ReTooltip />
                          <Line
                            type="monotone"
                            dataKey="rps"
                            stroke="#10b981"
                            dot={false}
                            strokeWidth={2}
                            name="rps"
                          />
                          <Line
                            type="monotone"
                            dataKey="p95"
                            stroke="#f8b418"
                            dot={false}
                            strokeWidth={2}
                            name="p95 ms"
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </Col>
                </Row>
              </>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}

interface GatewayAccessPanelProps {
  gateway: GatewayConfigDTO | null;
  svc: InferenceService;
  gatewayHost: string;
  onCopy: (s: string) => void;
}

// GatewayAccessPanel renders the "how do I reach my service?" block: the
// KServe configmap toggle, the kserve-ingress-gateway addresses (if any),
// and a sample curl that includes the x-ai-eg-model header when an Envoy
// AI Gateway route is in play.
function GatewayAccessPanel({ gateway, svc, gatewayHost, onCopy }: GatewayAccessPanelProps) {
  if (!gateway) {
    return <Skeleton active paragraph={{ rows: 3 }} />;
  }
  if (!gateway.ingressGatewayApiEnabled) {
    return (
      <Alert
        type="info"
        showIcon
        message="Gateway API ingress is disabled in KServe"
        description={
          <span>
            <code>ingress.enableGatewayApi</code> is <code>false</code> in the
            <code> inferenceservice-config</code> configmap. KServe will only
            expose this service via the cluster-internal Service.
          </span>
        }
      />
    );
  }
  const gw = gateway.gateway;
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap>
        <Tag color="green" icon={<SafetyCertificateOutlined />}>
          Gateway API
        </Tag>
        {gateway.envoyAiGatewayInstalled ? (
          <Tag color="blue" icon={<ThunderboltOutlined />}>
            Envoy AI Gateway
          </Tag>
        ) : (
          <Tag icon={<LockOutlined />}>Envoy AI Gateway: not installed</Tag>
        )}
        {gateway.defaultDeploymentMode && (
          <Tag color="cyan">default: {gateway.defaultDeploymentMode}</Tag>
        )}
      </Space>
      {gw ? (
        <Card size="small" type="inner" title={`Gateway · ${gw.namespace}/${gw.name}`}>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space wrap>
              <StatusTag value={gw.status === 'Accepted' ? 'Ready' : gw.status} />
              {gw.gatewayClassName && (
                <Tag color="default">class: {gw.gatewayClassName}</Tag>
              )}
              {(gw.listeners ?? []).map(l => (
                <Tag key={l}>{l}</Tag>
              ))}
            </Space>
            {(gw.addresses ?? []).map(addr => (
              <Tooltip key={addr} title="Click to copy">
                <span>
                  <Text code>{addr}</Text>{' '}
                  <Button
                    size="small"
                    type="text"
                    icon={<CopyOutlined />}
                    onClick={() => onCopy(addr)}
                  />
                </span>
              </Tooltip>
            ))}
            {gw.addresses?.length === 0 && (
              <Text type="secondary">
                Gateway is {gw.status}. No external addresses programmed yet.
              </Text>
            )}
          </Space>
        </Card>
      ) : (
        <Alert
          type="warning"
          showIcon
          message="kserve-ingress-gateway not found"
          description="Configure it from the Inference · Gateway page."
        />
      )}
      {gatewayHost && (
        <Card size="small" type="inner" title="Sample request">
          <Paragraph copyable={{ text: sampleCurl(svc, gatewayHost), onCopy: () => onCopy(sampleCurl(svc, gatewayHost)) }}>
            <Text code style={{ whiteSpace: 'pre-wrap', display: 'block' }}>
              {sampleCurl(svc, gatewayHost)}
            </Text>
          </Paragraph>
        </Card>
      )}
    </Space>
  );
}

// sampleCurl renders a copyable curl that mirrors the Envoy AI Gateway docs'
// example: a header-based model match against an OpenAI-style payload.
function sampleCurl(svc: InferenceService, gatewayHost: string): string {
  return `curl -X POST ${gatewayHost}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -H 'x-ai-eg-model: ${svc.name}' \\
  -H 'x-user-id: alice' \\
  -d '{"model":"${svc.name}","messages":[{"role":"user","content":"hello"}]}'`;
}

interface RoutesPanelProps {
  routes: ServiceRouteStatusDTO | null;
}

function RoutesPanel({ routes }: RoutesPanelProps) {
  if (!routes) {
    return <Skeleton active paragraph={{ rows: 3 }} />;
  }
  if (routes.routes.length === 0 && routes.rateLimits.length === 0) {
    return (
      <Empty
        description={
          <span>
            No HTTPRoute / AIGatewayRoute targets this service yet.
            <br />
            Use <b>Inference · Gateway</b> to create one.
          </span>
        }
      />
    );
  }
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {routes.routes.map(r => (
        <Card
          key={`${r.kind}-${r.namespace}-${r.name}`}
          size="small"
          type="inner"
          title={
            <Space>
              <CodeOutlined />
              <span>{r.kind}</span>
              <Tag>{`${r.namespace}/${r.name}`}</Tag>
            </Space>
          }
        >
          <Space direction="vertical" size={4}>
            <Space wrap>
              {r.parentName && <Tag color="blue">attached to: {r.parentName}</Tag>}
              {r.status && (
                <StatusTag value={r.status === 'Accepted' ? 'Ready' : r.status} />
              )}
            </Space>
            {(r.hostnames ?? []).map(h => (
              <Text key={h} code>
                {h}
              </Text>
            ))}
          </Space>
        </Card>
      ))}
      {routes.rateLimits.map(p => (
        <Card
          key={`${p.namespace}-${p.name}`}
          size="small"
          type="inner"
          title={
            <Space>
              <SettingOutlined />
              <span>BackendTrafficPolicy</span>
              <Tag>{`${p.namespace}/${p.name}`}</Tag>
            </Space>
          }
        >
          <Space wrap>
            <Tag color="gold">{p.type || 'Global'}</Tag>
            {(p.summaries ?? []).map(s => (
              <Tag key={s} color="orange">
                {s}
              </Tag>
            ))}
            {p.targetName && (
              <Tag color="default">
                targets {p.targetKind || 'Route'}: {p.targetName}
              </Tag>
            )}
          </Space>
        </Card>
      ))}
    </Space>
  );
}
