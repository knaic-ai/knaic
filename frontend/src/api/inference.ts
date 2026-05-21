// Typed bindings for /api/v1/namespaces/{ns}/inference/* (form-shaped Create
// endpoints) and the generic k8sres slugs that back list / get / yaml /
// delete for KServe CRDs (inferenceservices, llminferenceservices,
// servingruntimes).

import { request } from './client';
import { listNamespaced, streamLogEndpoint, type LogStreamOptions } from './k8sres';
import type { InferenceService, RuntimeSecurityContext, ServingRuntime } from '@/data/inference';

export interface CreateServiceRequest {
  name: string;
  kind: 'InferenceService' | 'LLMInferenceService';
  // ServingRuntime ref — InferenceService only.
  runtime?: string;
  modelUri: string;
  replicas: number;
  // LLMInferenceService-only: list of LLMInferenceServiceConfig names that
  // get merged into the spec via spec.baseRefs[].
  baseConfigs?: string[];
  modelName?: string;
  containerImage?: string;
  // InferenceService-only: pins the `serving.kserve.io/deploymentMode`
  // annotation. Pick from listDeploymentModes() / DeploymentModesInfo.modes.
  deploymentMode?: string;
  cpuRequest: string;
  cpuLimit?: string;
  memoryRequest: string;
  memoryLimit?: string;
  gpuValues?: Record<string, number>;
  env?: { name: string; value: string }[];
  command?: string[];
  args?: string[];
}

export interface LLMConfigRef {
  name: string;
  namespace: string;
}

export function listLLMConfigs(): Promise<LLMConfigRef[]> {
  return request<LLMConfigRef[]>('/api/v1/inference/llm-configs');
}

export interface DeploymentModesInfo {
  modes: string[];
  default: string;
}

export function listDeploymentModes(): Promise<DeploymentModesInfo> {
  return request<DeploymentModesInfo>('/api/v1/inference/deployment-modes');
}

// KServeGatewayDTO mirrors backend KServeGatewayStatus — bits of the
// kserve-ingress-gateway Gateway resource the UI cares about.
export interface KServeGatewayDTO {
  namespace: string;
  name: string;
  gatewayClassName?: string;
  status: string;
  addresses?: string[];
  listeners?: string[];
}

// GatewayConfigDTO is the response of GET /api/v1/inference/gateway.
export interface GatewayConfigDTO {
  ingressGatewayApiEnabled: boolean;
  defaultDeploymentMode?: string;
  ingressDomain?: string;
  urlScheme?: string;
  disableIstioVirtualHost?: boolean;
  gatewayApiInstalled: boolean;
  envoyAiGatewayInstalled: boolean;
  gateway?: KServeGatewayDTO;
}

export function fetchGatewayConfig(): Promise<GatewayConfigDTO> {
  return request<GatewayConfigDTO>('/api/v1/inference/gateway');
}

// Per-InferenceService route + rate-limit picture.
export interface RouteRefDTO {
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
  hostnames?: string[];
  parentName?: string;
  status?: string;
}

export interface RateLimitRefDTO {
  namespace: string;
  name: string;
  targetKind?: string;
  targetName?: string;
  type?: string;
  summaries?: string[];
}

export interface BackendServiceRefDTO {
  namespace?: string;
  name: string;
  port?: number;
}

export interface ServiceRouteStatusDTO {
  routes: RouteRefDTO[];
  rateLimits: RateLimitRefDTO[];
  backends?: BackendServiceRefDTO[];
  suggestions?: string[];
}

export function fetchServiceRouteStatus(
  ns: string,
  name: string,
): Promise<ServiceRouteStatusDTO> {
  return request<ServiceRouteStatusDTO>(
    `/api/v1/namespaces/${encodeURIComponent(ns)}/inference/services/${encodeURIComponent(name)}/route-status`,
  );
}

export interface RateLimitConfigDTO {
  requests: number;
  unit: 'Second' | 'Minute' | 'Hour' | 'Day';
  clientHeader?: string;
  countTokens?: boolean;
}

export interface CreateAIGatewayRouteRequest {
  gatewayNamespace?: string;
  gatewayName?: string;
  hostnames?: string[];
  modelHeader?: string;
  servicePort?: number;
  rateLimit?: RateLimitConfigDTO;
}

export interface CreatedResourceDTO {
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
}

export interface CreateAIGatewayRouteResultDTO {
  created: CreatedResourceDTO[];
}

export function createAIGatewayRoute(
  ns: string,
  svcName: string,
  req: CreateAIGatewayRouteRequest,
): Promise<CreateAIGatewayRouteResultDTO> {
  return request<CreateAIGatewayRouteResultDTO>(
    `/api/v1/namespaces/${encodeURIComponent(ns)}/inference/services/${encodeURIComponent(svcName)}/gateway-route`,
    { method: 'POST', body: req },
  );
}

export interface CreateRuntimeRequest {
  name: string;
  image: string;
  runtime: string;
  supportedModelFormats?: string[];
  args?: string[];
  securityContext?: RuntimeSecurityContext;
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

export function updateInferenceService(ns: string, name: string, req: CreateServiceRequest): Promise<unknown> {
  return request<unknown>(
    `/api/v1/namespaces/${encodeURIComponent(ns)}/inference/services/${encodeURIComponent(name)}`,
    { method: 'PUT', body: req },
  );
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

export function streamInferenceServiceLogs(
  ns: string,
  name: string,
  kind: InferenceService['kind'],
  opts: LogStreamOptions,
): Promise<void> {
  const params = new URLSearchParams();
  params.set('kind', kind);
  if (opts.container) params.set('container', opts.container);
  if (opts.follow) params.set('follow', 'true');
  if (opts.tailLines !== undefined) params.set('tailLines', String(opts.tailLines));
  if (opts.previous) params.set('previous', 'true');
  return streamLogEndpoint(
    `/api/v1/namespaces/${encodeURIComponent(ns)}/inference/services/${encodeURIComponent(name)}/logs?${params}`,
    opts,
  );
}

export interface InferencePodInfo {
  name: string;
  phase: string;
  ready: boolean;
  containers: string[];
  initContainers?: string[];
  createdAt?: string;
}

// Lists every pod backing an inference service. The log viewer's pod picker
// uses this so users can read logs from old replicas during a rolling update
// or step into init containers (e.g. storage-initializer) that have already
// completed.
export function listInferenceServicePods(
  ns: string,
  name: string,
  kind: InferenceService['kind'],
): Promise<InferencePodInfo[]> {
  return request<InferencePodInfo[]>(
    `/api/v1/namespaces/${encodeURIComponent(ns)}/inference/services/${encodeURIComponent(name)}/pods?kind=${encodeURIComponent(kind)}`,
  );
}
