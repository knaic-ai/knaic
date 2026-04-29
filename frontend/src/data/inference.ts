import { createStore, useStore, uid } from './store';

export interface ServingRuntime {
  id: string;
  name: string;
  namespace: string;
  runtime: 'vllm' | 'sglang' | 'custom';
  image: string;
  supportedModelFormats: string[];
  defaultArgs: string[];
  resources: { cpu: string; memory: string; gpu: number };
  createdAt: string;
  builtin: boolean;
}

export interface InferenceService {
  id: string;
  name: string;
  namespace: string;
  kind: 'InferenceService' | 'LLMInferenceService';
  runtime: string;
  modelUri: string;
  minReplicas: number;
  maxReplicas: number;
  resources: { cpu: string; memory: string; gpu: number };
  cpuLimit?: string;
  memoryLimit?: string;
  gpuProfileId?: string;
  gpuValues?: Record<string, number>;
  env?: { name: string; value: string }[];
  command?: string[];
  args?: string[];
  endpoint: string;
  status: 'Ready' | 'Progressing' | 'Failed';
  createdAt: string;
}

const nowDate = () => new Date().toISOString().slice(0, 10);

const runtimesInitial: ServingRuntime[] = [
  {
    id: uid('sr'),
    name: 'vllm',
    namespace: 'team-ml',
    runtime: 'vllm',
    image: 'vllm/vllm-openai:v0.7.2',
    supportedModelFormats: ['huggingface', 'safetensors'],
    defaultArgs: ['--max-model-len', '32768', '--enable-chunked-prefill'],
    resources: { cpu: '8', memory: '64Gi', gpu: 1 },
    createdAt: nowDate(),
    builtin: true,
  },
  {
    id: uid('sr'),
    name: 'sglang',
    namespace: 'team-ml',
    runtime: 'sglang',
    image: 'lmsysorg/sglang:v0.4.1',
    supportedModelFormats: ['huggingface', 'safetensors'],
    defaultArgs: ['--tp', '1', '--mem-fraction-static', '0.88'],
    resources: { cpu: '8', memory: '64Gi', gpu: 1 },
    createdAt: nowDate(),
    builtin: true,
  },
];

const servicesInitial: InferenceService[] = [
  {
    id: uid('is'),
    name: 'qwen3-5-7b',
    namespace: 'team-ml',
    kind: 'LLMInferenceService',
    runtime: 'vllm',
    modelUri: 'hf://Qwen/Qwen3.5-7B-Instruct',
    minReplicas: 1,
    maxReplicas: 4,
    resources: { cpu: '8', memory: '64Gi', gpu: 1 },
    endpoint: 'http://qwen3-5-7b.team-ml.svc.cluster.local/v1',
    status: 'Ready',
    createdAt: nowDate(),
  },
  {
    id: uid('is'),
    name: 'bge-embed',
    namespace: 'team-ml',
    kind: 'InferenceService',
    runtime: 'custom',
    modelUri: 'hf://BAAI/bge-large-en-v1.5',
    minReplicas: 1,
    maxReplicas: 2,
    resources: { cpu: '4', memory: '16Gi', gpu: 0 },
    endpoint: 'http://bge-embed.team-ml.svc.cluster.local/v1',
    status: 'Ready',
    createdAt: nowDate(),
  },
  {
    id: uid('is'),
    name: 'qwen-72b-lws',
    namespace: 'team-llm',
    kind: 'LLMInferenceService',
    runtime: 'vllm',
    modelUri: 'hf://Qwen/Qwen3.5-72B-Instruct',
    minReplicas: 1,
    maxReplicas: 1,
    resources: { cpu: '32', memory: '512Gi', gpu: 8 },
    endpoint: 'http://qwen-72b-lws.team-llm.svc.cluster.local/v1',
    status: 'Progressing',
    createdAt: nowDate(),
  },
];

