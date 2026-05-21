// Store + YAML builders for KServe Local Model Cache resources.
//
// Mirrors the pattern in data/inference.ts: a createStore() per kind +
// useStore() hook + an ensure-loaded lazy fetch that single-flights the
// first call. YAML builders hand-emit (no js-yaml dep) so the modal can
// pre-fill the textarea when the user flips to YAML mode and so that a
// form-mode submit goes through the same code path as a YAML submit.

import { createStore, useStore } from './store';
import { apiEnabled } from '@/api/client';
import { listCluster, deleteCluster } from '@/api/k8sres';
import {
  fetchLocalModelStatus,
  fetchLocalModelOptions,
  type LocalModelStatus,
  type LocalModelOptions,
  type LocalModelNodeGroup,
  type LocalModelCache,
} from '@/api/localModelCache';

const nodeGroupsStore = createStore<LocalModelNodeGroup[]>([]);
const cachesStore = createStore<LocalModelCache[]>([]);
const statusStore = createStore<LocalModelStatus>({ installed: false });
const optionsStore = createStore<LocalModelOptions>({ nodeLabelKeys: [], storageClasses: [] });

export const useLocalModelNodeGroups = () => useStore(nodeGroupsStore);
export const useLocalModelCaches = () => useStore(cachesStore);
export const useLocalModelStatus = () => useStore(statusStore);
export const useLocalModelOptions = () => useStore(optionsStore);

let loaded = false;
let loading: Promise<void> | null = null;

export function ensureLocalModelLoaded(): Promise<void> {
  if (!apiEnabled) return Promise.resolve();
  if (loaded && loading == null) return Promise.resolve();
  if (loading) return loading;
  loading = Promise.all([
    fetchLocalModelStatus().catch(() => ({ installed: false }) as LocalModelStatus),
    listCluster<LocalModelNodeGroup>('localmodelnodegroups').catch(() => []),
    listCluster<LocalModelCache>('localmodelcaches').catch(() => []),
    fetchLocalModelOptions().catch(() => ({ nodeLabelKeys: [], storageClasses: [] }) as LocalModelOptions),
  ])
    .then(([status, groups, caches, options]) => {
      statusStore.set(() => status);
      nodeGroupsStore.set(() => groups);
      cachesStore.set(() => caches);
      optionsStore.set(() => options);
      loaded = true;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function reloadLocalModel(): Promise<void> {
  loaded = false;
  return ensureLocalModelLoaded();
}

export async function deleteLocalModelNodeGroup(name: string): Promise<void> {
  if (apiEnabled) {
    await deleteCluster('localmodelnodegroups', name);
  }
  nodeGroupsStore.set(prev => prev.filter(g => g.name !== name));
}

export async function deleteLocalModelCache(name: string): Promise<void> {
  if (apiEnabled) {
    await deleteCluster('localmodelcaches', name);
  }
  cachesStore.set(prev => prev.filter(c => c.name !== name));
}

// yamlQuote wraps a string in double quotes only when it contains a YAML
// special character. Plain identifiers (model names, paths without colons)
// pass through unquoted so the manifest stays readable.
function yamlQuote(s: string): string {
  if (s === '') return '""';
  if (/[:#@`{}[\]&*!,?>|%\s'"]/.test(s) || /^-/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

export interface NodeGroupFormPayload {
  name: string;
  storageLimit: string;
  capacity: string;
  storageClassName: string;
  localPath: string;
  selectorKey: string;
  selectorValues: string[];
}

export interface CacheFormPayload {
  name: string;
  sourceModelUri: string;
  modelSize: string;
  nodeGroups: string[];
}

// buildNodeGroupYaml hand-emits a minimal-but-complete LocalModelNodeGroup.
// PV access modes / volume mode are hardcoded to the values KServe's docs
// use (ReadWriteOnce, Filesystem); admins who need anything else flip the
// modal to YAML mode.
export function buildNodeGroupYaml(p: NodeGroupFormPayload): string {
  const capacity = p.capacity || p.storageLimit;
  const valuesYaml = p.selectorValues.length
    ? p.selectorValues.map(v => `                  - ${yamlQuote(v)}`).join('\n')
    : `                  - ""`;
  return `apiVersion: serving.kserve.io/v1alpha1
kind: LocalModelNodeGroup
metadata:
  name: ${yamlQuote(p.name)}
spec:
  storageLimit: ${yamlQuote(p.storageLimit)}
  persistentVolumeClaimSpec:
    accessModes:
      - ReadWriteOnce
    resources:
      requests:
        storage: ${yamlQuote(capacity)}
    storageClassName: ${yamlQuote(p.storageClassName)}
    volumeMode: Filesystem
  persistentVolumeSpec:
    accessModes:
      - ReadWriteOnce
    volumeMode: Filesystem
    capacity:
      storage: ${yamlQuote(capacity)}
    local:
      path: ${yamlQuote(p.localPath)}
    storageClassName: ${yamlQuote(p.storageClassName)}
    nodeAffinity:
      required:
        nodeSelectorTerms:
          - matchExpressions:
              - key: ${yamlQuote(p.selectorKey || 'kubernetes.io/hostname')}
                operator: In
                values:
${valuesYaml}
`;
}

export function buildCacheYaml(p: CacheFormPayload): string {
  const groupsYaml = p.nodeGroups.length
    ? p.nodeGroups.map(n => `    - ${yamlQuote(n)}`).join('\n')
    : `    - ""`;
  return `apiVersion: serving.kserve.io/v1alpha1
kind: LocalModelCache
metadata:
  name: ${yamlQuote(p.name)}
spec:
  sourceModelUri: ${yamlQuote(p.sourceModelUri)}
  modelSize: ${yamlQuote(p.modelSize)}
  nodeGroups:
${groupsYaml}
`;
}
