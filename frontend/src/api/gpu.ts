// Typed bindings for /api/v1/gpu/* — see internal/gpu and internal/api.

import { request } from './client';

export interface GPUCounts {
  total: number;
  used: number;
  available: number;
}

export interface GPUVendorSummary {
  vendor: string;
  keys: string[];
  counts: GPUCounts;
  byKey: Record<string, GPUCounts>;
  primary: string;
}

export interface GPUNodeSummary {
  node: string;
  capacity: Record<string, number>;
  allocated: Record<string, number>;
  pods: number;
}

export interface GPUContainerUsage {
  name: string;
  resources: Record<string, number>;
}

export interface GPUPodUsage {
  namespace: string;
  name: string;
  node?: string;
  phase: string;
  resources: Record<string, number>;
  containers: GPUContainerUsage[];
}

export interface GPUStatus {
  scope: string;
  target?: string;
  summary: GPUCounts;
  vendors: GPUVendorSummary[];
  nodes: GPUNodeSummary[];
  pods: GPUPodUsage[];
}

export function fetchGPUStatus(scope: 'cluster' | 'namespace', target?: string): Promise<GPUStatus> {
  const params = new URLSearchParams({ scope });
  if (target) params.set('target', target);
  return request<GPUStatus>(`/api/v1/gpu/status?${params}`);
}

export interface GPUDeviceUsage {
  node: string;
  gpu: string;          // host-local GPU index (0, 1, …)
  uuid?: string;
  modelName?: string;
  points: Array<{ t: string; v: number }>;
}

export function fetchGPUDeviceUsage(opts: { start?: number; end?: number; step?: number } = {}): Promise<GPUDeviceUsage[]> {
  const p = new URLSearchParams();
  if (opts.start) p.set('start', String(opts.start));
  if (opts.end) p.set('end', String(opts.end));
  if (opts.step) p.set('step', String(opts.step));
  return request<GPUDeviceUsage[]>(`/api/v1/gpu/device-usage?${p}`);
}
