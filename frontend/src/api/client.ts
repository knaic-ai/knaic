// Thin fetch wrapper for the knaic-backend HTTP API.
//
// Resolution order for the base URL:
//   1. import.meta.env.VITE_KNAIC_API  (e.g. "http://localhost:8080")
//   2. window.__KNAIC_API__            (runtime override)
//   3. ""                              (same-origin /api/v1; Vite proxies
//      /api to the backend in local development)
//
// API mode is enabled by default so production same-origin deployments do not
// accidentally bypass OIDC. Set VITE_KNAIC_API=disabled for prototype-only UI.
//
// Independent of API mode, VITE_KNAIC_SYNTHETIC=1 forces the LLM / TrainJob
// monitoring pages and the Model Hub storage-target picker to use the local
// in-browser synthetic generators instead of calling the backend. Useful for
// pure-frontend prototyping when the backend is reachable but you don't want
// the dashboards to hammer Prometheus or you want a deterministic shape.
// Defaults to off, so production builds always go through the backend.

declare global {
  interface Window {
    __KNAIC_API__?: string;
    __KNAIC_SYNTHETIC__?: string | boolean;
  }
}

const rawEnvBase: string | undefined = import.meta.env.VITE_KNAIC_API as string | undefined;
const rawWinBase: string | undefined = typeof window !== 'undefined' ? window.__KNAIC_API__ : undefined;
const apiDisabled = rawEnvBase === 'disabled' || rawWinBase === 'disabled';
const envBase = apiDisabled ? undefined : rawEnvBase;
const winBase = apiDisabled ? undefined : rawWinBase;

export const apiBaseUrl: string = (envBase ?? winBase ?? '').replace(/\/+$/, '');

export const apiEnabled: boolean = !apiDisabled;

const rawEnvSynthetic = import.meta.env.VITE_KNAIC_SYNTHETIC as string | undefined;
const rawWinSynthetic =
  typeof window !== 'undefined' ? window.__KNAIC_SYNTHETIC__ : undefined;
const truthy = (v: string | boolean | undefined) =>
  v === true || v === '1' || v === 'true' || v === 'on';

// syntheticMode is a separate axis from apiEnabled: a frontend can be in API
// mode (apiEnabled=true) but still render the monitoring/storage views from
// local synthetic data when this flag is on. When apiEnabled is false the
// flag is implicit — there's no backend to call regardless.
export const syntheticMode: boolean =
  !apiEnabled || truthy(rawEnvSynthetic) || truthy(rawWinSynthetic);

let bearerToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setBearerToken(token: string | null) {
  bearerToken = token;
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  skipUnauthorizedHandler?: boolean;
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return headers;
}

export function fetchWithAuth(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = authHeaders(init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined);
  return fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
    credentials: init.credentials ?? 'include',
  }).then(res => {
    if (res.status === 401) unauthorizedHandler?.();
    return res;
  });
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${apiBaseUrl}${path}`;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: authHeaders(headers),
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
    if (res.status === 401 && !opts.skipUnauthorizedHandler) unauthorizedHandler?.();
    const msg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, parsed);
  }
  return parsed as T;
}

export async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  const res = await fetchWithAuth(path, init);
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, await res.text());
  return res.text();
}
