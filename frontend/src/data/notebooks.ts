import { createStore, useStore, uid } from './store';

export type NotebookVolumeKind = 'new' | 'existing' | 'none';

export interface NotebookVolume {
  kind: NotebookVolumeKind;
  pvcName?: string;
  storageClass?: string;
  capacity?: string;
  mountPath?: string;
}

export interface Notebook {
  id: string;
  name: string;
  namespace: string;
  image: string;
  cpu: string;
  cpuLimit?: string;
  memory: string;
  memoryLimit?: string;
  gpu: number;
  gpuProfileId?: string;
  gpuValues?: Record<string, number>;
  volume: NotebookVolume;
  sharedMemory: string;
  status: 'Running' | 'Stopped' | 'Progressing' | 'Failed';
  url: string;
  createdAt: string;
  owner: string;
}

const nowDate = () => new Date().toISOString().slice(0, 10);

const initial: Notebook[] = [
  {
    id: uid('nb'),
    name: 'alice-research',
    namespace: 'team-ml',
    image: 'kubeflownotebookswg/jupyter-pytorch-cuda-full:v1.10.0',
    cpu: '4',
    cpuLimit: '4',
    memory: '16Gi',
    memoryLimit: '16Gi',
    gpu: 1,
    gpuValues: { 'nvidia.com/gpu': 1 },
    volume: { kind: 'existing', pvcName: 'notebook-alice-home', mountPath: '/home/jovyan' },
    sharedMemory: '2Gi',
    status: 'Running',
    url: '/notebook/team-ml/alice-research',
    createdAt: nowDate(),
    owner: 'alice',
  },
  {
    id: uid('nb'),
    name: 'bob-eval',
    namespace: 'team-ml',
    image: 'kubeflownotebookswg/jupyter-scipy:v1.10.0',
    cpu: '2',
    cpuLimit: '2',
    memory: '8Gi',
    memoryLimit: '8Gi',
    gpu: 0,
    volume: { kind: 'existing', pvcName: 'notebook-bob-home', mountPath: '/home/jovyan' },
    sharedMemory: '512Mi',
    status: 'Stopped',
    url: '/notebook/team-ml/bob-eval',
    createdAt: nowDate(),
    owner: 'bob',
  },
  {
    id: uid('nb'),
    name: 'carol-vision',
    namespace: 'team-vision',
    image: 'kubeflownotebookswg/jupyter-pytorch-cuda-full:v1.10.0',
    cpu: '4',
    cpuLimit: '4',
    memory: '16Gi',
    memoryLimit: '16Gi',
    gpu: 1,
    gpuValues: { 'nvidia.com/gpu': 1 },
    volume: { kind: 'existing', pvcName: 'notebook-carol-home', mountPath: '/home/jovyan' },
    sharedMemory: '2Gi',
    status: 'Progressing',
    url: '/notebook/team-vision/carol-vision',
    createdAt: nowDate(),
    owner: 'carol',
  },
];

export const notebooksStore = createStore<Notebook[]>(initial);
export const useNotebooks = () => useStore(notebooksStore);

// ---- API-backed loaders + mutators -------------------------------------

import { apiEnabled } from '@/api/client';
import {
  listNotebooks as apiList,
  createNotebook as apiCreate,
  startNotebook as apiStart,
  stopNotebook as apiStop,
  type CreateNotebookRequest,
} from '@/api/notebooks';
import { deleteNamespaced as apiDelete } from '@/api/k8sres';

const loaded = new Set<string>();

function ensureNbDefaults(n: Notebook): Notebook {
  return {
    ...n,
    id: n.id || `nb-${n.namespace}-${n.name}`,
    cpuLimit: n.cpuLimit ?? n.cpu,
    memoryLimit: n.memoryLimit ?? n.memory,
    volume: n.volume ?? { kind: 'none' },
    sharedMemory: n.sharedMemory ?? '',
  };
}

export function ensureNotebooksLoaded(ns: string) {
  if (!apiEnabled) return;
  const k = `nb:${ns}`;
  if (loaded.has(k)) return;
  loaded.add(k);
  apiList(ns)
    .then(items => {
      notebooksStore.set(prev => [
        ...prev.filter(n => n.namespace !== ns),
        ...items.map(ensureNbDefaults),
      ]);
    })
    .catch(() => loaded.delete(k));
}

export function reloadNotebooks(ns: string) {
  loaded.delete(`nb:${ns}`);
  ensureNotebooksLoaded(ns);
}

export async function createNotebook(ns: string, req: CreateNotebookRequest): Promise<void> {
  if (apiEnabled) {
    await apiCreate(ns, req);
    reloadNotebooks(ns);
    return;
  }
  // Prototype fallback — push synthetic entry transitioning Progressing→Running.
  const owner = req.owner ?? 'me';
  const gpuTotal = Object.values(req.gpuValues ?? {}).reduce((s, n) => s + n, 0);
  const nb: Notebook = ensureNbDefaults({
    id: `nb-${ns}-${req.name}`,
    name: req.name,
    namespace: ns,
    image: req.image,
    cpu: req.cpuRequest,
    cpuLimit: req.cpuLimit,
    memory: req.memoryRequest,
    memoryLimit: req.memoryLimit,
    gpu: gpuTotal,
    gpuValues: req.gpuValues,
    volume: { kind: req.volume.kind, pvcName: req.volume.pvcName, mountPath: req.volume.mountPath },
    sharedMemory: req.sharedMemory ?? '2Gi',
    status: 'Progressing',
    url: `/notebook/${ns}/${req.name}`,
    createdAt: new Date().toISOString().slice(0, 10),
    owner,
  });
  notebooksStore.set(prev => [nb, ...prev]);
  window.setTimeout(() => {
    notebooksStore.set(prev =>
      prev.map(n => (n.id === nb.id ? { ...n, status: 'Running' } : n)),
    );
  }, 1500);
}

export async function startNotebook(ns: string, name: string): Promise<void> {
  if (apiEnabled) {
    await apiStart(ns, name);
    reloadNotebooks(ns);
    return;
  }
  notebooksStore.set(prev =>
    prev.map(n => (n.namespace === ns && n.name === name ? { ...n, status: 'Progressing' } : n)),
  );
  window.setTimeout(() => {
    notebooksStore.set(prev =>
      prev.map(n => (n.namespace === ns && n.name === name ? { ...n, status: 'Running' } : n)),
    );
  }, 1200);
}

export async function stopNotebook(ns: string, name: string): Promise<void> {
  if (apiEnabled) {
    await apiStop(ns, name);
    reloadNotebooks(ns);
    return;
  }
  notebooksStore.set(prev =>
    prev.map(n => (n.namespace === ns && n.name === name ? { ...n, status: 'Progressing' } : n)),
  );
  window.setTimeout(() => {
    notebooksStore.set(prev =>
      prev.map(n => (n.namespace === ns && n.name === name ? { ...n, status: 'Stopped' } : n)),
    );
  }, 1200);
}

export async function deleteNotebook(ns: string, name: string): Promise<void> {
  if (apiEnabled) {
    await apiDelete('notebooks', ns, name);
    reloadNotebooks(ns);
    return;
  }
  notebooksStore.set(prev => prev.filter(n => !(n.namespace === ns && n.name === name)));
}
