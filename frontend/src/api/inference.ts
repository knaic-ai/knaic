// Typed bindings for /api/v1/namespaces/{ns}/inference/* (form-shaped Create
// endpoints) and the generic k8sres slugs that back list / get / yaml /
// delete for KServe CRDs (inferenceservices, llminferenceservices,
// servingruntimes).

import { request } from './client';
import { listNamespaced } from './k8sres';
import type { InferenceService, ServingRuntime } from '@/data/inference';

export interface CreateServiceRequest {
  name: string;
  kind: 'InferenceService' | 'LLMInferenceService';
  runtime: string;
  modelUri: string;
  replicas: number;
  cpuRequest: string;
  cpuLimit?: string;
  memoryRequest: string;
  memoryLimit?: string;
  gpuValues?: Record<string, number>;
  env?: { name: string; value: string }[];
  command?: string[];
  args?: string[];
}

export interface CreateRuntimeRequest {
  name: string;
  image: string;
  runtime: string;
  supportedModelFormats?: string[];
  args?: string[];
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  // Resource keys + quantities chosen via the GPU profile picker, mirroring
  // CreateServiceRequest.gpuValues. When omitted, gpuLimit is used as a
  // legacy `nvidia.com/gpu` limit.
  gpuValues?: Record<string, number>;
  gpuLimit?: number;
}

export function createInferenceService(ns: string, req: CreateServiceRequest): Promise<unknown> {
  return request<unknown>(`/api/v1/namespaces/${encodeURIComponent(ns)}/inference/services`, {
    method: 'POST',
    body: req,
  });
}

export function createServingRuntime(ns: string, req: CreateRuntimeRequest): Promise<unknown> {
  return request<unknown>(`/api/v1/namespaces/${encodeURIComponent(ns)}/inference/runtimes`, {
    method: 'POST',
    body: req,
  });
}

export function updateServingRuntime(ns: string, name: string, req: CreateRuntimeRequest): Promise<unknown> {
  return request<unknown>(
    `/api/v1/namespaces/${encodeURIComponent(ns)}/inference/runtimes/${encodeURIComponent(name)}`,
    { method: 'PUT', body: req },
  );
}

// list helpers — combined into a single call that hits both v1beta1 and
// v1alpha1 because the Inference Services page shows both kinds in one table.
export async function listInferenceServices(ns: string): Promise<InferenceService[]> {
  const [classic, llm] = await Promise.all([
    listNamespaced<InferenceService>('inferenceservices', ns).catch(() => []),
    listNamespaced<InferenceService>('llminferenceservices', ns).catch(() => []),
  ]);
  return [...classic, ...llm];
}

export function listServingRuntimes(ns: string): Promise<ServingRuntime[]> {
  return listNamespaced<ServingRuntime>('servingruntimes', ns).catch(() => []);
}
