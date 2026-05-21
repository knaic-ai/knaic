// Typed API for KServe Local Model Cache resources.
//
// Both CRDs (LocalModelNodeGroup, LocalModelCache) are cluster-scoped and
// served by the generic k8sres dispatcher — list/get/delete reuse the
// existing helpers in api/k8sres.ts. Only the agent DaemonSet probe needs a
// dedicated endpoint because there's no CRD that surfaces it directly.

import { request } from './client';

export interface LocalModelStatus {
  installed: boolean;
  hostPath?: string;
  namespace?: string;
  name?: string;
}

export interface NodeStatusEntry {
  node: string;
  state: string;
}

export interface InferenceServiceRef {
  name: string;
  namespace: string;
}

export interface LocalModelNodeGroup {
  id: string;
  name: string;
  namespace: string; // always empty (cluster-scoped) but kept for the shared row shape
  createdAt: string;
  labels?: Record<string, string>;
  age: string;
  storageLimit: string;
  hostPath: string;
  storageClassName: string;
  used: string;
  available: string;
  selectorKey: string;
  selectorOp: string;
  selectorValues: string[] | null;
}

export interface LocalModelCache {
  id: string;
  name: string;
  namespace: string;
  createdAt: string;
  labels?: Record<string, string>;
  age: string;
  sourceModelUri: string;
  modelSize: string;
  nodeGroups: string[] | null;
  nodeStatus: NodeStatusEntry[] | null;
  copiesAvailable: number;
  copiesTotal: number;
  inferenceServices: InferenceServiceRef[] | null;
}

export function fetchLocalModelStatus(): Promise<LocalModelStatus> {
  return request<LocalModelStatus>('/api/v1/inference/localmodel/status');
}

export interface LocalModelOptions {
  nodeLabelKeys: string[];
  storageClasses: string[];
}

export function fetchLocalModelOptions(): Promise<LocalModelOptions> {
  return request<LocalModelOptions>('/api/v1/inference/localmodel/options');
}