import { apiEnabled } from '@/api/client';
import {
  listInferenceServices as apiListServices,
  listServingRuntimes as apiListRuntimes,
  createInferenceService as apiCreateService,
  createServingRuntime as apiCreateRuntime,
  type CreateServiceRequest,
  type CreateRuntimeRequest,
} from '@/api/inference';
import {
  fetchYaml as apiFetchYaml,
  deleteNamespaced as apiDeleteNamespaced,
} from '@/api/k8sres';

export const runtimesStore = createStore<ServingRuntime[]>(runtimesInitial);
export const servicesStore = createStore<InferenceService[]>(servicesInitial);

export const useRuntimes = () => useStore(runtimesStore);
export const useInferenceServices = () => useStore(servicesStore);

const loaded = new Set<string>();

function fillRuntimeDefaults(r: ServingRuntime): ServingRuntime {
  return {
    ...r,
    id: r.id || `sr-${r.namespace}-${r.name}`,
    supportedModelFormats: r.supportedModelFormats ?? [],
    defaultArgs: r.defaultArgs ?? [],
    resources: r.resources ?? { cpu: '', memory: '', gpu: 0 },
    builtin: r.builtin ?? false,
  };
}

function fillServiceDefaults(s: InferenceService): InferenceService {
  return {
    ...s,
    id: s.id || `is-${s.namespace}-${s.name}`,
    resources: s.resources ?? { cpu: '', memory: '', gpu: 0 },
  };
}

export function ensureRuntimesLoaded(ns: string) {
  if (!apiEnabled) return;
  const k = `sr:${ns}`;
  if (loaded.has(k)) return;
  loaded.add(k);
  apiListRuntimes(ns)
    .then(items => {
      runtimesStore.set(prev => [
        ...prev.filter(r => r.namespace !== ns || r.builtin),
        ...items.map(fillRuntimeDefaults),
      ]);
    })
    .catch(() => loaded.delete(k));
}

export function ensureInferenceServicesLoaded(ns: string) {
  if (!apiEnabled) return;
  const k = `is:${ns}`;
  if (loaded.has(k)) return;
  loaded.add(k);
  apiListServices(ns)
    .then(items => {
      servicesStore.set(prev => [
        ...prev.filter(s => s.namespace !== ns),
        ...items.map(fillServiceDefaults),
      ]);
    })
    .catch(() => loaded.delete(k));
}

export function reloadRuntimes(ns: string) {
  loaded.delete(`sr:${ns}`);
  ensureRuntimesLoaded(ns);
}

export function reloadInferenceServices(ns: string) {
  loaded.delete(`is:${ns}`);
  ensureInferenceServicesLoaded(ns);
}

export async function createInferenceService(ns: string, req: CreateServiceRequest): Promise<void> {
  if (apiEnabled) {
    await apiCreateService(ns, req);
    reloadInferenceServices(ns);
    return;
  }
  // Prototype fallback — push a synthetic entry.
  servicesStore.set(prev => [
    {
      ...fillServiceDefaults({
        id: `is-${ns}-${req.name}`,
        name: req.name,
        namespace: ns,
        kind: req.kind,
        runtime: req.runtime,
        modelUri: req.modelUri,
        minReplicas: req.replicas,
        maxReplicas: req.replicas,
        resources: { cpu: req.cpuRequest, memory: req.memoryRequest, gpu: 0 },
        endpoint: '',
        status: 'Progressing',
        createdAt: new Date().toISOString().slice(0, 10),
      } as InferenceService),
    },
    ...prev,
  ]);
}

export async function createServingRuntime(ns: string, req: CreateRuntimeRequest): Promise<void> {
  if (apiEnabled) {
    await apiCreateRuntime(ns, req);
    reloadRuntimes(ns);
    return;
  }
  runtimesStore.set(prev => [
    fillRuntimeDefaults({
      id: `sr-${ns}-${req.name}`,
      name: req.name,
      namespace: ns,
      runtime: (req.runtime as ServingRuntime['runtime']) ?? 'custom',
      image: req.image,
      supportedModelFormats: req.supportedModelFormats ?? ['huggingface'],
      defaultArgs: req.args ?? [],
      resources: { cpu: '', memory: req.memoryLimit ?? '', gpu: req.gpuLimit ?? 0 },
      createdAt: new Date().toISOString().slice(0, 10),
      builtin: false,
    }),
    ...prev,
  ]);
}

