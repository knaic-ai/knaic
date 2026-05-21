import { useEffect, useMemo, useState } from 'react';
import { Card, Row, Col, Select, Space, Tag, Statistic, Empty } from 'antd';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area,
} from 'recharts';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import { useTrainJobs } from '@/data/training';
import { syntheticMode } from '@/api/client';
import {
  queryTrainingMonitoring,
  type MonitoringBundle,
  type MonitoringSource,
} from '@/api/monitoring';

interface TrainPoint {
  t: string;
  gpuUtil: number;
  gpuMemGiB: number;
  hostCpu: number;
  hostMemGiB: number;
  netRxMiB: number;
  netTxMiB: number;
}

function seed(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return () => {
    h = (h * 1103515245 + 12345) | 0;
    return ((h >>> 16) & 0x7fff) / 0x7fff;
  };
}

// buildTrainSeries is the local synthetic fallback used when synthetic mode
// is on (VITE_KNAIC_SYNTHETIC) or the backend call fails. The shape matches
// the previous in-frontend mock so dev mode looks identical.
function buildTrainSeries(jobId: string, points = 36): TrainPoint[] {
  const rand = seed(jobId);
  const data: TrainPoint[] = [];
  const now = Date.now();
  for (let i = points - 1; i >= 0; i--) {
    const t = new Date(now - i * 5 * 60 * 1000);
    const phase = Math.sin(i / 5);
    const util = Math.min(100, Math.max(0, 78 + phase * 18 + (rand() - 0.5) * 6));
    data.push({
      t: t.toISOString().slice(11, 16),
      gpuUtil: +util.toFixed(1),
      gpuMemGiB: +(36 + phase * 4 + (rand() - 0.5) * 2).toFixed(1),
      hostCpu: +(8 + phase * 2 + (rand() - 0.5)).toFixed(1),
      hostMemGiB: +(48 + phase * 6 + (rand() - 0.5) * 4).toFixed(1),
      netRxMiB: +(420 + phase * 80 + (rand() - 0.5) * 60).toFixed(0),
      netTxMiB: +(380 + phase * 70 + (rand() - 0.5) * 60).toFixed(0),
    });
  }
  return data;
}

function bundleToPoints(bundle: MonitoringBundle): TrainPoint[] {
  const keys: (keyof Omit<TrainPoint, 't'>)[] = [
    'gpuUtil',
    'gpuMemGiB',
    'hostCpu',
    'hostMemGiB',
    'netRxMiB',
    'netTxMiB',
  ];
  let axis: string[] = [];
  for (const k of keys) {
    const s = bundle.series[k];
    if (s && s.points.length > axis.length) axis = s.points.map(p => p.t);
  }
  return axis.map((t, i) => {
    const row: TrainPoint = {
      t,
      gpuUtil: 0,
      gpuMemGiB: 0,
      hostCpu: 0,
      hostMemGiB: 0,
      netRxMiB: 0,
      netTxMiB: 0,
    };
    for (const k of keys) {
      const v = bundle.series[k]?.points[i]?.v;
      if (typeof v === 'number') row[k] = v;
    }
    return row;
  });
}

const sourceColor: Record<MonitoringSource | 'fallback', string> = {
  prometheus: 'green',
  synthetic: 'gold',
  fallback: 'orange',
};

export function TrainMonitoring() {
  const { namespace } = useApp();
  const jobs = useTrainJobs();
  const nsJobs = useMemo(() => jobs.filter(j => j.namespace === namespace), [jobs, namespace]);
  const [selectedId, setSelectedId] = useState<string | undefined>(nsJobs[0]?.id);
  const selected = nsJobs.find(j => j.id === selectedId) ?? nsJobs[0];
  const [series, setSeries] = useState<TrainPoint[]>([]);
  const [source, setSource] = useState<MonitoringSource | 'fallback'>(
    syntheticMode ? 'synthetic' : 'prometheus',
  );

  useEffect(() => {
    if (!selected) {
      setSeries([]);
      return;
    }
    if (syntheticMode) {
      setSeries(buildTrainSeries(selected.id));
      setSource('synthetic');
      return;
    }
    let cancelled = false;
    queryTrainingMonitoring({ namespace: selected.namespace, job: selected.name })
      .then(bundle => {
        if (cancelled) return;
        setSeries(bundleToPoints(bundle));
        setSource(bundle.source);
      })
      .catch(() => {
        if (cancelled) return;
        setSeries(buildTrainSeries(selected.id));
        setSource('fallback');
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const last = series[series.length - 1];

  if (nsJobs.length === 0) {
    return (
      <div className="knaic-page">
        <PageHeader
          title="Train job monitoring"
          description="GPU/CPU/memory and network throughput for TrainJobs."
        />
        <Empty description={`No TrainJobs in namespace ${namespace}.`} />
      </div>
    );
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="Train job monitoring"
        description="DCGM and node-exporter metrics aggregated across TrainJob worker pods."
      />
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={12}>
          <span className="knaic-sub">TrainJob:</span>
          <Select
            value={selected?.id}
            onChange={setSelectedId}
            style={{ minWidth: 320 }}
            options={nsJobs.map(j => ({
              label: `${j.name} · ${j.runtime} · ${j.status}`,
              value: j.id,
            }))}
          />
          <Tag color="blue">{selected?.numNodes ?? 1} node(s)</Tag>
          {selected?.gpuValues && (
            <Tag color="purple">
              {Object.entries(selected.gpuValues).map(([k, v]) => `${k.split('/').pop()}=${v}`).join(' ')}
            </Tag>
          )}
          <Tag>Step 5m · last 3h</Tag>
          <Tag color={sourceColor[source]}>{source}</Tag>
        </Space>
      </Card>

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="GPU util (now)" value={last?.gpuUtil ?? 0} suffix="%" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="GPU mem (now)" value={last?.gpuMemGiB ?? 0} suffix="GiB" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="Host CPU (now)" value={last?.hostCpu ?? 0} suffix="cores" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="Host mem (now)" value={last?.hostMemGiB ?? 0} suffix="GiB" />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col span={12}>
          <Card title="GPU utilization (%)" size="small">
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <AreaChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} />
                  <Tooltip />
                  <Area type="monotone" dataKey="gpuUtil" stroke="#2468f2" fill="#2468f2" fillOpacity={0.18} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="GPU memory (GiB)" size="small">
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <AreaChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="gpuMemGiB" stroke="#a855f7" fill="#a855f7" fillOpacity={0.18} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Host CPU / memory" size="small">
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="hostCpu" stroke="#10b981" dot={false} name="cpu (cores)" />
                  <Line type="monotone" dataKey="hostMemGiB" stroke="#f8b418" dot={false} name="memory (GiB)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Network throughput (MiB/s)" size="small">
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="netRxMiB" stroke="#0ea5e9" dot={false} name="rx" />
                  <Line type="monotone" dataKey="netTxMiB" stroke="#e94f4f" dot={false} name="tx" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
