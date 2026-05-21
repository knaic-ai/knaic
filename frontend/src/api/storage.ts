import { request } from './client';

export type StorageKind = 's3' | 'oci' | 'pvc';

// StorageTargetDTO is the wire shape returned by /api/v1/storage/targets.
// Mirrors backend storage.Target — keep field names in sync.
export interface StorageTargetDTO {
  id: string;
  name: string;
  kind: StorageKind;
  endpoint: string;
  bucket?: string;
  prefix?: string;
  builtin: boolean;
  createdAt?: string;
}

export interface CreateStorageTargetInput {
  name: string;
  kind: StorageKind;
  endpoint: string;
  bucket?: string;
  prefix?: string;
}

export interface PatchStorageTargetInput {
  name?: string;
  endpoint?: string;
  bucket?: string;
  prefix?: string;
}

export function listStorageTargets(): Promise<StorageTargetDTO[]> {
  return request<StorageTargetDTO[]>('/api/v1/storage/targets');
}

export function createStorageTarget(in_: CreateStorageTargetInput): Promise<StorageTargetDTO> {
  return request<StorageTargetDTO>('/api/v1/storage/targets', { method: 'POST', body: in_ });
}

export function patchStorageTarget(
  id: string,
  patch: PatchStorageTargetInput,
): Promise<StorageTargetDTO> {
  return request<StorageTargetDTO>(`/api/v1/storage/targets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function deleteStorageTarget(id: string): Promise<void> {
  return request<void>(`/api/v1/storage/targets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
