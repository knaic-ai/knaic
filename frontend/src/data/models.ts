import { createStore, useStore, uid } from './store';

export type ModelScope = 'public' | 'private';
export type ModelScheme = 'hf' | 'modelscope' | 's3' | 'oci';

export interface ModelItem {
  id: string;
  name: string;
  owner: string;
  scope: ModelScope;
  namespace?: string;
  uri: string;
  scheme: ModelScheme;
  tags: string[];
  modelType: string;
  sizeGB: number;
  downloads: number;
  createdAt: string;
  updatedAt: string;
  readme: string;
}

const now = () => new Date().toISOString().slice(0, 10);

const initial: ModelItem[] = [
  {
    id: uid('m'),
    name: 'Qwen/Qwen3.5-7B-Instruct',
    owner: 'Qwen',
    scope: 'public',
    uri: 'hf://Qwen/Qwen3.5-7B-Instruct',
    scheme: 'hf',
    tags: ['chat', 'instruct', 'text-generation'],
    modelType: 'llm',
    sizeGB: 15.2,
    downloads: 4219,
    createdAt: now(),
    updatedAt: now(),
    readme: `# Qwen3.5 7B Instruct

Qwen3.5 is the next-generation Qwen model series. The 7B instruct variant is tuned for
conversational and tool-use scenarios.

## Quick start
\`\`\`bash
vllm serve Qwen/Qwen3.5-7B-Instruct --max-model-len 32768
\`\`\`

## License
Apache-2.0`,
  },
  {
    id: uid('m'),
    name: 'Qwen/Qwen3.5-72B-Instruct',
    owner: 'Qwen',
    scope: 'public',
    uri: 'hf://Qwen/Qwen3.5-72B-Instruct',
    scheme: 'hf',
    tags: ['chat', 'instruct', 'flagship'],
    modelType: 'llm',
    sizeGB: 146.0,
    downloads: 812,
    createdAt: now(),
    updatedAt: now(),
    readme: '# Qwen3.5 72B Instruct\n\nFlagship instruct model. Requires multi-GPU deployment.',
  },
  {
    id: uid('m'),
    name: 'meta-llama/Llama-3.3-8B-Instruct',
    owner: 'meta-llama',
    scope: 'public',
    uri: 'hf://meta-llama/Llama-3.3-8B-Instruct',
    scheme: 'hf',
    tags: ['chat', 'instruct'],
    modelType: 'llm',
    sizeGB: 16.8,
    downloads: 3120,
    createdAt: now(),
    updatedAt: now(),
    readme: '# Llama 3.3 8B Instruct',
  },
  {
    id: uid('m'),
    name: 'BAAI/bge-large-en-v1.5',
    owner: 'BAAI',
    scope: 'public',
    uri: 'hf://BAAI/bge-large-en-v1.5',
    scheme: 'hf',
    tags: ['embedding', 'retrieval'],
    modelType: 'embedding',
    sizeGB: 1.3,
    downloads: 980,
    createdAt: now(),
    updatedAt: now(),
    readme: '# BGE Large EN v1.5\n\nGeneral-purpose English embedding model.',
  },
  {
    id: uid('m'),
    name: 'stabilityai/stable-diffusion-3-medium',
    owner: 'stabilityai',
    scope: 'public',
    uri: 'hf://stabilityai/stable-diffusion-3-medium',
    scheme: 'hf',
    tags: ['image', 'diffusion'],
    modelType: 'diffusion',
    sizeGB: 14.0,
    downloads: 1022,
    createdAt: now(),
    updatedAt: now(),
    readme: '# Stable Diffusion 3 Medium',
  },
  {
    id: uid('m'),
    name: 'team-ml/finetuned-qwen-helpdesk',
    owner: 'alice',
    scope: 'private',
    namespace: 'team-ml',
    uri: 's3://knaic-models/team-ml/finetuned-qwen-helpdesk/',
    scheme: 's3',
    tags: ['internal', 'helpdesk', 'lora'],
    modelType: 'llm',
    sizeGB: 0.25,
    downloads: 12,
    createdAt: now(),
    updatedAt: now(),
    readme: '# Helpdesk LoRA adapter\n\nLoRA rank-64 adapter fine-tuned on internal helpdesk tickets.',
  },
  {
    id: uid('m'),
    name: 'team-ml/triage-classifier',
    owner: 'bob',
    scope: 'private',
    namespace: 'team-ml',
    uri: 'oci://registry.knaic.local/team-ml/triage-classifier:v3',
    scheme: 'oci',
    tags: ['classifier', 'triage'],
    modelType: 'classifier',
    sizeGB: 0.4,
    downloads: 5,
    createdAt: now(),
    updatedAt: now(),
    readme: '# Triage classifier\n\nDistilBERT-based classifier trained on 120k tickets.',
  },
];

export const modelsStore = createStore<ModelItem[]>(initial);
export const useModels = () => useStore(modelsStore);

import { apiEnabled } from '@/api/client';
import * as api from '@/api/models';

const loaded = new Set<string>();

function fillModelDefaults(m: ModelItem): ModelItem {
  return {
    ...m,
    tags: m.tags ?? [],
    downloads: m.downloads ?? 0,
    sizeGB: m.sizeGB ?? 0,
    createdAt: m.createdAt ?? m.updatedAt ?? now(),
    updatedAt: m.updatedAt ?? m.createdAt ?? now(),
    readme: m.readme ?? '',
  };
}

