import { createStore, useStore, uid } from './store';

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
