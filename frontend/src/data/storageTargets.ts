import { createStore, useStore, uid } from './store';
import { syntheticMode } from '@/api/client';
import * as api from '@/api/storage';

export interface StorageTarget {
  id: string;
  name: string;
  kind: 's3' | 'oci' | 'pvc';
  endpoint: string;
  bucket?: string;
  prefix?: string;
  builtin: boolean;
  createdAt?: string;
}

// Seed list used in synthetic mode — kept verbatim from the prototype so the
// picker looks the same when running with no backend or with
// VITE_KNAIC_SYNTHETIC=1. Production runs load these from the backend.
const seed: StorageTarget[] = [
  {
    id: uid('st'),
    name: 'Built-in object store',
    kind: 's3',
    endpoint: 'minio.knaic-system.svc.cluster.local:9000',
    bucket: 'knaic-models',
    prefix: '',
    builtin: true,
  },
  {
    id: uid('st'),
    name: 'Built-in OCI registry',
    kind: 'oci',
    endpoint: 'registry.knaic.local',
    prefix: 'models',
    builtin: true,
  },
  {
    id: uid('st'),
    name: 'External S3 (aws-prod)',
    kind: 's3',
    endpoint: 's3.us-east-1.amazonaws.com',
    bucket: 'acme-ml-models',
    prefix: 'prod/',
    builtin: false,
  },
];

export const storageTargetsStore = createStore<StorageTarget[]>(seed);
export const useStorageTargets = () => useStore(storageTargetsStore);

let loaded = false;

// ensureStorageTargetsLoaded fetches the picker contents on first use. In
// synthetic mode it's a no-op — the seeded prototype list stays in place.
export function ensureStorageTargetsLoaded(): void {
  if (syntheticMode || loaded) return;
  loaded = true;
  api
    .listStorageTargets()
    .then(items => storageTargetsStore.set(items.map(fromDTO)))
    .catch(() => {
      loaded = false;
    });
}

export function reloadStorageTargets(): void {
  loaded = false;
  ensureStorageTargetsLoaded();
}

// createStorageTarget / updateStorageTarget / removeStorageTarget are admin
// operations exposed for a future settings UI. Synthetic mode applies the
// change locally so dev iteration on the picker keeps working offline.
export async function createStorageTarget(input: api.CreateStorageTargetInput): Promise<StorageTarget> {
  if (syntheticMode) {
    const t: StorageTarget = { id: uid('st'), builtin: false, ...input };
    storageTargetsStore.set(prev => [...prev, t]);
    return t;
  }
  const created = fromDTO(await api.createStorageTarget(input));
  storageTargetsStore.set(prev => [...prev, created]);
  return created;
}

export async function updateStorageTarget(
  id: string,
  patch: api.PatchStorageTargetInput,
): Promise<StorageTarget> {
  if (syntheticMode) {
    let updated: StorageTarget | null = null;
    storageTargetsStore.set(prev =>
      prev.map(t => {
        if (t.id !== id) return t;
        const next: StorageTarget = { ...t, ...patch };
        updated = next;
        return next;
      }),
    );
    if (!updated) throw new Error('storage target not found');
    return updated;
  }
  const next = fromDTO(await api.patchStorageTarget(id, patch));
  storageTargetsStore.set(prev => prev.map(t => (t.id === id ? next : t)));
  return next;
}

export async function removeStorageTarget(id: string): Promise<void> {
  if (syntheticMode) {
    storageTargetsStore.set(prev => prev.filter(t => t.id !== id));
    return;
  }
  await api.deleteStorageTarget(id);
  storageTargetsStore.set(prev => prev.filter(t => t.id !== id));
}

function fromDTO(t: api.StorageTargetDTO): StorageTarget {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    endpoint: t.endpoint,
    bucket: t.bucket,
    prefix: t.prefix,
    builtin: t.builtin,
    createdAt: t.createdAt,
  };
}

export function targetUri(t: StorageTarget, subpath: string): string {
  if (t.kind === 's3') return `s3://${t.bucket}/${(t.prefix ?? '').replace(/^\/|\/$/g, '')}${t.prefix ? '/' : ''}${subpath}`;
  if (t.kind === 'oci') return `oci://${t.endpoint}/${(t.prefix ?? '').replace(/^\/|\/$/g, '')}${t.prefix ? '/' : ''}${subpath}`;
  return `pvc://${t.name}/${subpath}`;
}
