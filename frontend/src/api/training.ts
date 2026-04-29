// Typed bindings for /api/v1/namespaces/{ns}/training/* (form-shaped Create
// + MLflow run fetch). Read paths use the generic k8sres slugs trainjobs +
// trainingruntimes.

import { request } from './client';
import { listNamespaced } from './k8sres';
import type { TrainingRuntime, TrainJob } from '@/data/training';

export interface CreateRuntimeRequest {
  name: string;
  framework: string;
  image: string;
  numNodes: number;
  cpuLimit?: string;
  memoryLimit?: string;
  gpuLimit?: number;
}

export interface CreateJobRequest {
  name: string;
  runtime: string;
  numNodes: number;
  command?: string[];
  args?: string[];
  env?: { name: string; value: string }[];
  cpuRequest: string;
  cpuLimit?: string;
  memoryRequest: string;
  memoryLimit?: string;
  gpuValues?: Record<string, number>;
  modelUri?: string;
  datasetUri?: string;
  mlflowTrackingUri?: string;
  mlflowExperiment?: string;
}

export interface MLflowRun {
  trackingUri: string;
  experiment: string;
  runId: string;
  samples: { step: number; loss: number; accuracy?: number }[];
  source: 'mlflow' | 'synthetic';
}

export function listTrainingRuntimes(ns: string): Promise<TrainingRuntime[]> {
  return listNamespaced<TrainingRuntime>('trainingruntimes', ns).catch(() => []);
}

export function listTrainJobs(ns: string): Promise<TrainJob[]> {
  return listNamespaced<TrainJob>('trainjobs', ns).catch(() => []);
}

export function createTrainingRuntime(ns: string, req: CreateRuntimeRequest): Promise<unknown> {
  return request<unknown>(`/api/v1/namespaces/${encodeURIComponent(ns)}/training/runtimes`, {
    method: 'POST',
    body: req,
  });
}

export function createTrainJob(ns: string, req: CreateJobRequest): Promise<unknown> {
  return request<unknown>(`/api/v1/namespaces/${encodeURIComponent(ns)}/training/jobs`, {
    method: 'POST',
    body: req,
  });
}

export function fetchMLflowRun(ns: string, name: string): Promise<MLflowRun> {
  return request<MLflowRun>(
    `/api/v1/namespaces/${encodeURIComponent(ns)}/training/jobs/${encodeURIComponent(name)}/mlflow`,
  );
}
