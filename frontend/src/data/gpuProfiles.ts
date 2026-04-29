import { createStore, useStore, uid } from './store';

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

export function addGPUProfile(p: Omit<GPUProfile, 'id' | 'builtin'>) {
  gpuProfilesStore.set(prev => [...prev, { ...p, id: uid('gpu'), builtin: false }]);
}

export function removeGPUProfile(id: string) {
  gpuProfilesStore.set(prev => prev.filter(p => p.id !== id));
}
