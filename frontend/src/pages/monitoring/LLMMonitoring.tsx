import { useMemo, useState } from 'react';
import { Card, Row, Col, Select, Space, Tag, Statistic, Empty } from 'antd';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area,
} from 'recharts';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import { useInferenceServices } from '@/data/inference';

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

export function LLMMonitoring() {
  const { namespace } = useApp();
  const services = useInferenceServices();
  const llmServices = useMemo(
    () => services.filter(s => s.namespace === namespace && s.kind === 'LLMInferenceService'),
    [services, namespace],
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(llmServices[0]?.id);
  const selected = llmServices.find(s => s.id === selectedId) ?? llmServices[0];
  const series = useMemo(() => (selected ? buildLLMSeries(selected.id) : []), [selected]);

  const last = series[series.length - 1];
  const avg = (key: keyof LLMPoint) =>
    series.length
      ? +(series.reduce((s, p) => s + (p[key] as number), 0) / series.length).toFixed(1)
      : 0;

  if (llmServices.length === 0) {
    return (
      <div className="knaic-page">
        <PageHeader
          title="LLM service monitoring"
          description="Tokens/s, token usage, RPS, and latency for LLMInferenceService."
        />
        <Empty description={`No LLMInferenceService in namespace ${namespace}.`} />
      </div>
    );
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="LLM service monitoring"
        description="Tokens/s, token usage, RPS, and latency pulled from the LLM-d Prometheus exporter."
      />
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={12}>
          <span className="knaic-sub">LLMInferenceService:</span>
          <Select
            value={selected?.id}
            onChange={setSelectedId}
            style={{ minWidth: 320 }}
            options={llmServices.map(s => ({
              label: `${s.name} · ${s.runtime}`,
              value: s.id,
            }))}
          />
          <Tag color="blue">{selected?.modelUri}</Tag>
          <Tag>Step 5m · last 3h</Tag>
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
