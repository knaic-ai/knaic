// Synthetic prometheus-style metrics for the monitoring dashboards.

export type Scope = 'cluster' | 'node' | 'namespace' | 'pod';
export type Resource = 'cpu' | 'memory' | 'gpu' | 'disk' | 'network';
export type Kind = 'usage' | 'requests' | 'limits';

export interface Series {
  points: { t: string; v: number }[];
  unit: string;
  total: number;
}

const units: Record<Resource, string> = {
  cpu: 'cores',
  memory: 'GiB',
  gpu: 'GPUs',
  disk: 'GiB',
  network: 'MiB/s',
};

const scales: Record<Resource, number> = {
  cpu: 64,
  memory: 512,
  gpu: 16,
  disk: 4096,
  network: 200,
};

function seed(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return () => {
    h = (h * 1103515245 + 12345) | 0;
    return ((h >>> 16) & 0x7fff) / 0x7fff;
  };
}

export function buildSeries(
  scope: Scope,
  target: string,
  resource: Resource,
  kind: Kind,
  points = 36,
): Series {
  const rand = seed(`${scope}:${target}:${resource}:${kind}`);
  const base = scales[resource] * (scope === 'cluster' ? 1 : scope === 'node' ? 0.25 : scope === 'namespace' ? 0.4 : 0.08);
  const target$ = kind === 'limits' ? base * 0.9 : kind === 'requests' ? base * 0.65 : base * 0.5;
  const data: { t: string; v: number }[] = [];
  const now = Date.now();
  for (let i = points - 1; i >= 0; i--) {
    const t = new Date(now - i * 5 * 60 * 1000);
    const wiggle = (rand() - 0.5) * 0.3 * target$;
    const pulse = Math.sin(i / 3) * 0.08 * target$;
    const v = Math.max(0, target$ + wiggle + pulse);
    data.push({ t: t.toISOString().slice(11, 16), v: +v.toFixed(2) });
  }
  return { points: data, unit: units[resource], total: scales[resource] };
}
