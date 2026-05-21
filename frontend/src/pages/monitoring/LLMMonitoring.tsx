import { useEffect, useMemo, useState } from 'react';
import { Card, Row, Col, Select, Space, Tag, Statistic, Empty } from 'antd';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area,
} from 'recharts';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import { ensureInferenceServicesLoaded, useInferenceServices } from '@/data/inference';
import { syntheticMode } from '@/api/client';
import {
  queryLLMMonitoring,
  type MonitoringBundle,
  type MonitoringSource,
} from '@/api/monitoring';

interface LLMPoint {
  t: string;
  tokensPerSec: number;
  promptTokens: number;
  completionTokens: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
}

// seed/buildLLMSeries are the synthetic fallback used when VITE_KNAIC_SYNTHETIC
// is on or the backend call fails. They reproduce the prior in-frontend mock
// shape exactly so dev mode looks identical to before this page hit the API.
function seed(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return () => {
    h = (h * 1103515245 + 12345) | 0;
    return ((h >>> 16) & 0x7fff) / 0x7fff;
  };
}

function buildLLMSeries(serviceId: string, points = 36): LLMPoint[] {
  const rand = seed(serviceId);
  const data: LLMPoint[] = [];
  const now = Date.now();
  for (let i = points - 1; i >= 0; i--) {
    const t = new Date(now - i * 5 * 60 * 1000);
    const load = 0.6 + Math.sin(i / 4) * 0.25 + (rand() - 0.5) * 0.15;
    const rps = +(20 * load).toFixed(1);
    const tps = +(950 * load + (rand() - 0.5) * 60).toFixed(0);
    const prompt = +(180 * load * 60).toFixed(0);
    const completion = +(220 * load * 60).toFixed(0);
    const p50 = +(80 + 40 * load + (rand() - 0.5) * 10).toFixed(1);
    const p95 = +(p50 * 1.8 + rand() * 30).toFixed(1);
    const p99 = +(p95 * 1.2 + rand() * 50).toFixed(1);
    data.push({
      t: t.toISOString().slice(11, 16),
      tokensPerSec: tps,
      promptTokens: prompt,
      completionTokens: completion,
      rps,
      p50,
      p95,
      p99,
    });
  }
  return data;
}

// bundleToPoints zips the named per-metric series the backend returns into
// the row-shaped LLMPoint[] the recharts components want. Series for missing
// metrics fall back to empty arrays — shorter series get padded with zeros
// so charts still render on partial Prometheus configs.
function bundleToPoints(bundle: MonitoringBundle): LLMPoint[] {
  const keys: (keyof Omit<LLMPoint, 't'>)[] = [
    'tokensPerSec',
    'promptTokens',
    'completionTokens',
    'rps',
    'p50',
    'p95',
    'p99',
  ];
  // The time axis comes from whichever series came back longest. They all
  // share the same step on the backend, but a missing metric returns an
  // empty array and we want the chart to still render the populated ones.
  let axis: string[] = [];
  for (const k of keys) {
    const s = bundle.series[k];
    if (s && s.points.length > axis.length) axis = s.points.map(p => p.t);
  }
  return axis.map((t, i) => {
    const row: LLMPoint = {
      t,
      tokensPerSec: 0,
      promptTokens: 0,
      completionTokens: 0,
      rps: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    };
    for (const k of keys) {
      const v = bundle.series[k]?.points[i]?.v;
      if (typeof v === 'number') row[k] = v;
    }
    return row;
  });
}

const kindLabel: Record<'LLMInferenceService' | 'InferenceService', string> = {
  LLMInferenceService: 'LLM',
  InferenceService: 'Classic',
};

const kindColor: Record<'LLMInferenceService' | 'InferenceService', string> = {
  LLMInferenceService: 'blue',
  InferenceService: 'purple',
};

const sourceColor: Record<MonitoringSource | 'fallback', string> = {
  prometheus: 'green',
  synthetic: 'gold',
  fallback: 'orange',
};

