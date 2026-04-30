import { createStore, useStore, uid } from './store';
import { apiEnabled } from '@/api/client';
import {
  listNamespaced,
  deleteNamespaced,
  fetchYaml as apiFetchYaml,
  createNamespaced,
  updateNamespaced,
  type Slug,
} from '@/api/k8sres';

export interface Deployment {
  id: string;
  name: string;
  namespace: string;
  image: string;
  replicas: number;
  readyReplicas: number;
  status: 'Running' | 'Progressing' | 'Failed';
  createdAt: string;
  labels: Record<string, string>;
}

export interface Pod {
  id: string;
  name: string;
  namespace: string;
  node: string;
  ip: string;
  status: 'Running' | 'Pending' | 'Failed' | 'CrashLoopBackOff';
  restarts: number;
  age: string;
  containers: string[];
  ownerRef?: string;
}

export interface StatefulSet {
  id: string;
  name: string;
  namespace: string;
  image: string;
  replicas: number;
  readyReplicas: number;
  status: 'Running' | 'Progressing' | 'Failed';
  createdAt: string;
  serviceName: string;
}

export interface PVC {
  id: string;
  name: string;
  namespace: string;
  status: 'Bound' | 'Pending' | 'Failed';
  storageClass: string;
  capacity: string;
  accessMode: string;
  volumeName: string;
  createdAt: string;
}

const nowDate = () => new Date().toISOString().slice(0, 10);

const deploymentsInitial: Deployment[] = [
  {
    id: uid('dep'),
    name: 'qwen3-5-7b',
    namespace: 'team-ml',
    image: 'vllm/vllm-openai:v0.7.2',
    replicas: 2,
    readyReplicas: 2,
    status: 'Running',
    createdAt: nowDate(),
    labels: { app: 'qwen3-5-7b', 'serving.kserve.io/inferenceservice': 'qwen3-5-7b' },
  },
  {
    id: uid('dep'),
    name: 'bge-embed',
    namespace: 'team-ml',
    image: 'ghcr.io/huggingface/text-embeddings-inference:1.5.1',
    replicas: 1,
    readyReplicas: 1,
    status: 'Running',
    createdAt: nowDate(),
    labels: { app: 'bge-embed' },
  },
  {
    id: uid('dep'),
    name: 'helpdesk-agent',
    namespace: 'team-ml',
    image: 'registry.knaic.local/team-ml/helpdesk-agent:v0.3.2',
    replicas: 3,
    readyReplicas: 2,
    status: 'Progressing',
    createdAt: nowDate(),
    labels: { app: 'helpdesk-agent' },
  },
  {
    id: uid('dep'),
    name: 'sd3-frontend',
    namespace: 'team-vision',
    image: 'registry.knaic.local/team-vision/sd3-frontend:v1.4.0',
    replicas: 1,
    readyReplicas: 0,
    status: 'Failed',
    createdAt: nowDate(),
    labels: { app: 'sd3-frontend' },
  },
];

const podsInitial: Pod[] = [
  {
    id: uid('pod'),
    name: 'qwen3-5-7b-7f9b8c-abcde',
    namespace: 'team-ml',
    node: 'gpu-node-01',
    ip: '10.244.1.12',
    status: 'Running',
    restarts: 0,
    age: '3d',
    containers: ['kserve-container', 'queue-proxy'],
    ownerRef: 'Deployment/qwen3-5-7b',
  },
  {
    id: uid('pod'),
    name: 'qwen3-5-7b-7f9b8c-fghij',
    namespace: 'team-ml',
    node: 'gpu-node-02',
    ip: '10.244.2.15',
    status: 'Running',
    restarts: 0,
    age: '3d',
    containers: ['kserve-container', 'queue-proxy'],
    ownerRef: 'Deployment/qwen3-5-7b',
  },
  {
    id: uid('pod'),
    name: 'bge-embed-7ddf4-klmno',
    namespace: 'team-ml',
    node: 'cpu-node-01',
    ip: '10.244.3.7',
    status: 'Running',
    restarts: 1,
    age: '12h',
    containers: ['main'],
    ownerRef: 'Deployment/bge-embed',
  },
  {
    id: uid('pod'),
    name: 'helpdesk-agent-6b57-xyzab',
    namespace: 'team-ml',
    node: 'cpu-node-02',
    ip: '10.244.4.9',
    status: 'CrashLoopBackOff',
    restarts: 7,
    age: '4m',
    containers: ['agent'],
    ownerRef: 'Deployment/helpdesk-agent',
  },
  {
    id: uid('pod'),
    name: 'sd3-frontend-55b-zzzzz',
    namespace: 'team-vision',
    node: 'cpu-node-03',
    ip: '10.244.5.22',
    status: 'Pending',
    restarts: 0,
    age: '2m',
    containers: ['frontend'],
    ownerRef: 'Deployment/sd3-frontend',
  },
];

