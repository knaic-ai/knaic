// Typed bindings for /api/v1/namespaces/{ns}/{slug} dispatcher.
//
// The shape of each Projection mirrors the corresponding Go projector in
// knaic-backend/internal/k8sres/projections.go. Add a new entry here when
// you register a new Kind on the backend.

import { request, apiEnabled, requestText, fetchWithAuth } from './client';

export type Slug =
  | 'deployments'
  | 'statefulsets'
  | 'pods'
  | 'services'
  | 'configmaps'
  | 'secrets'
  | 'pvcs'
  | 'gateways'
  | 'httproutes'
  | 'inferenceservices'
  | 'llminferenceservices'
  | 'servingruntimes'
  | 'notebooks'
  | 'trainjobs'
  | 'trainingruntimes';

export type ClusterSlug = 'gatewayclasses' | 'clusterservingruntimes' | 'clustertrainingruntimes';

export function listNamespaced<T>(slug: Slug, ns: string, signal?: AbortSignal): Promise<T[]> {
  return request<T[]>(`/api/v1/namespaces/${encodeURIComponent(ns)}/${slug}`, { signal });
}

export function getNamespaced<T>(slug: Slug, ns: string, name: string): Promise<T> {
  return request<T>(`/api/v1/namespaces/${encodeURIComponent(ns)}/${slug}/${encodeURIComponent(name)}`);
}

export async function fetchYaml(slug: Slug | ClusterSlug, ns: string | null, name: string): Promise<string> {
  return requestText(ns
    ? `/api/v1/namespaces/${encodeURIComponent(ns)}/${slug}/${encodeURIComponent(name)}/yaml`
    : `/api/v1/cluster/${slug}/${encodeURIComponent(name)}/yaml`);
}

export function createNamespaced<T>(slug: Slug, ns: string, obj: unknown): Promise<T> {
  return request<T>(`/api/v1/namespaces/${encodeURIComponent(ns)}/${slug}`, {
    method: 'POST',
    body: obj,
  });
}

export function updateNamespaced<T>(slug: Slug, ns: string, name: string, obj: unknown): Promise<T> {
  return request<T>(`/api/v1/namespaces/${encodeURIComponent(ns)}/${slug}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: obj,
  });
}

export function deleteNamespaced(slug: Slug, ns: string, name: string): Promise<void> {
  return request<void>(
    `/api/v1/namespaces/${encodeURIComponent(ns)}/${slug}/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}

export function listCluster<T>(slug: ClusterSlug): Promise<T[]> {
  return request<T[]>(`/api/v1/cluster/${slug}`);
}

export function createCluster<T>(slug: ClusterSlug, obj: unknown): Promise<T> {
  return request<T>(`/api/v1/cluster/${slug}`, { method: 'POST', body: obj });
}

export function deleteCluster(slug: ClusterSlug, name: string): Promise<void> {
  return request<void>(`/api/v1/cluster/${slug}/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ---- Pod log streaming --------------------------------------------------
//
// The backend serves pod logs as Server-Sent Events. Each `data:` frame
// carries one log line. We use a fetch-stream rather than EventSource so
// we can pass the bearer token in an Authorization header.

export interface LogStreamOptions {
  container?: string;
  follow?: boolean;
  tailLines?: number;
  previous?: boolean;
  signal?: AbortSignal;
  onLine: (line: string) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

export async function streamPodLogs(ns: string, name: string, opts: LogStreamOptions): Promise<void> {
  if (!apiEnabled) {
    opts.onError?.(new Error('API not configured — cannot stream logs'));
    return;
  }
  const params = new URLSearchParams();
  if (opts.container) params.set('container', opts.container);
  if (opts.follow) params.set('follow', 'true');
  if (opts.tailLines !== undefined) params.set('tailLines', String(opts.tailLines));
  if (opts.previous) params.set('previous', 'true');
  try {
    const res = await fetchWithAuth(
      `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}/logs?${params}`,
      {
        headers: { Accept: 'text/event-stream' },
        signal: opts.signal,
      },
    );
    if (!res.ok || !res.body) {
      throw new Error(`logs HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are terminated by `\n\n`.
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            opts.onLine(line.slice(6));
          } else if (line.startsWith('event: end')) {
            opts.onEnd?.();
            return;
          }
        }
      }
    }
    opts.onEnd?.();
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    opts.onError?.(e as Error);
  }
}
