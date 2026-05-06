// Typed bindings for /api/v1/components and /api/v1/registry.
//
// The shape mirrors the Go types in knaic-backend/internal/components/types.go
// and registry/store.go — keep them in sync.

import { request } from './client';
import type { ComponentItem, RegistryConfig } from '@/data/components';

export function listComponents(signal?: AbortSignal): Promise<ComponentItem[]> {
  return request<ComponentItem[]>('/api/v1/components', { signal });
}

export function patchComponent(
  name: string,
  patch: { selectedVersion?: string },
): Promise<ComponentItem> {
  return request<ComponentItem>(`/api/v1/components/${name}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function installComponentApi(name: string): Promise<ComponentItem> {
  return request<ComponentItem>(`/api/v1/components/${name}/install`, { method: 'POST' });
}

export function uninstallComponentApi(name: string): Promise<ComponentItem> {
  return request<ComponentItem>(`/api/v1/components/${name}/uninstall`, { method: 'POST' });
}

export function reconcileComponentApi(name: string): Promise<ComponentItem> {
  return request<ComponentItem>(`/api/v1/components/${name}/reconcile`, { method: 'POST' });
}

export function fetchComponentStatus(name: string, signal?: AbortSignal): Promise<ComponentItem> {
  return request<ComponentItem>(`/api/v1/components/status?name=${encodeURIComponent(name)}`, { signal });
}

export interface ImportRequest {
  name: string;
  displayName?: string;
  description?: string;
  category: string;
  version: string;
  namespace?: string;
  images: string[];
}

export function importComponent(req: ImportRequest): Promise<ComponentItem> {
  return request<ComponentItem>('/api/v1/components', { method: 'POST', body: req });
}

export function deleteComponent(name: string): Promise<void> {
  return request<void>(`/api/v1/components/${name}`, { method: 'DELETE' });
}

export function getRegistry(): Promise<RegistryConfig> {
  return request<RegistryConfig>('/api/v1/registry');
}

export function patchRegistry(patch: Partial<RegistryConfig>): Promise<RegistryConfig> {
  return request<RegistryConfig>('/api/v1/registry', { method: 'PATCH', body: patch });
}

export function syncRegistry(): Promise<RegistryConfig> {
  return request<RegistryConfig>('/api/v1/registry/sync', { method: 'POST' });
}