export function ensureModelsLoaded(scope: ModelScope, namespace?: string) {
  if (!apiEnabled) return;
  const k = `${scope}:${namespace ?? ''}`;
  if (loaded.has(k)) return;
  loaded.add(k);
  api.listModels(scope, namespace)
    .then(items => {
      modelsStore.set(prev => {
        // Drop the old entries from this scope+ns slot, keep everything else
        // (so the prototype seeds for other namespaces don't disappear).
        const purged = prev.filter(m => {
          if (m.scope !== scope) return true;
          if (scope === 'private' && m.namespace !== namespace) return true;
          return false;
        });
        return [...items.map(fillModelDefaults), ...purged];
      });
    })
    .catch(() => loaded.delete(k));
}

export function reloadModels(scope: ModelScope, namespace?: string) {
  loaded.delete(`${scope}:${namespace ?? ''}`);
  ensureModelsLoaded(scope, namespace);
}

export async function addModel(m: Omit<ModelItem, 'id' | 'createdAt' | 'updatedAt' | 'downloads'>): Promise<ModelItem> {
  if (apiEnabled) {
    const created = await api.createModel({
      name: m.name,
      owner: m.owner,
      scope: m.scope,
      namespace: m.namespace,
      uri: m.uri,
      tags: m.tags,
      modelType: m.modelType,
      sizeGB: m.sizeGB,
      readme: m.readme,
    });
    const filled = fillModelDefaults(created);
    modelsStore.set(prev => [filled, ...prev]);
    return filled;
  }
  const createdAt = now();
  const item: ModelItem = { ...m, id: uid('m'), createdAt, updatedAt: createdAt, downloads: 0 };
  modelsStore.set(prev => [item, ...prev]);
  return item;
}

export async function importModelFromURL(url: string, scope: ModelScope, namespace?: string): Promise<ModelItem> {
  if (apiEnabled) {
    const created = await api.importModel({ url, scope, namespace });
    const filled = fillModelDefaults(created);
    modelsStore.set(prev => [filled, ...prev]);
    return filled;
  }
  // Prototype fallback — match the backend's parsing.
  const trimmed = url.replace(/\/$/, '');
  let uri = '';
  let name = '';
  if (trimmed.startsWith('https://huggingface.co/')) {
    name = trimmed.replace('https://huggingface.co/', '');
    uri = `hf://${name}`;
  } else if (trimmed.startsWith('https://www.modelscope.cn/')) {
    name = trimmed.replace('https://www.modelscope.cn/models/', '').replace('https://www.modelscope.cn/', '');
    uri = `modelscope://${name}`;
  } else {
    throw new Error('URL must be from huggingface.co or modelscope.cn');
  }
  return addModel({
    name,
    owner: name.split('/')[0] ?? '',
    scope,
    namespace: scope === 'private' ? namespace : undefined,
    uri,
    scheme: uri.startsWith('hf://') ? 'hf' : 'modelscope',
    tags: ['imported'],
    modelType: 'llm',
    sizeGB: 0,
    readme: `# ${name}\n\nImported from ${url}.`,
  });
}

export async function uploadModelMeta(req: api.UploadModelRequest): Promise<ModelItem> {
  if (apiEnabled) {
    const created = await api.uploadModel(req);
    const filled = fillModelDefaults(created);
    modelsStore.set(prev => [filled, ...prev]);
    return filled;
  }
  const scheme = parseUri(req.targetUri) ?? 's3';
  return addModel({
    name: req.name,
    owner: '',
    scope: req.scope,
    namespace: req.scope === 'private' ? req.namespace : undefined,
    uri: req.targetUri,
    scheme,
    tags: [...(req.tags ?? []), 'uploaded'],
    modelType: req.modelType ?? 'llm',
    sizeGB: req.sizeGB ?? 0,
    readme: req.readme ?? `# ${req.name}\n\nUploaded to ${req.targetUri}.`,
  });
}

export async function updateModel(id: string, patch: Partial<ModelItem>): Promise<void> {
  if (apiEnabled) {
    const apiPatch: { readme?: string; tags?: string[]; incDownloads?: number } = {};
    if (patch.readme !== undefined) apiPatch.readme = patch.readme;
    if (patch.tags !== undefined) apiPatch.tags = patch.tags;
    if (patch.downloads !== undefined) {
      const current = modelsStore.get().find(m => m.id === id);
      if (current) apiPatch.incDownloads = patch.downloads - current.downloads;
    }
    if (Object.keys(apiPatch).length === 0) return;
    const updated = await api.patchModel(id, apiPatch);
    modelsStore.set(prev => prev.map(m => (m.id === id ? fillModelDefaults(updated) : m)));
    return;
  }
  modelsStore.set(prev => prev.map(m => (m.id === id ? { ...m, ...patch, updatedAt: now() } : m)));
}

export async function deleteModel(id: string): Promise<void> {
  if (apiEnabled) {
    await api.deleteModel(id);
    modelsStore.set(prev => prev.filter(m => m.id !== id));
    return;
  }
  modelsStore.set(prev => prev.filter(m => m.id !== id));
}

export function parseUri(uri: string): ModelScheme | null {
  const m = uri.match(/^(hf|modelscope|s3|oci):\/\//);
  return (m?.[1] as ModelScheme) ?? null;
}
