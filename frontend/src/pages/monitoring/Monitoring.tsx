import { useMemo, useState } from 'react';
import { Card, Row, Col, Select, Space, Radio, Tag } from 'antd';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Line,
  ComposedChart,
} from 'recharts';
import { PageHeader } from '@/components/PageHeader';
import { buildSeries, type Resource, type Scope, type Kind } from '@/data/metrics';
import { useApp } from '@/context/AppContext';
import { useNodes } from '@/data/nodes';
import { usePods } from '@/data/workloads';

const resourceOptions: { label: string; value: Resource }[] = [
  { label: 'CPU', value: 'cpu' },
  { label: 'Memory', value: 'memory' },
  { label: 'GPU', value: 'gpu' },
  { label: 'Disk', value: 'disk' },
  { label: 'Network', value: 'network' },
];

export function Monitoring() {
  const { user, namespace, namespaces } = useApp();
  const pods = usePods();
  const nodes = useNodes();

  const [scope, setScope] = useState<Scope>('cluster');
  const [target, setTarget] = useState('prod-ai-01');
  const [kinds, setKinds] = useState<Kind[]>(['usage', 'requests', 'limits']);

  const targets = useMemo(() => {
    switch (scope) {
      case 'cluster':
        return [{ label: 'prod-ai-01', value: 'prod-ai-01' }];
      case 'node':
        return nodes.map(n => ({ label: n.name, value: n.name }));
      case 'namespace':
        return namespaces.map(n => ({ label: n, value: n }));
      case 'pod':
        return pods
          .filter(p => p.namespace === namespace)
          .map(p => ({ label: p.name, value: p.name }));
    }
  }, [scope, namespaces, namespace, pods, nodes]);

  const chartData = useMemo(() => {
    const map: Record<Resource, Array<Record<string, string | number>>> = {
      cpu: [],
      memory: [],
      gpu: [],
      disk: [],
      network: [],
    };
    for (const r of resourceOptions) {
      const usage = buildSeries(scope, target, r.value, 'usage');
      const req = buildSeries(scope, target, r.value, 'requests');
      const lim = buildSeries(scope, target, r.value, 'limits');
      map[r.value] = usage.points.map((p, i) => ({
        t: p.t,
        usage: p.v,
        requests: req.points[i].v,
        limits: lim.points[i].v,
      }));
    }
    return map;
  }, [scope, target]);

  return (
    <div className="knaic-page">
      <PageHeader
        title="Resource monitoring"
        description="Time-series data pulled from the in-cluster Prometheus."
      />
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={12}>
          <Radio.Group
            value={scope}
            onChange={e => {
              const newScope = e.target.value as Scope;
              setScope(newScope);
              if (newScope === 'cluster') setTarget('prod-ai-01');
              if (newScope === 'node') setTarget(nodes[0].name);
              if (newScope === 'namespace') setTarget(namespace);
              if (newScope === 'pod') {
                const first = pods.find(p => p.namespace === namespace);
                setTarget(first?.name ?? '');
              }
            }}
          >
            <Radio.Button value="cluster">Cluster</Radio.Button>
            {user.isPlatformAdmin && <Radio.Button value="node">Nodes</Radio.Button>}
            <Radio.Button value="namespace">Namespaces</Radio.Button>
            <Radio.Button value="pod">Pods</Radio.Button>
          </Radio.Group>
          <Select
            value={target}
            onChange={setTarget}
            options={targets}
            style={{ minWidth: 240 }}
            showSearch
          />
          <Select
            mode="multiple"
            value={kinds}
            onChange={v => setKinds(v as Kind[])}
            options={[
              { label: 'Usage', value: 'usage' },
              { label: 'Requests', value: 'requests' },
              { label: 'Limits', value: 'limits' },
            ]}
            style={{ minWidth: 280 }}
            maxTagCount="responsive"
          />
          <Tag color="blue">Step 5m · last 3h</Tag>
        </Space>
      </Card>

      <Row gutter={[12, 12]}>
        {resourceOptions.map(r => (
          <Col span={12} key={r.value}>
            <Card title={r.label} size="small" extra={<span className="knaic-sub mono">{r.value}_{kinds.join('|')}</span>}>
              <div style={{ height: 220 }}>
                <ResponsiveContainer>
                  <ComposedChart data={chartData[r.value]}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                    <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    {kinds.includes('limits') && (
                      <Line type="monotone" dataKey="limits" stroke="#e94f4f" dot={false} strokeDasharray="4 4" />
                    )}
                    {kinds.includes('requests') && (
                      <Line type="monotone" dataKey="requests" stroke="#f8b418" dot={false} strokeDasharray="4 4" />
                    )}
                    {kinds.includes('usage') && (
                      <Area type="monotone" dataKey="usage" stroke="#2468f2" fill="#2468f2" fillOpacity={0.15} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
