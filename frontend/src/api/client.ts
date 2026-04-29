// Thin fetch wrapper for the knaic-backend HTTP API.
//
// Resolution order for the base URL:
//   1. import.meta.env.VITE_KNAIC_API  (e.g. "http://localhost:8080")
//   2. window.__KNAIC_API__            (set by index.html when served by the
//      backend itself in production)
//   3. ""                              (use same-origin /api/v1, with the
//      vite dev proxy forwarding to the backend on :8080)
//
// When `apiEnabled` is false (no backend reachable) callers should fall back
// to the in-memory prototype data. Each data store decides this for itself.

declare global {
  interface Window {
    __KNAIC_API__?: string;
  }
}

const envBase: string | undefined = import.meta.env.VITE_KNAIC_API as string | undefined;
const winBase: string | undefined = typeof window !== 'undefined' ? window.__KNAIC_API__ : undefined;

export const apiBaseUrl: string = (envBase ?? winBase ?? '').replace(/\/+$/, '');

// In dev, the vite proxy in vite.config.ts forwards /api/v1 → :8080 even
// when VITE_KNAIC_API is unset, so we still consider the API "enabled".
export const apiEnabled: boolean =
  import.meta.env.DEV || !!envBase || !!winBase;

let bearerToken: string | null = null;

export function setBearerToken(token: string | null) {
  bearerToken = token;
}

export class ApiError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${apiBaseUrl}${path}`;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    credentials: 'include',
  });

  if (res.status === 204) return undefined as T;

  let parsed: unknown;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, parsed);
  }
  return parsed as T;
}
