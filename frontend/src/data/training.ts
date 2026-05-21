import { createStore, useStore, uid } from './store';
import { apiEnabled } from '@/api/client';
import {
  createTrainJob as apiCreateJob,
  createTrainingRuntime as apiCreateRuntime,
  fetchMLflowRun,
  listTrainJobs as apiListJobs,
  listTrainingRuntimes as apiListRuntimes,
  type CreateJobRequest,
  type CreateRuntimeRequest,
} from '@/api/training';
import { createCluster, deleteCluster, deleteNamespaced, listCluster } from '@/api/k8sres';

export type TrainingFramework = 'torch' | 'deepspeed' | 'mpi' | 'tensorflow' | 'jax';

export interface TrainingRuntime {
  id: string;
  name: string;
  namespace: string;
  framework: TrainingFramework;
  image: string;
  numNodes: number;
  resourcesPerNode: { cpu: string; memory: string; gpu: number };
  createdAt: string;
  builtin: boolean;
}

export interface MLflowSample {
  step: number;
  loss: number;
  accuracy?: number;
}

export interface TrainJob {
  id: string;
  name: string;
  namespace: string;
  runtime: string;
  numNodes: number;
  command: string[];
  args?: string[];
  env?: { name: string; value: string }[];
  status: 'Pending' | 'Running' | 'Succeeded' | 'Failed';
  progress: number;
  startTime: string;
  duration: string;
  modelUri?: string;
  datasetUri?: string;
  cpu: string;
  cpuLimit?: string;
  memory: string;
  memoryLimit?: string;
  gpuProfileId?: string;
  gpuValues?: Record<string, number>;
  mlflow?: {
    trackingUri: string;
    experiment: string;
    runId: string;
    samples: MLflowSample[];
  };
}

const nowDate = () => new Date().toISOString().slice(0, 10);

const runtimesInitial: TrainingRuntime[] = [
  {
    id: uid('tr'),
    name: 'torch-distributed',
    namespace: 'knaic-system',
    framework: 'torch',
    image: 'ghcr.io/kubeflow/trainer/torch-runtime:2.4.0',
    numNodes: 1,
    resourcesPerNode: { cpu: '16', memory: '128Gi', gpu: 2 },
    createdAt: nowDate(),
    builtin: true,
  },
  {
    id: uid('tr'),
    name: 'deepspeed-runtime',
    namespace: 'knaic-system',
    framework: 'deepspeed',
    image: 'ghcr.io/kubeflow/trainer/deepspeed-runtime:0.15.1',
    numNodes: 2,
    resourcesPerNode: { cpu: '32', memory: '256Gi', gpu: 4 },
    createdAt: nowDate(),
    builtin: true,
  },
  {
    id: uid('tr'),
    name: 'mpi-runtime',
    namespace: 'knaic-system',
    framework: 'mpi',
    image: 'ghcr.io/kubeflow/trainer/mpi-runtime:5.0.3',
    numNodes: 4,
    resourcesPerNode: { cpu: '16', memory: '64Gi', gpu: 1 },
    createdAt: nowDate(),
    builtin: true,
  },
  {
    id: uid('tr'),
    name: 'tensorflow-runtime',
    namespace: 'knaic-system',
    framework: 'tensorflow',
    image: 'ghcr.io/kubeflow/trainer/tf-runtime:2.17.0',
    numNodes: 1,
    resourcesPerNode: { cpu: '8', memory: '64Gi', gpu: 1 },
    createdAt: nowDate(),
    builtin: true,
  },
];

const makeSamples = (finalLoss: number, finalAcc: number, steps: number): MLflowSample[] =>
  Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return {
      step: i + 1,
      loss: +(finalLoss + (1 - t) * (2 + Math.random() * 0.3)).toFixed(3),
      accuracy: +(finalAcc * t + Math.random() * 0.02).toFixed(3),
    };
  });

const jobsInitial: TrainJob[] = [
  {
    id: uid('tj'),
    name: 'qwen-helpdesk-sft-01',
    namespace: 'team-ml',
    runtime: 'torch-distributed',
    numNodes: 1,
    command: ['python', 'sft.py'],
    args: ['--epochs', '3', '--lr', '2e-5'],
    status: 'Running',
    progress: 62,
    startTime: '2026-04-22T09:12:00Z',
    duration: '01h 47m',
    modelUri: 'hf://Qwen/Qwen3.5-7B-Instruct',
    datasetUri: 's3://knaic-data/team-ml/helpdesk/train.jsonl',
    cpu: '16', cpuLimit: '16', memory: '128Gi', memoryLimit: '128Gi',
    gpuValues: { 'nvidia.com/gpu': 2 },
    mlflow: {
      trackingUri: 'http://mlflow.knaic-system.svc.cluster.local',
      experiment: 'qwen-helpdesk',
      runId: 'r-2a1e',
      samples: makeSamples(0.42, 0.78, 20),
    },
  },
  {
    id: uid('tj'),
    name: 'llama3-lora-eval',
    namespace: 'team-ml',
    runtime: 'torch-distributed',
    numNodes: 1,
    command: ['python', 'eval.py'],
    args: ['--adapter', 'lora-v7'],
    status: 'Succeeded',
    progress: 100,
    startTime: '2026-04-20T08:00:00Z',
    duration: '00h 42m',
    cpu: '16', cpuLimit: '16', memory: '128Gi', memoryLimit: '128Gi',
    gpuValues: { 'nvidia.com/gpu': 2 },
    mlflow: {
      trackingUri: 'http://mlflow.knaic-system.svc.cluster.local',
      experiment: 'qwen-helpdesk',
      runId: 'r-4c8b',
      samples: makeSamples(0.33, 0.86, 20),
    },
  },
  {
    id: uid('tj'),
    name: 'bge-contrastive',
    namespace: 'team-ml',
    runtime: 'deepspeed-runtime',
    numNodes: 2,
    command: ['python', 'train_contrastive.py'],
    args: ['--batch-size', '256'],
    status: 'Failed',
    progress: 14,
    startTime: '2026-04-21T02:00:00Z',
    duration: '00h 08m',
    cpu: '32', memory: '256Gi',
  },
];