export async function deleteInferenceService(ns: string, name: string, kind: string): Promise<void> {
  if (apiEnabled) {
    const slug = kind === 'LLMInferenceService' ? 'llminferenceservices' : 'inferenceservices';
    await apiDeleteNamespaced(slug, ns, name);
    reloadInferenceServices(ns);
    return;
  }
  servicesStore.set(prev => prev.filter(s => !(s.namespace === ns && s.name === name)));
}

export async function deleteServingRuntime(ns: string, name: string): Promise<void> {
  if (apiEnabled) {
    await apiDeleteNamespaced('servingruntimes', ns, name);
    reloadRuntimes(ns);
    return;
  }
  runtimesStore.set(prev => prev.filter(r => !(r.namespace === ns && r.name === name)));
}

export async function fetchInferenceServiceYaml(ns: string, name: string, kind: string): Promise<string> {
  if (!apiEnabled) return '';
  const slug = kind === 'LLMInferenceService' ? 'llminferenceservices' : 'inferenceservices';
  return apiFetchYaml(slug, ns, name);
}

export async function fetchServingRuntimeYaml(ns: string, name: string): Promise<string> {
  if (!apiEnabled) return '';
  return apiFetchYaml('servingruntimes', ns, name);
}

export function buildServingRuntimeYaml(sr: ServingRuntime): string {
  return `apiVersion: serving.kserve.io/v1alpha1
kind: ServingRuntime
metadata:
  name: ${sr.name}
  namespace: ${sr.namespace}
spec:
  supportedModelFormats:
${sr.supportedModelFormats.map(f => `    - name: ${f}\n      autoSelect: true`).join('\n')}
  containers:
    - name: kserve-container
      image: ${sr.image}
      args:
${sr.defaultArgs.map(a => `        - "${a}"`).join('\n')}
      resources:
        limits:
          cpu: "${sr.resources.cpu}"
          memory: ${sr.resources.memory}
          nvidia.com/gpu: ${sr.resources.gpu}
`;
}

export function buildInferenceServiceYaml(is: InferenceService): string {
  const apiVersion =
    is.kind === 'LLMInferenceService'
      ? 'serving.kserve.io/v1alpha1'
      : 'serving.kserve.io/v1beta1';
  const cpuReq = is.resources.cpu;
  const memReq = is.resources.memory;
  const cpuLim = is.cpuLimit ?? is.resources.cpu;
  const memLim = is.memoryLimit ?? is.resources.memory;
  const gpuEntries: [string, number][] = is.gpuValues
    ? Object.entries(is.gpuValues)
    : is.resources.gpu > 0
      ? [['nvidia.com/gpu', is.resources.gpu]]
      : [];
  const gpuYaml = gpuEntries.length
    ? gpuEntries.map(([k, v]) => `          ${k}: ${v}`).join('\n')
    : '';
  const envYaml = is.env?.length
    ? '\n      env:\n' + is.env.map(e => `        - name: ${e.name}\n          value: "${e.value}"`).join('\n')
    : '';
  const commandYaml = is.command?.length
    ? '\n      command:\n' + is.command.map(c => `        - "${c}"`).join('\n')
    : '';
  const argsYaml = is.args?.length
    ? '\n      args:\n' + is.args.map(a => `        - "${a}"`).join('\n')
    : '';
  return `apiVersion: ${apiVersion}
kind: ${is.kind}
metadata:
  name: ${is.name}
  namespace: ${is.namespace}
spec:
  predictor:
    minReplicas: ${is.minReplicas}
    maxReplicas: ${is.maxReplicas}
    model:
      modelFormat:
        name: huggingface
      runtime: ${is.runtime}
      storageUri: ${is.modelUri}
      resources:
        requests:
          cpu: "${cpuReq}"
          memory: ${memReq}
        limits:
          cpu: "${cpuLim}"
          memory: ${memLim}${gpuYaml ? '\n' + gpuYaml : ''}${envYaml}${commandYaml}${argsYaml}
`;
}
