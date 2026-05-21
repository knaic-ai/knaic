// Typed bindings for /api/v1/collections. Mirrors
// backend/internal/collections/types.go.

import { request } from './client';

export type CollectionScope = 'public' | 'private';

export interface CollectionDTO {
  id: string;
  name: string;
  owner: string;
  scope: CollectionScope;
  namespace?: string;
  description: string;
  iconColor?: string;
  createdAt: string;
  updatedAt: string;
}

export function listCollections(scope: CollectionScope, namespace?: string): Promise<CollectionDTO[]> {
  const qs = new URLSearchParams({ scope });
  if (scope === 'private' && namespace) qs.set('namespace', namespace);
  return request<CollectionDTO[]>(`/api/v1/collections?${qs}`);
}

export interface CreateCollectionRequest {
  id?: string;
  name: string;
  scope: CollectionScope;
  namespace?: string;
  description?: string;
  iconColor?: string;
}

export function createCollection(req: CreateCollectionRequest): Promise<CollectionDTO> {
  return request<CollectionDTO>('/api/v1/collections', { method: 'POST', body: req });
}

export interface PatchCollectionRequest {
  name?: string;
  description?: string;
  iconColor?: string;
}

export function patchCollection(id: string, req: PatchCollectionRequest): Promise<CollectionDTO> {
  return request<CollectionDTO>(`/api/v1/collections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: req,
  });
}

export function deleteCollection(id: string): Promise<void> {
  return request<void>(`/api/v1/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