export const trainingRuntimesStore = createStore<TrainingRuntime[]>(runtimesInitial);
export const trainJobsStore = createStore<TrainJob[]>(jobsInitial);
export const useTrainingRuntimes = () => useStore(trainingRuntimesStore);
export const useTrainJobs = () => useStore(trainJobsStore);

const loaded = new Set<string>();

function fillRuntimeDefaults(r: TrainingRuntime): TrainingRuntime {
  return {
    ...r,
    id: r.id || `tr-${r.namespace}-${r.name}`,
    resourcesPerNode: r.resourcesPerNode ?? { cpu: '', memory: '', gpu: 0 },
    builtin: r.builtin ?? false,
  };
}

function fillJobDefaults(j: TrainJob): TrainJob {
  return {
    ...j,
    id: j.id || `tj-${j.namespace}-${j.name}`,
    command: j.command ?? [],
    status: j.status ?? 'Pending',
    progress: j.progress ?? 0,
    duration: j.duration ?? '',
    cpu: j.cpu ?? '',
    memory: j.memory ?? '',
  };
}

export function ensureTrainingRuntimesLoaded(ns: string): void {
  if (!apiEnabled) return;
  const key = `tr:${ns}`;
  if (loaded.has(key)) return;
  loaded.add(key);
  Promise.all([
    apiListRuntimes(ns).catch(() => []),
    listCluster<TrainingRuntime>('clustertrainingruntimes').catch(() => []),
  ])
    .then(([namespaced, cluster]) => {
      trainingRuntimesStore.set(prev => {
        const builtin = cluster.length > 0
          ? cluster.map(r => fillRuntimeDefaults({ ...r, namespace: 'knaic-system', builtin: true }))
          : prev.filter(r => r.builtin);
        return [
          ...prev.filter(r => r.namespace !== ns && !r.builtin),
          ...builtin,
          ...namespaced.map(fillRuntimeDefaults),
        ];
      });
    })
    .catch(() => loaded.delete(key));
}

export function reloadTrainingRuntimes(ns: string): void {
  loaded.delete(`tr:${ns}`);
  ensureTrainingRuntimesLoaded(ns);
}

export function ensureTrainJobsLoaded(ns: string): void {
  if (!apiEnabled) return;
  const key = `tj:${ns}`;
  if (loaded.has(key)) return;
  loaded.add(key);
  apiListJobs(ns)
    .then(async items => {
      const filled = await Promise.all(items.map(async item => {
        const job = fillJobDefaults(item);
        if (!job.mlflow) return job;
        try {
          const run = await fetchMLflowRun(ns, job.name);
          return { ...job, mlflow: { ...run } };
        } catch {
          return job;
        }
      }));
      trainJobsStore.set(prev => [...prev.filter(j => j.namespace !== ns), ...filled]);
    })
    .catch(() => loaded.delete(key));
}

export function reloadTrainJobs(ns: string): void {
  loaded.delete(`tj:${ns}`);
  ensureTrainJobsLoaded(ns);
}

export async function createTrainingRuntime(ns: string, req: CreateRuntimeRequest & { cluster?: boolean }): Promise<void> {
  if (apiEnabled) {
    if (req.cluster) {
      await createCluster<TrainingRuntime>('clustertrainingruntimes', trainingRuntimeObject(req));
    } else {
      await apiCreateRuntime(ns, req);
    }
    reloadTrainingRuntimes(ns);
    return;
  }
  const gpuTotal = Object.values(req.gpuValues ?? {}).reduce((s, v) => s + v, 0);
  trainingRuntimesStore.set(prev => [
    {
      id: uid('tr'),
      name: req.name,
      namespace: req.cluster ? 'knaic-system' : ns,
      framework: req.framework as TrainingFramework,
      image: req.image,
      numNodes: req.numNodes,
      resourcesPerNode: {
        cpu: req.cpuLimit ?? req.cpuRequest ?? '',
        memory: req.memoryLimit ?? req.memoryRequest ?? '',
        gpu: gpuTotal,
      },
      createdAt: new Date().toISOString().slice(0, 10),
      builtin: false,
    },
    ...prev,
  ]);
}

