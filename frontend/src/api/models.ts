// Typed bindings for /api/v1/models. Mirrors backend/internal/models/types.go.

import { request } from './client';
import type { ModelItem, ModelScope } from '@/data/models';

export function listModels(scope: ModelScope, namespace?: string): Promise<ModelItem[]> {
  const qs = new URLSearchParams({ scope });
  if (scope === 'private' && namespace) qs.set('namespace', namespace);
  return request<ModelItem[]>(`/api/v1/models?${qs}`);
}

export interface CreateModelRequest {
  name: string;
  owner?: string;
  scope: ModelScope;
  namespace?: string;
  uri: string;
  tags?: string[];
  modelType?: string;
  sizeGB?: number;
  readme?: string;
}

export function createModel(req: CreateModelRequest): Promise<ModelItem> {
  return request<ModelItem>('/api/v1/models', { method: 'POST', body: req });
}

export interface ImportModelRequest {
  url: string;
  scope: ModelScope;
  namespace?: string;
}

export function importModel(req: ImportModelRequest): Promise<ModelItem> {
  return request<ModelItem>('/api/v1/models/import', { method: 'POST', body: req });
}

export interface UploadModelRequest {
  name: string;
  scope: ModelScope;
  namespace?: string;
  targetUri: string;
  modelType?: string;
  sizeGB?: number;
  tags?: string[];
  readme?: string;
}

export function uploadModel(req: UploadModelRequest): Promise<ModelItem> {
  return request<ModelItem>('/api/v1/models/upload', { method: 'POST', body: req });
}

export function patchModel(
  id: string,
  patch: { readme?: string; tags?: string[]; incDownloads?: number },
): Promise<ModelItem> {
  return request<ModelItem>(`/api/v1/models/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function deleteModel(id: string): Promise<void> {
  return request<void>(`/api/v1/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