const statefulSetsInitial: StatefulSet[] = [
  {
    id: uid('ss'),
    name: 'postgres-knaic',
    namespace: 'knaic-system',
    image: 'postgres:16.4',
    replicas: 1,
    readyReplicas: 1,
    status: 'Running',
    createdAt: nowDate(),
    serviceName: 'postgres-knaic',
  },
  {
    id: uid('ss'),
    name: 'prometheus-k8s',
    namespace: 'knaic-system',
    image: 'prom/prometheus:v2.55.0',
    replicas: 2,
    readyReplicas: 2,
    status: 'Running',
    createdAt: nowDate(),
    serviceName: 'prometheus-k8s',
  },
  {
    id: uid('ss'),
    name: 'vllm-qwen-72b',
    namespace: 'team-llm',
    image: 'vllm/vllm-openai:v0.7.2',
    replicas: 4,
    readyReplicas: 3,
    status: 'Progressing',
    createdAt: nowDate(),
    serviceName: 'vllm-qwen-72b',
  },
];

const pvcsInitial: PVC[] = [
  {
    id: uid('pvc'),
    name: 'qwen3-5-7b-cache',
    namespace: 'team-ml',
    status: 'Bound',
    storageClass: 'nvme-premium',
    capacity: '200Gi',
    accessMode: 'RWO',
    volumeName: 'pvc-2ad1c',
    createdAt: nowDate(),
  },
  {
    id: uid('pvc'),
    name: 'helpdesk-agent-data',
    namespace: 'team-ml',
    status: 'Bound',
    storageClass: 'standard',
    capacity: '50Gi',
    accessMode: 'RWO',
    volumeName: 'pvc-47af1',
    createdAt: nowDate(),
  },
  {
    id: uid('pvc'),
    name: 'notebook-alice-home',
    namespace: 'team-ml',
    status: 'Bound',
    storageClass: 'standard',
    capacity: '20Gi',
    accessMode: 'RWO',
    volumeName: 'pvc-9c23b',
    createdAt: nowDate(),
  },
  {
    id: uid('pvc'),
    name: 'sd3-assets',
    namespace: 'team-vision',
    status: 'Pending',
    storageClass: 'standard',
    capacity: '100Gi',
    accessMode: 'RWX',
    volumeName: '',
    createdAt: nowDate(),
  },
];

export const deploymentsStore = createStore<Deployment[]>(deploymentsInitial);
export const podsStore = createStore<Pod[]>(podsInitial);
export const statefulSetsStore = createStore<StatefulSet[]>(statefulSetsInitial);
export const pvcsStore = createStore<PVC[]>(pvcsInitial);

export const useDeployments = () => useStore(deploymentsStore);
export const usePods = () => useStore(podsStore);
export const useStatefulSets = () => useStore(statefulSetsStore);
export const usePVCs = () => useStore(pvcsStore);

// ---- API-backed loaders -------------------------------------------------
//
// Each loader takes a namespace, replaces the store with whatever the
// backend returns, and merges entries from other namespaces back in so
// switching the namespace switcher doesn't drop already-fetched data.
//
// The Components page uses a similar pattern; if you change one, change
// both for consistency.

async function loadInto<T extends { namespace: string; id?: string; name: string }>(
  store: ReturnType<typeof createStore<T[]>>,
  slug: Slug,
  ns: string,
  ensureId: (item: T) => T,
): Promise<void> {
  const remote = (await listNamespaced<T>(slug, ns)).map(ensureId);
  store.set(prev => [
    ...prev.filter(p => p.namespace !== ns),
    ...remote,
  ]);
}

