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
