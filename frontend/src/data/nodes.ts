import { createStore, useStore } from './store';
import { apiEnabled } from '@/api/client';
import * as api from '@/api/admin';

export interface Taint {
  key: string;
  value?: string;
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
}

export interface NodeInfo {
  name: string;
  role: 'control-plane' | 'worker' | 'gpu-worker';
  cpu: string;
  memory: string;
  gpu: string;
  status: 'Ready' | 'NotReady';
  kubelet: string;
  kernel: string;
  labels: Record<string, string>;
  taints: Taint[];
}

const initial: NodeInfo[] = [
  {
    name: 'cp-node-01', role: 'control-plane', cpu: '16', memory: '64Gi', gpu: '-', status: 'Ready',
    kubelet: 'v1.30.5', kernel: '5.15.0',
    labels: { 'node-role.kubernetes.io/control-plane': 'true' },
    taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }],
  },
  {
    name: 'cpu-node-01', role: 'worker', cpu: '32', memory: '128Gi', gpu: '-', status: 'Ready',
    kubelet: 'v1.30.5', kernel: '5.15.0',
    labels: { 'node.knaic.io/role': 'general' }, taints: [],
  },
  {
    name: 'cpu-node-02', role: 'worker', cpu: '32', memory: '128Gi', gpu: '-', status: 'Ready',
    kubelet: 'v1.30.5', kernel: '5.15.0',
    labels: { 'node.knaic.io/role': 'general' }, taints: [],
  },
  {
    name: 'cpu-node-03', role: 'worker', cpu: '32', memory: '128Gi', gpu: '-', status: 'NotReady',
    kubelet: 'v1.30.5', kernel: '5.15.0',
    labels: {}, taints: [],
  },
  {
    name: 'gpu-node-01', role: 'gpu-worker', cpu: '64', memory: '512Gi', gpu: '8 × A100-80GB', status: 'Ready',
    kubelet: 'v1.30.5', kernel: '5.15.0',
    labels: { 'nvidia.com/gpu.product': 'A100-SXM4-80GB', 'node.knaic.io/accelerator': 'nvidia' },
    taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }],
  },
  {
    name: 'gpu-node-02', role: 'gpu-worker', cpu: '64', memory: '512Gi', gpu: '8 × A100-80GB', status: 'Ready',
    kubelet: 'v1.30.5', kernel: '5.15.0',
    labels: { 'nvidia.com/gpu.product': 'A100-SXM4-80GB', 'node.knaic.io/accelerator': 'nvidia' },
    taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }],
  },
  {
    name: 'gpu-node-03', role: 'gpu-worker', cpu: '96', memory: '1024Gi', gpu: '8 × H100-80GB', status: 'Ready',
    kubelet: 'v1.30.5', kernel: '5.15.0',
    labels: { 'nvidia.com/gpu.product': 'H100-SXM5-80GB', 'node.knaic.io/accelerator': 'nvidia' },
    taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }],
  },
];

export const nodesStore = createStore<NodeInfo[]>(initial);
export const useNodes = () => useStore(nodesStore);

let loaded = false;

export function ensureNodesLoaded(): void {
  if (!apiEnabled || loaded) return;
  loaded = true;
  api.listNodes()
    .then(nodes => nodesStore.set(nodes))
    .catch(() => {
      loaded = false;
    });
}

export function reloadNodes(): void {
  loaded = false;
  ensureNodesLoaded();
}

export async function updateNode(name: string, patch: Partial<NodeInfo>): Promise<void> {
  if (apiEnabled) {
    const updated = await api.patchNode(name, { labels: patch.labels, taints: patch.taints });
    nodesStore.set(prev => prev.map(n => (n.name === name ? updated : n)));
    return;
  }
  nodesStore.set(prev => prev.map(n => (n.name === name ? { ...n, ...patch } : n)));
}