const ensureDepId = (d: Deployment): Deployment => ({
  ...d,
  id: d.id || `dep-${d.namespace}-${d.name}`,
  labels: d.labels ?? {},
});
const ensurePodId = (p: Pod): Pod => ({
  ...p,
  id: p.id || `pod-${p.namespace}-${p.name}`,
  containers: p.containers ?? [],
});
const ensureSsId = (s: StatefulSet): StatefulSet => ({
  ...s,
  id: s.id || `ss-${s.namespace}-${s.name}`,
});
const ensurePvcId = (v: PVC): PVC => ({
  ...v,
  id: v.id || `pvc-${v.namespace}-${v.name}`,
});

const loaded = new Set<string>();
function once(key: string, fn: () => Promise<void>) {
  if (loaded.has(key)) return;
  loaded.add(key);
  fn().catch(() => loaded.delete(key));
}

export function ensureDeploymentsLoaded(ns: string) {
  if (!apiEnabled) return;
  once(`dep:${ns}`, () => loadInto(deploymentsStore, 'deployments', ns, ensureDepId));
}
export function ensurePodsLoaded(ns: string) {
  if (!apiEnabled) return;
  once(`pod:${ns}`, () => loadInto(podsStore, 'pods', ns, ensurePodId));
}
export function ensureStatefulSetsLoaded(ns: string) {
  if (!apiEnabled) return;
  once(`ss:${ns}`, () => loadInto(statefulSetsStore, 'statefulsets', ns, ensureSsId));
}
export function ensurePvcsLoaded(ns: string) {
  if (!apiEnabled) return;
  once(`pvc:${ns}`, () => loadInto(pvcsStore, 'pvcs', ns, ensurePvcId));
}

// reload* functions force a refresh (used after a successful delete).
export async function reloadDeployments(ns: string) {
  loaded.delete(`dep:${ns}`);
  ensureDeploymentsLoaded(ns);
}
export async function reloadPods(ns: string) {
  loaded.delete(`pod:${ns}`);
  ensurePodsLoaded(ns);
}
export async function reloadStatefulSets(ns: string) {
  loaded.delete(`ss:${ns}`);
  ensureStatefulSetsLoaded(ns);
}
export async function reloadPvcs(ns: string) {
  loaded.delete(`pvc:${ns}`);
  ensurePvcsLoaded(ns);
}

export async function deleteWorkload(slug: Slug, ns: string, name: string): Promise<void> {
  if (apiEnabled) {
    await deleteNamespaced(slug, ns, name);
  }
  // Keep the local render cache in sync in both API and prototype modes.
  switch (slug) {
    case 'deployments':
      deploymentsStore.set(prev => prev.filter(d => !(d.namespace === ns && d.name === name)));
      break;
    case 'pods':
      podsStore.set(prev => prev.filter(p => !(p.namespace === ns && p.name === name)));
      break;
    case 'statefulsets':
      statefulSetsStore.set(prev => prev.filter(s => !(s.namespace === ns && s.name === name)));
      break;
    case 'pvcs':
      pvcsStore.set(prev => prev.filter(v => !(v.namespace === ns && v.name === name)));
      break;
    default:
      break;
  }
}

export async function fetchResourceYaml(slug: Slug, ns: string, name: string): Promise<string> {
  if (apiEnabled) return apiFetchYaml(slug, ns, name);
  return `# Prototype mode — no real YAML available.\n# kind: ${slug}\nmetadata:\n  name: ${name}\n  namespace: ${ns}\n`;
}

export function findPodForOwner(namespace: string, kind: 'Deployment' | 'StatefulSet', name: string): Pod | undefined {
  return podsStore.get().find(p => p.namespace === namespace && p.ownerRef === `${kind}/${name}`);
}

