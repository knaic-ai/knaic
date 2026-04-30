import { fetchWithAuth, request } from './client';
import type { LLMProvider } from '@/data/playground';

export interface PlaygroundMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export function listProviders(namespace?: string): Promise<LLMProvider[]> {
  const qs = namespace ? `?${new URLSearchParams({ namespace })}` : '';
  return request<LLMProvider[]>(`/api/v1/playground/providers${qs}`);
}

export function createProvider(req: Omit<LLMProvider, 'id'> & { id?: string }): Promise<LLMProvider> {
  return request<LLMProvider>('/api/v1/playground/providers', { method: 'POST', body: req });
}

export function patchProvider(id: string, patch: Partial<LLMProvider>): Promise<LLMProvider> {
  return request<LLMProvider>(`/api/v1/playground/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function deleteProvider(id: string): Promise<void> {
  return request<void>(`/api/v1/playground/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface ChatStreamRequest {
  providerId: string;
  messages: PlaygroundMessage[];
  temperature?: number;
  maxTokens?: number;
}

export async function streamChat(
  req: ChatStreamRequest,
  opts: {
    signal?: AbortSignal;
    onChunk: (chunk: string) => void;
    onDone: () => void;
  },
): Promise<void> {
  const res = await fetchWithAuth('/api/v1/playground/chat/stream', {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(req),
  });
  if (!res.ok || !res.body) throw new Error(`chat HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as {
            choices?: { delta?: { content?: string }; message?: { content?: string } }[];
          };
          const chunk = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
          if (chunk) opts.onChunk(chunk);
        } catch {
          opts.onChunk(data);
        }
      }
    }
  }
  opts.onDone();
}
