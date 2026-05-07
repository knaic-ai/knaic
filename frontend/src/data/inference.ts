import { createStore, useStore, uid } from './store';

export interface RuntimeSecurityContext {
  allowPrivilegeEscalation?: boolean;
  capabilities?: {
    add?: string[];
    drop?: string[];
  };
  privileged?: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  seccompProfile?: {
    type?: string;
  };
}

export interface ServingRuntime {
  id: string;
  name: string;
  namespace: string;
  runtime: 'vllm' | 'sglang' | 'custom';
  image: string;
  supportedModelFormats: string[];
  defaultArgs: string[];
  resources: { cpu: string; memory: string; gpu: number };
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  // Full accelerator resource map (e.g. HAMi keys gpualloc / gpucores /
  // gpumem) — present whenever the runtime requests any non-cpu/non-memory
  // resource. The legacy `resources.gpu` stays for backward compat.
  gpuValues?: Record<string, number>;
  securityContext?: RuntimeSecurityContext;
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
  status: 'Ready' | 'Progressing' | 'Failed' | 'Stopped';
  stopped?: boolean;
  deploymentMode?: string;
  createdAt: string;
}

const nowDate = () => new Date().toISOString().slice(0, 10);

export const defaultServingRuntimeArgs: Record<string, string[]> = {
  vllm: ['--port', '8080', '--served-model-name', '{{.Name}}', '{{.Namespace}}/{{.Name}}', '--model', '/mnt/models'],
  sglang: ['--port', '8080', '--served-model-name', '{{.Name}}', '--model-path', '/mnt/models'],
};

export function defaultArgsForRuntimeFamily(runtime: string): string[] {
  return defaultServingRuntimeArgs[runtime] ?? [];
}

