import { createStore, useStore, uid } from './store';
import { apiEnabled } from '@/api/client';
import * as api from '@/api/gpu';

export interface GPUProfile {
  id: string;
  name: string;
  kind: 'hami' | 'nvidia' | 'npu' | 'custom';
  description: string;
  fields: {
    key: string;
    label: string;
    unit?: string;
    defaultValue: string | number;
    step?: number;
    min?: number;
    max?: number;
  }[];
  builtin: boolean;
}

// Local fallback list — used in prototype mode (no backend) and as the
// initial render before /api/v1/gpu/profiles resolves. Keeps the picker
// usable on a fresh page load.
const initial: GPUProfile[] = [
  {
    id: uid('gpu'),
    name: 'HAMi (shared GPU)',
    kind: 'hami',
    description: 'Partial GPU share via HAMi scheduler.',
    fields: [
      { key: 'nvidia.com/gpualloc', label: 'GPUs', defaultValue: 1, min: 0, step: 1 },
      { key: 'nvidia.com/gpucores', label: 'GPU cores (%)', defaultValue: 25, min: 1, max: 100, step: 5 },
      { key: 'nvidia.com/gpumem', label: 'GPU memory', unit: 'MiB', defaultValue: 8192, min: 512, step: 512 },
    ],
    builtin: true,
  },
  {
    id: uid('gpu'),
    name: 'NVIDIA GPU (whole)',
    kind: 'nvidia',
    description: 'Request one or more full NVIDIA GPUs.',
    fields: [{ key: 'nvidia.com/gpu', label: 'GPUs', defaultValue: 1, min: 0, step: 1 }],
    builtin: true,
  },
  {
    id: uid('gpu'),
    name: 'Huawei Ascend 910B (NPU)',
    kind: 'npu',
    description: 'Ascend NPU allocation via huawei.com/Ascend910B.',
    fields: [{ key: 'huawei.com/Ascend910B', label: 'NPUs', defaultValue: 1, min: 0, step: 1 }],
    builtin: true,
  },
];

export const gpuProfilesStore = createStore<GPUProfile[]>(initial);
export const useGPUProfiles = () => useStore(gpuProfilesStore);

let loaded = false;

function fromDTO(p: api.GPUProfileDTO): GPUProfile {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    description: p.description ?? '',
    fields: p.fields ?? [],
    builtin: !!p.builtin,
  };
}

export function ensureGPUProfilesLoaded() {
  if (!apiEnabled || loaded) return;
  loaded = true;
  api.listGPUProfiles()
    .then(items => gpuProfilesStore.set(items.map(fromDTO)))
    .catch(() => {
      // Fail-soft: keep the local fallback list and let the next call retry.
      loaded = false;
    });
}

export function reloadGPUProfiles() {
  loaded = false;
  ensureGPUProfilesLoaded();
}

// Mutators round-trip through the API in API mode; fall back to in-memory
// edits in prototype mode so the page stays functional offline.

export async function addGPUProfile(p: Omit<GPUProfile, 'id' | 'builtin'>): Promise<void> {
  if (apiEnabled) {
    const created = await api.createGPUProfile({
      name: p.name,
      kind: p.kind,
      description: p.description,
      fields: p.fields,
    });
    gpuProfilesStore.set(prev => [...prev, fromDTO(created)]);
    return;
  }
  gpuProfilesStore.set(prev => [...prev, { ...p, id: uid('gpu'), builtin: false }]);
}

export async function updateGPUProfile(id: string, p: Omit<GPUProfile, 'id' | 'builtin'>): Promise<void> {
  if (apiEnabled) {
    const updated = await api.updateGPUProfile(id, {
      name: p.name,
      kind: p.kind,
      description: p.description,
      fields: p.fields,
    });
    gpuProfilesStore.set(prev => prev.map(x => (x.id === id ? fromDTO(updated) : x)));
    return;
  }
  gpuProfilesStore.set(prev => prev.map(x => (x.id === id ? { ...p, id, builtin: false } : x)));
}

export async function removeGPUProfile(id: string): Promise<void> {
  if (apiEnabled) {
    await api.deleteGPUProfile(id);
  }
  gpuProfilesStore.set(prev => prev.filter(p => p.id !== id));
}
