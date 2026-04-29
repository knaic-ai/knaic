import { createStore, useStore } from './store';
import { apiEnabled } from '@/api/client';
import * as api from '@/api/components';

export interface ComponentItem {
  name: string;
  displayName: string;
  description: string;
  category: 'Inference' | 'Training' | 'GPU' | 'Networking' | 'Observability' | 'Notebook' | 'Scheduling' | 'Experiment';
  versions: string[];
  selectedVersion: string;
  status: 'NotInstalled' | 'Installing' | 'Installed' | 'Failed' | 'Unmanaged';
  namespace: string;
  images: string[];
  imageSync: 'Synced' | 'Pending' | 'Failed';
  notes?: string;
  managedBy?: 'OLM' | 'manual' | 'knaic';
  builtin: boolean;
  /** Backend-only field — true when a chart is bundled in the binary. */
  embedded?: boolean;
  /** Last error returned from a Helm operation, surfaced inline. */
  lastError?: string;
}

const seedCatalog: ComponentItem[] = [
  {
    name: 'kserve',
    displayName: 'KServe',
    description: 'Standard model inference platform on Kubernetes with LLMInferenceService support.',
    category: 'Inference',
    versions: ['v0.13.0', 'v0.14.0', 'v0.15.1'],
    selectedVersion: 'v0.14.0',
    status: 'Installed',
    namespace: 'knaic-system',
    images: ['kserve/kserve-controller:v0.14.0', 'kserve/models-web-app:v0.14.0'],
    imageSync: 'Synced',
    managedBy: 'knaic',
    builtin: true,
  },
  {
    name: 'hami',
    displayName: 'HAMi',
    description: 'Heterogeneous AI computing virtualization — GPU/NPU sharing scheduler.',
    category: 'GPU',
    versions: ['v2.3.11', 'v2.4.0'],
    selectedVersion: 'v2.4.0',
    status: 'Installed',
    namespace: 'knaic-system',
    images: ['projecthami/hami:v2.4.0', 'projecthami/hami-scheduler:v2.4.0'],
    imageSync: 'Synced',
    managedBy: 'knaic',
    builtin: true,
  },
  {
    name: 'nvidia-device-plugin',
    displayName: 'NVIDIA GPU Device Plugin',
    description: 'Exposes NVIDIA GPUs as schedulable resources on each node.',
    category: 'GPU',
    versions: ['v0.14.5', 'v0.15.0', 'v0.17.0'],
    selectedVersion: 'v0.17.0',
    status: 'Unmanaged',
    namespace: 'kube-system',
    images: ['nvcr.io/nvidia/k8s-device-plugin:v0.17.0'],
    imageSync: 'Synced',
    managedBy: 'OLM',
    notes: 'Detected at runtime — installed via NVIDIA GPU Operator (OLM).',
    builtin: true,
  },
  {
    name: 'kf-notebook-controller',
    displayName: 'Kubeflow Notebook Controller',
    description: 'Creates and manages Jupyter notebook servers as Kubernetes resources.',
    category: 'Notebook',
    versions: ['v1.9.0', 'v1.10.0'],
    selectedVersion: 'v1.10.0',
    status: 'NotInstalled',
    namespace: 'knaic-system',
    images: ['ghcr.io/kubeflow/kubeflow/notebook-controller:v1.10.0'],
    imageSync: 'Pending',
    builtin: true,
  },
  {
    name: 'kf-trainer-v2',
    displayName: 'Kubeflow Trainer v2',
    description: 'Next-generation Kubernetes training operator for LLM fine-tuning.',
    category: 'Training',
    versions: ['v2.0.0-rc.0', 'v2.0.0'],
    selectedVersion: 'v2.0.0',
    status: 'Installed',
    namespace: 'knaic-system',
    images: ['kubeflow/trainer-controller-manager:v2.0.0'],
    imageSync: 'Synced',
    managedBy: 'knaic',
    builtin: true,
  },
  {
    name: 'envoy-gateway',
    displayName: 'Envoy Gateway',
    description: 'Kubernetes-native Envoy Gateway implementation.',
    category: 'Networking',
    versions: ['v1.2.1', 'v1.3.0'],
    selectedVersion: 'v1.3.0',
    status: 'Installed',
    namespace: 'knaic-system',
    images: ['envoyproxy/gateway:v1.3.0'],
    imageSync: 'Synced',
    managedBy: 'knaic',
    builtin: true,
  },
  {
    name: 'envoy-ai-gateway',
    displayName: 'Envoy AI Gateway',
    description: 'LLM-aware routing, rate limiting and token quota on top of Envoy Gateway.',
    category: 'Networking',
    versions: ['v0.2.0', 'v0.3.0'],
    selectedVersion: 'v0.3.0',
    status: 'NotInstalled',
    namespace: 'knaic-system',
    images: ['envoyproxy/ai-gateway:v0.3.0'],
    imageSync: 'Pending',
    builtin: true,
  },
  {
    name: 'lws',
    displayName: 'LeaderWorkerSet (LWS)',
    description: 'Multi-host inference / training group scheduling primitive.',
    category: 'Inference',
    versions: ['v0.4.1', 'v0.5.0'],
    selectedVersion: 'v0.5.0',
    status: 'Installed',
    namespace: 'knaic-system',
    images: ['registry.k8s.io/lws/lws:v0.5.0'],
    imageSync: 'Synced',
    managedBy: 'knaic',
    builtin: true,
  },
  {
    name: 'jobset',
    displayName: 'JobSet',
    description: 'Groups multiple Jobs into a single logical unit for distributed workloads.',
    category: 'Scheduling',
    versions: ['v0.6.0', 'v0.7.2'],
    selectedVersion: 'v0.7.2',
    status: 'Installed',
    namespace: 'knaic-system',
    images: ['registry.k8s.io/jobset/jobset:v0.7.2'],
    imageSync: 'Synced',
    managedBy: 'knaic',
    builtin: true,
  },
  {
    name: 'prometheus',
    displayName: 'Prometheus',
    description: 'Metrics collection and storage — powers the monitoring dashboards.',
    category: 'Observability',
    versions: ['v2.54.0', 'v2.55.0', 'v3.0.0'],
    selectedVersion: 'v2.55.0',
    status: 'Installed',
    namespace: 'knaic-system',
    images: ['prom/prometheus:v2.55.0', 'prom/node-exporter:v1.8.2'],
    imageSync: 'Synced',
    managedBy: 'knaic',
    builtin: true,
  },
  {
    name: 'mlflow',
    displayName: 'MLflow',
    description: 'Experiment tracking and model registry. Used by TrainJobs to report metrics.',
    category: 'Experiment',
    versions: ['v2.16.2', 'v2.17.1', 'v2.18.0'],
    selectedVersion: 'v2.18.0',
    status: 'Installed',
    namespace: 'knaic-system',
    images: ['ghcr.io/mlflow/mlflow:v2.18.0'],
    imageSync: 'Synced',
    managedBy: 'knaic',
    builtin: true,
  },
];

