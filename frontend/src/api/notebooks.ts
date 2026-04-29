// Typed bindings for /api/v1/namespaces/{ns}/notebook/* (form-shaped Create
// + start/stop) and the generic k8sres slug "notebooks" used for list/get/
// yaml/delete.

import { request } from './client';
import { listNamespaced } from './k8sres';
import type { Notebook, NotebookVolumeKind } from '@/data/notebooks';

export interface CreateNotebookRequest {
  name: string;
  image: string;
  cpuRequest: string;
  cpuLimit?: string;
  memoryRequest: string;
  memoryLimit?: string;
  gpuValues?: Record<string, number>;
  sharedMemory?: string;
  volume: {
    kind: NotebookVolumeKind;
    pvcName?: string;
    storageClass?: string;
    capacity?: string;
    mountPath?: string;
  };
  env?: { name: string; value: string }[];
  owner?: string;
}

export function createNotebook(ns: string, req: CreateNotebookRequest): Promise<unknown> {
  return request<unknown>(`/api/v1/namespaces/${encodeURIComponent(ns)}/notebook`, {
    method: 'POST',
    body: req,
  });
}

export function stopNotebook(ns: string, name: string): Promise<unknown> {
  return request<unknown>(`/api/v1/namespaces/${encodeURIComponent(ns)}/notebook/${encodeURIComponent(name)}/stop`, {
    method: 'POST',
  });
}

export function startNotebook(ns: string, name: string): Promise<unknown> {
  return request<unknown>(`/api/v1/namespaces/${encodeURIComponent(ns)}/notebook/${encodeURIComponent(name)}/start`, {
    method: 'POST',
  });
}

export function listNotebooks(ns: string): Promise<Notebook[]> {
  return listNamespaced<Notebook>('notebooks', ns).catch(() => []);
}