export function LLMMonitoring() {
  const { namespace } = useApp();
  const services = useInferenceServices();
  const [series, setSeries] = useState<LLMPoint[]>([]);
  const [source, setSource] = useState<MonitoringSource | 'fallback'>(
    syntheticMode ? 'synthetic' : 'prometheus',
  );

  useEffect(() => {
    ensureInferenceServicesLoaded(namespace);
  }, [namespace]);

  // Both kinds expose tokens / latency / RPS through the same Prometheus
  // metrics (the LLM-d exporter and KServe v1beta1's predictor both publish
  // OpenTelemetry-style histograms), so the same dashboard works for both.
  const inferenceServices = useMemo(
    () => services.filter(s => s.namespace === namespace),
    [services, namespace],
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(inferenceServices[0]?.id);
  // Reset the selection when the namespace flips so we don't keep pointing
  // at a service that's no longer in the filtered list.
  useEffect(() => {
    if (inferenceServices.length === 0) {
      setSelectedId(undefined);
      return;
    }
    if (!inferenceServices.some(s => s.id === selectedId)) {
      setSelectedId(inferenceServices[0].id);
    }
  }, [inferenceServices, selectedId]);
  const selected = inferenceServices.find(s => s.id === selectedId) ?? inferenceServices[0];

  useEffect(() => {
    if (!selected) {
      setSeries([]);
      return;
    }
    if (syntheticMode) {
      setSeries(buildLLMSeries(selected.id));
      setSource('synthetic');
      return;
    }
    let cancelled = false;
    queryLLMMonitoring({ namespace: selected.namespace, service: selected.name })
      .then(bundle => {
        if (cancelled) return;
        setSeries(bundleToPoints(bundle));
        setSource(bundle.source);
      })
      .catch(() => {
        if (cancelled) return;
        // Backend unreachable / errored — fall back to local synthetic so
        // the page still renders something rather than an empty grid.
        setSeries(buildLLMSeries(selected.id));
        setSource('fallback');
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const last = series[series.length - 1];
  const avg = (key: keyof LLMPoint) =>
    series.length
      ? +(series.reduce((s, p) => s + (p[key] as number), 0) / series.length).toFixed(1)
      : 0;

  if (inferenceServices.length === 0) {
    return (
      <div className="knaic-page">
        <PageHeader
          title="Inference service monitoring"
          description="Tokens/s, token usage, RPS, and latency for InferenceService and LLMInferenceService."
        />
        <Empty description={`No InferenceService or LLMInferenceService in namespace ${namespace}.`} />
      </div>
    );
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="Inference service monitoring"
        description="Tokens/s, token usage, RPS, and latency pulled from the LLM-d / KServe Prometheus exporters. Works for both InferenceService and LLMInferenceService."
      />
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={12}>
          <span className="knaic-sub">Service:</span>
          <Select
            value={selected?.id}
            onChange={setSelectedId}
            style={{ minWidth: 360 }}
            options={inferenceServices.map(s => ({
              // Tag the option label so the user can tell the two kinds apart
              // at a glance — the same name might exist in both flavours.
              label: (
                <Space size={6}>
                  <span>{s.name}</span>
                  <Tag color={kindColor[s.kind]} style={{ marginRight: 0 }}>
                    {kindLabel[s.kind]}
                  </Tag>
                  <span className="knaic-sub">· {s.runtime}</span>
                </Space>
              ),
              value: s.id,
            }))}
          />
          {selected && (
            <Tag color={kindColor[selected.kind]}>
              {selected.kind}
            </Tag>
          )}
          <Tag color="default">{selected?.modelUri}</Tag>
          <Tag>Step 5m · last 3h</Tag>
          <Tag color={sourceColor[source]}>{source}</Tag>
        </Space>
      </Card>

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="Tokens / s (now)" value={last?.tokensPerSec ?? 0} suffix="tok/s" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="Requests / s (avg)" value={avg('rps')} suffix="rps" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="p95 latency (now)" value={last?.p95 ?? 0} suffix="ms" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Tokens (last 3h)"
              value={series.reduce((s, p) => s + p.promptTokens + p.completionTokens, 0)}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col span={12}>
          <Card title="Tokens / s" size="small">
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <AreaChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="tokensPerSec" stroke="#2468f2" fill="#2468f2" fillOpacity={0.18} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Token usage (prompt + completion)" size="small">
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <AreaChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="promptTokens"
                    stackId="1"
                    stroke="#0ea5e9"
                    fill="#0ea5e9"
                    fillOpacity={0.4}
                    name="prompt"
                  />
                  <Area
                    type="monotone"
                    dataKey="completionTokens"
                    stackId="1"
                    stroke="#a855f7"
                    fill="#a855f7"
                    fillOpacity={0.4}
                    name="completion"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Requests / s" size="small">
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="rps" stroke="#10b981" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Latency (ms)" size="small">
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="p50" stroke="#2468f2" dot={false} name="p50" />
                  <Line type="monotone" dataKey="p95" stroke="#f8b418" dot={false} name="p95" />
                  <Line type="monotone" dataKey="p99" stroke="#e94f4f" dot={false} name="p99" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