export const componentsStore = createStore<ComponentItem[]>(seedCatalog);

export const useComponents = () => useStore(componentsStore);

// ---- API-backed mutators -----------------------------------------------
//
// When the backend is reachable, every mutator round-trips through the API
// and the local store is replaced with whatever the server returns. When
// the backend is not reachable (apiEnabled === false), the mutators fall
// back to the in-memory simulation that the prototype shipped with — that
// way the UI keeps working in pure design-review mode.

let didInitialLoad = false;

export async function loadFromApi(): Promise<void> {
  if (!apiEnabled) return;
  const items = await api.listComponents();
  componentsStore.set(items);
  didInitialLoad = true;
}

export function ensureInitialLoad(): void {
  if (didInitialLoad || !apiEnabled) return;
  void loadFromApi().catch(() => {
    // Fail-soft: the UI keeps the seed catalog. The page surfaces an error
    // banner via the Components page when load throws.
  });
}

function replaceOne(updated: ComponentItem) {
  componentsStore.set(prev => prev.map(c => (c.name === updated.name ? updated : c)));
}

export function updateComponent(name: string, patch: Partial<ComponentItem>) {
  // Always update locally for snappy UI; if API is on and the patch carries
  // selectedVersion, persist it server-side too.
  componentsStore.set(prev => prev.map(c => (c.name === name ? { ...c, ...patch } : c)));
  if (apiEnabled && patch.selectedVersion) {
    api.patchComponent(name, { selectedVersion: patch.selectedVersion })
      .then(replaceOne)
      .catch(() => undefined);
  }
}

export async function installComponent(name: string): Promise<void> {
  if (apiEnabled) {
    componentsStore.set(prev => prev.map(c => (c.name === name ? { ...c, status: 'Installing' } : c)));
    try {
      const updated = await api.installComponentApi(name);
      replaceOne(updated);
    } catch (e) {
      componentsStore.set(prev =>
        prev.map(c => (c.name === name ? { ...c, status: 'Failed', lastError: (e as Error).message } : c)),
      );
      throw e;
    }
    return;
  }
  // Prototype simulation fallback.
  componentsStore.set(prev =>
    prev.map(c => (c.name === name ? { ...c, status: 'Installing', imageSync: 'Pending', managedBy: 'knaic' } : c)),
  );
  window.setTimeout(() => {
    componentsStore.set(prev => prev.map(c => (c.name === name ? { ...c, imageSync: 'Synced' } : c)));
  }, 1200);
  window.setTimeout(() => {
    componentsStore.set(prev => prev.map(c => (c.name === name ? { ...c, status: 'Installed' } : c)));
  }, 2500);
}

