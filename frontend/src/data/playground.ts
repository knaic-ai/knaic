import { createStore, useStore, uid } from './store';
import { apiEnabled } from '@/api/client';
import * as api from '@/api/playground';

export interface LLMProvider {
  id: string;
  name: string;
  source: 'cluster' | 'external';
  namespace?: string;
  endpoint: string;
  apiKey?: string;
  model: string;
  description?: string;
  status: 'Ready' | 'Progressing' | 'Failed';
}

const initial: LLMProvider[] = [
  {
    id: uid('llm'),
    name: 'qwen3-5-7b (cluster)',
    source: 'cluster',
    namespace: 'team-ml',
    endpoint: 'http://qwen3-5-7b.team-ml.svc.cluster.local/v1',
    model: 'Qwen/Qwen3.5-7B-Instruct',
    description: 'In-cluster vLLM deployment of Qwen3.5 7B',
    status: 'Ready',
  },
  {
    id: uid('llm'),
    name: 'qwen-72b-lws (cluster)',
    source: 'cluster',
    namespace: 'team-llm',
    endpoint: 'http://qwen-72b-lws.team-llm.svc.cluster.local/v1',
    model: 'Qwen/Qwen3.5-72B-Instruct',
    description: 'Multi-GPU Qwen3.5 72B served via LeaderWorkerSet',
    status: 'Progressing',
  },
  {
    id: uid('llm'),
    name: 'openai-gpt-4o',
    source: 'external',
    endpoint: 'https://api.openai.com/v1',
    apiKey: 'sk-…',
    model: 'gpt-4o',
    description: 'External OpenAI GPT-4o',
    status: 'Ready',
  },
];

export const providersStore = createStore<LLMProvider[]>(initial);
export const useProviders = () => useStore(providersStore);

let loadedKey: string | null = null;

export function ensureProvidersLoaded(namespace?: string): void {
  if (!apiEnabled) return;
  const key = namespace ?? '';
  if (loadedKey === key) return;
  loadedKey = key;
  api.listProviders(namespace)
    .then(providers => providersStore.set(providers))
    .catch(() => {
      loadedKey = null;
    });
}

export function reloadProviders(namespace?: string): void {
  loadedKey = null;
  ensureProvidersLoaded(namespace);
}

export async function addProvider(req: Omit<LLMProvider, 'id'>): Promise<void> {
  if (apiEnabled) {
    const created = await api.createProvider(req);
    providersStore.set(prev => [created, ...prev.filter(p => p.id !== created.id)]);
    return;
  }
  providersStore.set(prev => [{ id: uid('llm'), ...req }, ...prev]);
}

export async function removeProvider(id: string): Promise<void> {
  if (apiEnabled) await api.deleteProvider(id);
  providersStore.set(prev => prev.filter(p => p.id !== id));
}

export async function replaceClusterProviders(providers: Omit<LLMProvider, 'id'>[], namespace?: string): Promise<void> {
  if (apiEnabled) {
    const current = providersStore.get().filter(p => p.source === 'cluster' && (!namespace || p.namespace === namespace));
    await Promise.all(current.map(p => api.deleteProvider(p.id).catch(() => undefined)));
    const created = await Promise.all(providers.map(p => api.createProvider(p)));
    providersStore.set(prev => [
      ...created,
      ...prev.filter(p => !(p.source === 'cluster' && (!namespace || p.namespace === namespace))),
    ]);
    return;
  }
  providersStore.set(prev => [
    ...providers.map(p => ({ id: uid('llm'), ...p })),
    ...prev.filter(p => !(p.source === 'cluster' && (!namespace || p.namespace === namespace))),
  ]);
}