export async function createDeployment(ns: string, req: Pick<Deployment, 'name' | 'image' | 'replicas'>): Promise<void> {
  if (apiEnabled) {
    await createNamespaced<Deployment>('deployments', ns, deploymentObject(ns, req));
    reloadDeployments(ns);
    return;
  }
  deploymentsStore.set(prev => [
    {
      id: uid('dep'),
      name: req.name,
      namespace: ns,
      image: req.image,
      replicas: req.replicas,
      readyReplicas: 0,
      status: 'Progressing',
      createdAt: new Date().toISOString().slice(0, 10),
      labels: { app: req.name },
    },
    ...prev,
  ]);
  window.setTimeout(() => {
    deploymentsStore.set(prev =>
      prev.map(d => (d.namespace === ns && d.name === req.name ? { ...d, readyReplicas: req.replicas, status: 'Running' } : d)),
    );
  }, 1200);
}

export async function updateDeployment(ns: string, current: Deployment, patch: Pick<Deployment, 'image' | 'replicas'>): Promise<void> {
  if (apiEnabled) {
    await updateNamespaced<Deployment>('deployments', ns, current.name, deploymentObject(ns, { ...current, ...patch }));
    reloadDeployments(ns);
    return;
  }
  deploymentsStore.set(prev =>
    prev.map(d => (d.id === current.id ? { ...d, ...patch, readyReplicas: Math.min(d.readyReplicas, patch.replicas) } : d)),
  );
}

export async function createStatefulSet(ns: string, req: Pick<StatefulSet, 'name' | 'image' | 'replicas'>): Promise<void> {
  if (apiEnabled) {
    await createNamespaced<StatefulSet>('statefulsets', ns, statefulSetObject(ns, req));
    reloadStatefulSets(ns);
    return;
  }
  statefulSetsStore.set(prev => [
    {
      id: uid('ss'),
      name: req.name,
      namespace: ns,
      image: req.image,
      replicas: req.replicas,
      readyReplicas: 0,
      status: 'Progressing',
      createdAt: new Date().toISOString().slice(0, 10),
      serviceName: req.name,
    },
    ...prev,
  ]);
  window.setTimeout(() => {
    statefulSetsStore.set(prev =>
      prev.map(s => (s.namespace === ns && s.name === req.name ? { ...s, readyReplicas: req.replicas, status: 'Running' } : s)),
    );
  }, 1500);
}

export async function createPVC(ns: string, req: Pick<PVC, 'name' | 'storageClass' | 'capacity' | 'accessMode'>): Promise<void> {
  if (apiEnabled) {
    await createNamespaced<PVC>('pvcs', ns, pvcObject(ns, req));
    reloadPvcs(ns);
    return;
  }
  pvcsStore.set(prev => [
    {
      id: uid('pvc'),
      name: req.name,
      namespace: ns,
      status: 'Pending',
      storageClass: req.storageClass,
      capacity: req.capacity,
      accessMode: req.accessMode,
      volumeName: '',
      createdAt: new Date().toISOString().slice(0, 10),
    },
    ...prev,
  ]);
  window.setTimeout(() => {
    pvcsStore.set(prev =>
      prev.map(p => (p.namespace === ns && p.name === req.name ? { ...p, status: 'Bound', volumeName: `pvc-${req.name}` } : p)),
    );
  }, 1200);
}

function deploymentObject(ns: string, req: Pick<Deployment, 'name' | 'image' | 'replicas'>) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: req.name, namespace: ns, labels: { app: req.name } },
    spec: {
      replicas: req.replicas,
      selector: { matchLabels: { app: req.name } },
      template: {
        metadata: { labels: { app: req.name } },
        spec: { containers: [{ name: 'main', image: req.image }] },
      },
    },
  };
}

function statefulSetObject(ns: string, req: Pick<StatefulSet, 'name' | 'image' | 'replicas'>) {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: req.name, namespace: ns, labels: { app: req.name } },
    spec: {
      replicas: req.replicas,
      serviceName: req.name,
      selector: { matchLabels: { app: req.name } },
      template: {
        metadata: { labels: { app: req.name } },
        spec: { containers: [{ name: 'main', image: req.image }] },
      },
    },
  };
}

function pvcObject(ns: string, req: Pick<PVC, 'name' | 'storageClass' | 'capacity' | 'accessMode'>) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: req.name, namespace: ns },
    spec: {
      accessModes: [req.accessMode === 'RWO' ? 'ReadWriteOnce' : req.accessMode === 'RWX' ? 'ReadWriteMany' : req.accessMode],
      storageClassName: req.storageClass,
      resources: { requests: { storage: req.capacity } },
    },
  };
}
