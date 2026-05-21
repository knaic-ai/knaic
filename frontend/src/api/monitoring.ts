import { request } from './client';
import type { Kind, Resource, Scope, Series } from '@/data/metrics';

export interface MonitoringQuery {
  scope: Scope;
  target: string;
  resource: Resource;
  kind: Kind;
  start?: number;
  end?: number;
  step?: number;
}

export function queryMonitoring(q: MonitoringQuery): Promise<Series> {
  const params = new URLSearchParams({
    scope: q.scope,
    target: q.target,
    resource: q.resource,
    kind: q.kind,
  });
  if (q.start !== undefined) params.set('start', String(q.start));
  if (q.end !== undefined) params.set('end', String(q.end));
  if (q.step !== undefined) params.set('step', String(q.step));
  return request<Series>(`/api/v1/monitoring/query?${params}`);
}

// MonitoringSource mirrors backend monitoring.Source — "prometheus" when the
// upstream returned data, "synthetic" when the backend fell back to its
// deterministic generator (KNAIC_PROMETHEUS_URL empty).
export type MonitoringSource = 'prometheus' | 'synthetic';

// Bundle is the response shape for /monitoring/llm and /monitoring/training.
// Each named series shares the time axis but carries its own unit.
export interface MonitoringBundle {
  namespace: string;
  target: string;
  source: MonitoringSource;
  series: Record<string, Series>;
}

export interface LLMMonitoringQuery {
  namespace: string;
  service: string;
  start?: number;
  end?: number;
  step?: number;
}

export function queryLLMMonitoring(q: LLMMonitoringQuery): Promise<MonitoringBundle> {
  const params = new URLSearchParams({ namespace: q.namespace, service: q.service });
  if (q.start !== undefined) params.set('start', String(q.start));
  if (q.end !== undefined) params.set('end', String(q.end));
  if (q.step !== undefined) params.set('step', String(q.step));
  return request<MonitoringBundle>(`/api/v1/monitoring/llm?${params}`);
}

export interface TrainingMonitoringQuery {
  namespace: string;
  job: string;
  start?: number;
  end?: number;
  step?: number;
}

export function queryTrainingMonitoring(
  q: TrainingMonitoringQuery,
): Promise<MonitoringBundle> {
  const params = new URLSearchParams({ namespace: q.namespace, job: q.job });
  if (q.start !== undefined) params.set('start', String(q.start));
  if (q.end !== undefined) params.set('end', String(q.end));
  if (q.step !== undefined) params.set('step', String(q.step));
  return request<MonitoringBundle>(`/api/v1/monitoring/training?${params}`);
}