export async function uninstallComponent(name: string): Promise<void> {
  if (apiEnabled) {
    try {
      const updated = await api.uninstallComponentApi(name);
      replaceOne(updated);
    } catch (e) {
      componentsStore.set(prev =>
        prev.map(c => (c.name === name ? { ...c, status: 'Failed', lastError: (e as Error).message } : c)),
      );
      throw e;
    }
    return;
  }
  componentsStore.set(prev =>
    prev.map(c => (c.name === name ? { ...c, status: 'NotInstalled', imageSync: 'Pending' } : c)),
  );
}

export async function reconcileComponent(name: string): Promise<void> {
  if (apiEnabled) {
    componentsStore.set(prev => prev.map(c => (c.name === name ? { ...c, status: 'Installing' } : c)));
    const updated = await api.reconcileComponentApi(name);
    replaceOne(updated);
    return;
  }
  componentsStore.set(prev => prev.map(c => (c.name === name ? { ...c, status: 'Installing' } : c)));
  window.setTimeout(() => {
    componentsStore.set(prev => prev.map(c => (c.name === name ? { ...c, status: 'Installed' } : c)));
  }, 1500);
}

export async function adoptComponent(name: string): Promise<void> {
  if (apiEnabled) {
    const updated = await api.adoptComponentApi(name);
    replaceOne(updated);
    return;
  }
  componentsStore.set(prev =>
    prev.map(c => (c.name === name ? { ...c, status: 'Installed', managedBy: 'knaic' } : c)),
  );
}

export async function addImportedComponent(item: Omit<ComponentItem, 'builtin'>): Promise<void> {
  if (apiEnabled) {
    const created = await api.importComponent({
      name: item.name,
      displayName: item.displayName,
      description: item.description,
      category: item.category,
      version: item.selectedVersion,
      namespace: item.namespace,
      images: item.images,
    });
    componentsStore.set(prev => [...prev, created]);
    return;
  }
  componentsStore.set(prev => [...prev, { ...item, builtin: false }]);
}

export async function removeComponent(name: string): Promise<void> {
  if (apiEnabled) {
    await api.deleteComponent(name);
    componentsStore.set(prev => prev.filter(c => c.name !== name));
    return;
  }
  componentsStore.set(prev => prev.filter(c => c.name !== name));
}

// ---- Image registry config ----------------------------------------------

export interface RegistryConfig {
  endpoint: string;
  username: string;
  project: string;
  useBuiltin: boolean;
  totalImages: number;
  syncedImages: number;
  diskUsageGi: number;
  capacityGi: number;
  lastSyncedAt?: string;
}

export const registryStore = createStore<RegistryConfig>({
  endpoint: 'registry.knaic.local',
  username: 'knaic',
  project: 'components',
  useBuiltin: true,
  totalImages: 24,
  syncedImages: 22,
  diskUsageGi: 178,
  capacityGi: 512,
});

export const useRegistry = () => useStore(registryStore);

let didLoadRegistry = false;

export function ensureRegistryLoaded(): void {
  if (didLoadRegistry || !apiEnabled) return;
  didLoadRegistry = true;
  api.getRegistry()
    .then(cfg => registryStore.set(cfg))
    .catch(() => {
      didLoadRegistry = false;
    });
}

export async function syncAllImages(): Promise<void> {
  if (apiEnabled) {
    const cfg = await api.syncRegistry();
    registryStore.set(cfg);
    return;
  }
  const cur = registryStore.get();
  registryStore.set({ ...cur, syncedImages: cur.totalImages });
}

export async function updateRegistry(patch: Partial<RegistryConfig>): Promise<void> {
  if (apiEnabled) {
    const cfg = await api.patchRegistry(patch);
    registryStore.set(cfg);
    return;
  }
  registryStore.set(prev => ({ ...prev, ...patch }));
}

// Helper retained for the import-chart modal — lets callers fall back to a
// metadata-only scaffold when no chart archive is attached.
export const sampleImportedChart = (name: string, version: string): Omit<ComponentItem, 'builtin'> => ({
  name,
  displayName: name,
  description: 'Imported Helm chart.',
  category: 'Inference',
  versions: [version],
  selectedVersion: version,
  status: 'NotInstalled',
  namespace: 'knaic-system',
  images: [`registry.example.com/${name}:${version}`],
  imageSync: 'Pending',
});
