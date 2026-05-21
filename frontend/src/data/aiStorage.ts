// Per-namespace state holders for AI Storage. Mirrors data/localModelCache.ts:
// createStore + useStore hooks + ensure-loaded single-flight fetch.
//
// The browser-side state is keyed by namespace because every page already
// reads the user's selected namespace from AppContext — so each store is
// keyed and ensure() needs the namespace passed in. We never silently swap
// the cached value between namespaces; switching namespaces just kicks off
// a fresh fetch.

import { createStore, useStore } from './store';
import { apiEnabled } from '@/api/client';
import {
  listS3Secrets,
  listGitLabConfigs,
  listAIStoragePVCs,
  type S3SecretDTO,
  type GitLabConfigDTO,
  type PVCEntryDTO,
} from '@/api/aiStorage';

interface NSKeyed<T> {
  namespace: string;
  items: T[];
}

const emptyS3: NSKeyed<S3SecretDTO> = { namespace: '', items: [] };
const emptyGL: NSKeyed<GitLabConfigDTO> = { namespace: '', items: [] };
const emptyPVC: NSKeyed<PVCEntryDTO> = { namespace: '', items: [] };

const s3Store = createStore<NSKeyed<S3SecretDTO>>(emptyS3);
const glStore = createStore<NSKeyed<GitLabConfigDTO>>(emptyGL);
const pvcStore = createStore<NSKeyed<PVCEntryDTO>>(emptyPVC);

export const useAIStorageS3Secrets = (ns: string): S3SecretDTO[] => {
  const s = useStore(s3Store);
  return s.namespace === ns ? s.items : [];
};

export const useAIStorageGitLabConfigs = (ns: string): GitLabConfigDTO[] => {
  const s = useStore(glStore);
  return s.namespace === ns ? s.items : [];
};

export const useAIStoragePVCs = (ns: string): PVCEntryDTO[] => {
  const s = useStore(pvcStore);
  return s.namespace === ns ? s.items : [];
};

let s3Loaded = new Map<string, Promise<void>>();
let glLoaded = new Map<string, Promise<void>>();
let pvcLoaded = new Map<string, Promise<void>>();

export function ensureS3SecretsLoaded(ns: string): Promise<void> {
  if (!apiEnabled || !ns) return Promise.resolve();
  if (s3Loaded.has(ns)) return s3Loaded.get(ns)!;
  const p = listS3Secrets(ns)
    .then(items => s3Store.set({ namespace: ns, items }))
    .catch(() => s3Store.set({ namespace: ns, items: [] }))
    .finally(() => {
      s3Loaded.delete(ns);
    });
  s3Loaded.set(ns, p);
  return p;
}

export function ensureGitLabConfigsLoaded(ns: string): Promise<void> {
  if (!apiEnabled || !ns) return Promise.resolve();
  if (glLoaded.has(ns)) return glLoaded.get(ns)!;
  const p = listGitLabConfigs(ns)
    .then(items => glStore.set({ namespace: ns, items }))
    .catch(() => glStore.set({ namespace: ns, items: [] }))
    .finally(() => {
      glLoaded.delete(ns);
    });
  glLoaded.set(ns, p);
  return p;
}

export function ensurePVCsLoadedForAIStorage(ns: string): Promise<void> {
  if (!apiEnabled || !ns) return Promise.resolve();
  if (pvcLoaded.has(ns)) return pvcLoaded.get(ns)!;
  const p = listAIStoragePVCs(ns)
    .then(items => pvcStore.set({ namespace: ns, items }))
    .catch(() => pvcStore.set({ namespace: ns, items: [] }))
    .finally(() => {
      pvcLoaded.delete(ns);
    });
  pvcLoaded.set(ns, p);
  return p;
}

export function reloadS3Secrets(ns: string): Promise<void> {
  s3Loaded.delete(ns);
  return ensureS3SecretsLoaded(ns);
}

export function reloadGitLabConfigs(ns: string): Promise<void> {
  glLoaded.delete(ns);
  return ensureGitLabConfigsLoaded(ns);
}

export function reloadAIStoragePVCs(ns: string): Promise<void> {
  pvcLoaded.delete(ns);
  return ensurePVCsLoadedForAIStorage(ns);
}
