import { createStore, useStore, uid } from './store';

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
