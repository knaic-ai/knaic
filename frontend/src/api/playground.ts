import { fetchWithAuth, request } from './client';
import type { LLMProvider } from '@/data/playground';

export interface PlaygroundMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  owner: string;
  namespace?: string;
  providerId: string;
  title: string;
  skills: string[];
  createdAt: string;
  updatedAt: string;
  messages?: AgentMessage[];
}

export interface AgentEvent {
  kind: 'thought' | 'action' | 'observation' | 'final' | 'error';
  text: string;
  messageId?: string;
  toolName?: string;
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

export function listAgentSessions(namespace?: string): Promise<AgentSession[]> {
  const qs = namespace ? `?${new URLSearchParams({ namespace })}` : '';
  return request<AgentSession[]>(`/api/v1/playground/agent/sessions${qs}`);
}

export function createAgentSession(req: {
  namespace?: string;
  providerId: string;
  title?: string;
  skills?: string[];
}): Promise<AgentSession> {
  return request<AgentSession>('/api/v1/playground/agent/sessions', { method: 'POST', body: req });
}

export function getAgentSession(id: string): Promise<AgentSession> {
  return request<AgentSession>(`/api/v1/playground/agent/sessions/${encodeURIComponent(id)}`);
}

export function deleteAgentSession(id: string): Promise<void> {
  return request<void>(`/api/v1/playground/agent/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function streamAgentSession(
  id: string,
  req: { message: string; namespace?: string },
  opts: {
    signal?: AbortSignal;
    onEvent: (event: AgentEvent) => void;
    onDone: () => void;
  },
): Promise<void> {
  const qs = req.namespace ? `?${new URLSearchParams({ namespace: req.namespace })}` : '';
  const res = await fetchWithAuth(`/api/v1/playground/agent/sessions/${encodeURIComponent(id)}/run${qs}`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message: req.message }),
  });
  if (!res.ok || !res.body) throw new Error(`agent HTTP ${res.status}`);

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
      const data = frame
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))
        .join('\n')
        .trim();
      if (!data) continue;
      try {
        opts.onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        opts.onEvent({ kind: 'final', text: data });
      }
    }
  }
  opts.onDone();
}