export async function deleteTrainingRuntime(ns: string, runtime: TrainingRuntime): Promise<void> {
  if (apiEnabled) {
    if (runtime.builtin) {
      await deleteCluster('clustertrainingruntimes', runtime.name);
    } else {
      await deleteNamespaced('trainingruntimes', ns, runtime.name);
    }
  }
  trainingRuntimesStore.set(prev => prev.filter(r => r.id !== runtime.id));
}

export async function createTrainJob(ns: string, req: CreateJobRequest): Promise<void> {
  if (apiEnabled) {
    await apiCreateJob(ns, req);
    reloadTrainJobs(ns);
    return;
  }
  const job: TrainJob = {
    id: uid('tj'),
    name: req.name,
    namespace: ns,
    runtime: req.runtime,
    numNodes: req.numNodes,
    command: req.command ?? [],
    args: req.args,
    env: req.env,
    status: 'Running',
    progress: 1,
    startTime: new Date().toISOString(),
    duration: '00h 00m',
    modelUri: req.modelUri,
    datasetUri: req.datasetUri,
    cpu: req.cpuRequest,
    cpuLimit: req.cpuLimit,
    memory: req.memoryRequest,
    memoryLimit: req.memoryLimit,
    gpuValues: req.gpuValues,
  };
  trainJobsStore.set(prev => [job, ...prev]);
}

export async function deleteTrainJob(ns: string, job: TrainJob): Promise<void> {
  if (apiEnabled) await deleteNamespaced('trainjobs', ns, job.name);
  trainJobsStore.set(prev => prev.filter(j => j.id !== job.id));
}

function trainingRuntimeObject(req: CreateRuntimeRequest) {
  // Build resource map. Limits default to requests; GPU values go on both
  // sides (Kubernetes requires extended resources to appear in limits).
  const requests: Record<string, string | number> = {};
  const limits: Record<string, string | number> = {};
  if (req.cpuRequest) requests.cpu = req.cpuRequest;
  if (req.memoryRequest) requests.memory = req.memoryRequest;
  if (req.cpuLimit ?? req.cpuRequest) limits.cpu = (req.cpuLimit ?? req.cpuRequest)!;
  if (req.memoryLimit ?? req.memoryRequest) limits.memory = (req.memoryLimit ?? req.memoryRequest)!;
  for (const [k, v] of Object.entries(req.gpuValues ?? {})) {
    requests[k] = v;
    limits[k] = v;
  }

  const trainerContainer: Record<string, unknown> = { name: 'node', image: req.image };
  if (req.command?.length) trainerContainer.command = req.command;
  if (req.args?.length) trainerContainer.args = req.args;
  if (req.env?.length) trainerContainer.env = req.env;
  trainerContainer.resources = { requests, limits };

  // Pre-jobs: each becomes a sibling replicatedJob named after the step,
  // with a dependsOn chain so they run in order. The Kubeflow Trainer v2
  // controller looks at the trainer.kubeflow.org/trainjob-ancestor-step
  // label on the replicatedJob template to identify the step. The trainer
  // ("node") depends on the last pre-job.
  const replicatedJobs: Record<string, unknown>[] = [];
  let lastStep: string | undefined;
  for (const p of req.preJobs ?? []) {
    const container: Record<string, unknown> = { name: p.name, image: p.image };
    if (p.command?.length) container.command = p.command;
    if (p.args?.length) container.args = p.args;
    if (p.env?.length) container.env = p.env;
    const job: Record<string, unknown> = {
      name: p.name,
      template: {
        metadata: { labels: { 'trainer.kubeflow.org/trainjob-ancestor-step': p.name } },
        spec: { template: { spec: { containers: [container] } } },
      },
    };
    if (lastStep) {
      job.dependsOn = [{ name: lastStep, status: 'Complete' }];
    }
    replicatedJobs.push(job);
    lastStep = p.name;
  }
  const trainerJob: Record<string, unknown> = {
    name: 'node',
    template: {
      metadata: { labels: { 'trainer.kubeflow.org/trainjob-ancestor-step': 'trainer' } },
      spec: { template: { spec: { containers: [trainerContainer] } } },
    },
  };
  if (lastStep) {
    trainerJob.dependsOn = [{ name: lastStep, status: 'Complete' }];
  }
  replicatedJobs.push(trainerJob);

  return {
    apiVersion: 'trainer.kubeflow.org/v1alpha1',
    kind: 'ClusterTrainingRuntime',
    metadata: {
      name: req.name,
      labels: { 'knaic.io/managed': 'true', 'knaic.io/component': 'training', 'knaic.io/framework': req.framework },
    },
    spec: {
      mlPolicy: { numNodes: req.numNodes || 1, [req.framework || 'torch']: {} },
      template: { spec: { replicatedJobs } },
    },
  };
}