const runtimesInitial: ServingRuntime[] = [
  {
    id: uid('sr'),
    name: 'vllm',
    namespace: 'team-ml',
    runtime: 'vllm',
    image: 'vllm/vllm-openai:v0.7.2',
    supportedModelFormats: ['huggingface', 'safetensors'],
    defaultArgs: defaultArgsForRuntimeFamily('vllm'),
    resources: { cpu: '8', memory: '64Gi', gpu: 1 },
    securityContext: defaultRuntimeSecurityContext(),
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
    defaultArgs: defaultArgsForRuntimeFamily('sglang'),
    resources: { cpu: '8', memory: '64Gi', gpu: 1 },
    securityContext: defaultRuntimeSecurityContext(),
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

import { apiEnabled, request } from '@/api/client';
import {
  listInferenceServices as apiListServices,
  listServingRuntimes as apiListRuntimes,
  createInferenceService as apiCreateService,
  createServingRuntime as apiCreateRuntime,
  updateServingRuntime as apiUpdateRuntime,
  type CreateServiceRequest,
  type CreateRuntimeRequest,
  listLLMConfigs as apiListLLMConfigs,
  listDeploymentModes as apiListDeploymentModes,
  type LLMConfigRef,
  type DeploymentModesInfo,
} from '@/api/inference';
import {
  fetchYaml as apiFetchYaml,
  deleteNamespaced as apiDeleteNamespaced,
  updateNamespacedYaml as apiUpdateNamespacedYaml,
} from '@/api/k8sres';

export const runtimesStore = createStore<ServingRuntime[]>(runtimesInitial);
export const servicesStore = createStore<InferenceService[]>(servicesInitial);
export const llmConfigsStore = createStore<LLMConfigRef[]>([]);

export const useRuntimes = () => useStore(runtimesStore);
export const useInferenceServices = () => useStore(servicesStore);
export const useLLMConfigs = () => useStore(llmConfigsStore);

const loaded = new Set<string>();
let llmConfigsLoaded = false;

// LLM base configs are cluster-wide and don't change often, so we load once
// and cache. reloadLLMConfigs() is exposed below for explicit refreshes
// (e.g. after the user creates a new LLMInferenceServiceConfig out-of-band).
export function ensureLLMConfigsLoaded() {
  if (!apiEnabled || llmConfigsLoaded) return;
  llmConfigsLoaded = true;
  apiListLLMConfigs()
    .then(items => llmConfigsStore.set(items))
    .catch(() => {
      llmConfigsLoaded = false;
    });
}

export function reloadLLMConfigs() {
  llmConfigsLoaded = false;
  ensureLLMConfigsLoaded();
}

const fallbackDeploymentModes: DeploymentModesInfo = {
  modes: ['Standard', 'RawDeployment'],
  default: 'Standard',
};

export const deploymentModesStore = createStore<DeploymentModesInfo>(fallbackDeploymentModes);
export const useDeploymentModes = () => useStore(deploymentModesStore);

let deploymentModesLoaded = false;

// Cluster-wide and stable across requests; load once and cache.
export function ensureDeploymentModesLoaded() {
  if (!apiEnabled || deploymentModesLoaded) return;
  deploymentModesLoaded = true;
  apiListDeploymentModes()
    .then(info => deploymentModesStore.set(info))
    .catch(() => {
      deploymentModesLoaded = false;
    });
}

export function defaultRuntimeSecurityContext(): RuntimeSecurityContext {
  return {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'], add: [] },
    privileged: false,
    runAsNonRoot: true,
    runAsUser: 1000,
    seccompProfile: { type: 'RuntimeDefault' },
  };
}

function fillRuntimeDefaults(r: ServingRuntime): ServingRuntime {
  return {
    ...r,
    id: r.id || `sr-${r.namespace}-${r.name}`,
    supportedModelFormats: r.supportedModelFormats ?? [],
    defaultArgs: r.defaultArgs ?? [],
    resources: r.resources ?? { cpu: '', memory: '', gpu: 0 },
    cpuRequest: r.cpuRequest ?? r.resources?.cpu ?? '',
    cpuLimit: r.cpuLimit ?? r.resources?.cpu ?? '',
    memoryRequest: r.memoryRequest ?? r.resources?.memory ?? '',
    memoryLimit: r.memoryLimit ?? r.resources?.memory ?? '',
    securityContext: r.securityContext ?? defaultRuntimeSecurityContext(),
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

export async function updateServingRuntime(ns: string, name: string, req: CreateRuntimeRequest): Promise<void> {
  if (apiEnabled) {
    await apiUpdateRuntime(ns, name, req);
    reloadRuntimes(ns);
    return;
  }
  runtimesStore.set(prev =>
    prev.map(r =>
      r.namespace === ns && r.name === name
        ? {
            ...r,
            runtime: (req.runtime as ServingRuntime['runtime']) ?? r.runtime,
            image: req.image,
            supportedModelFormats: req.supportedModelFormats ?? r.supportedModelFormats,
            defaultArgs: req.args ?? r.defaultArgs,
            cpuRequest: req.cpuRequest ?? r.cpuRequest,
            cpuLimit: req.cpuLimit ?? r.cpuLimit,
            memoryRequest: req.memoryRequest ?? r.memoryRequest,
            memoryLimit: req.memoryLimit ?? r.memoryLimit,
            securityContext: req.securityContext ?? r.securityContext ?? defaultRuntimeSecurityContext(),
            resources: {
              cpu: req.cpuLimit ?? req.cpuRequest ?? r.resources.cpu,
              memory: req.memoryLimit ?? req.memoryRequest ?? r.resources.memory,
              gpu: req.gpuLimit ?? r.resources.gpu,
            },
            gpuValues: req.gpuValues ?? r.gpuValues,
          }
        : r,
    ),
  );
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
      cpuRequest: req.cpuRequest,
      cpuLimit: req.cpuLimit,
      memoryRequest: req.memoryRequest,
      memoryLimit: req.memoryLimit,
      securityContext: req.securityContext ?? defaultRuntimeSecurityContext(),
      resources: { cpu: req.cpuRequest ?? '', memory: req.memoryRequest ?? '', gpu: req.gpuLimit ?? 0 },
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

// setInferenceServiceStopped flips the KServe `serving.kserve.io/stop`
// annotation. Backend route: POST /inference/services/{name}/{stop|start}.
export async function setInferenceServiceStopped(
  ns: string,
  name: string,
  kind: string,
  stopped: boolean,
): Promise<void> {
  if (apiEnabled) {
    const action = stopped ? 'stop' : 'start';
    await request<unknown>(
      `/api/v1/namespaces/${encodeURIComponent(ns)}/inference/services/${encodeURIComponent(name)}/${action}?kind=${encodeURIComponent(kind)}`,
      { method: 'POST' },
    );
    reloadInferenceServices(ns);
    return;
  }
  servicesStore.set(prev =>
    prev.map(s =>
      s.namespace === ns && s.name === name
        ? { ...s, stopped, status: stopped ? 'Stopped' : 'Progressing' }
        : s,
    ),
  );
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

export async function updateInferenceServiceYaml(
  ns: string,
  name: string,
  kind: string,
  yaml: string,
): Promise<void> {
  if (!apiEnabled) throw new Error('API not configured — cannot update YAML');
  const slug = kind === 'LLMInferenceService' ? 'llminferenceservices' : 'inferenceservices';
  await apiUpdateNamespacedYaml(slug, ns, name, yaml);
  reloadInferenceServices(ns);
}

export async function updateServingRuntimeYaml(ns: string, name: string, yaml: string): Promise<void> {
  if (!apiEnabled) throw new Error('API not configured — cannot update YAML');
  await apiUpdateNamespacedYaml('servingruntimes', ns, name, yaml);
  reloadRuntimes(ns);
}

export function buildServingRuntimeYaml(sr: ServingRuntime): string {
  const sc = sr.securityContext ?? defaultRuntimeSecurityContext();
  const drop = sc.capabilities?.drop ?? [];
  const add = sc.capabilities?.add ?? [];
  const capabilitiesYaml =
    drop.length || add.length
      ? `\n        capabilities:${drop.length ? `\n          drop:\n${drop.map(v => `            - ${v}`).join('\n')}` : ''}${add.length ? `\n          add:\n${add.map(v => `            - ${v}`).join('\n')}` : ''}`
      : '';
  const securityContextYaml = `      securityContext:
        allowPrivilegeEscalation: ${sc.allowPrivilegeEscalation ?? false}${capabilitiesYaml}
        privileged: ${sc.privileged ?? false}
        runAsNonRoot: ${sc.runAsNonRoot ?? true}
        runAsUser: ${sc.runAsUser ?? 1000}
        seccompProfile:
          type: ${sc.seccompProfile?.type ?? 'RuntimeDefault'}`;
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
${securityContextYaml}
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
