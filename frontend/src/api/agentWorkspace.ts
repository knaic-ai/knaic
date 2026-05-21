// Typed bindings for the per-user Codex Web workspace endpoints under
// /api/v1/me/workspace/*. The shape mirrors what the backend returns and what
// the AgentWorkspace page's polling hook consumes.

import { ApiError, apiBaseUrl, request } from './client';

export type WorkspaceStatus = 'Running' | 'Starting' | 'Stopped' | string;

export interface AgentWorkspace {
  name: string;
  namespace: string;
  ownerId: string;
  status: WorkspaceStatus;
  image: string;
  storage: string;
  route: string;
  createdAt: string;
}

export interface ResourceUpdate {
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  storage?: string;
}

// getOrCreateUserWorkspace returns the caller's workspace, asking the backend
// to provision it on first visit. The frontend never shows a "create wizard"
// — the menu entry just opens whatever workspace the caller owns.
export async function getOrCreateUserWorkspace(): Promise<AgentWorkspace> {
  try {
    return await request<AgentWorkspace>('/api/v1/me/workspace');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return request<AgentWorkspace>('/api/v1/me/workspace', { method: 'POST' });
    }
    throw err;
  }
}

export function getUserWorkspace(): Promise<AgentWorkspace> {
  return request<AgentWorkspace>('/api/v1/me/workspace');
}

export function restartWorkspace(): Promise<AgentWorkspace> {
  return request<AgentWorkspace>('/api/v1/me/workspace/restart', { method: 'POST' });
}

export function updateWorkspaceResources(spec: ResourceUpdate): Promise<AgentWorkspace> {
  return request<AgentWorkspace>('/api/v1/me/workspace/resources', {
    method: 'PATCH',
    body: spec,
  });
}

export function deleteWorkspace(): Promise<void> {
  return request<void>('/api/v1/me/workspace', { method: 'DELETE' });
}

// grantWorkspaceProxy trades the user's bearer for a path-scoped HttpOnly
// cookie the iframe can carry. `<iframe src=...>` requests don't send our
// Authorization header, so without this the iframe's first request would
// hit the proxy with no auth and get 401. Call once before rendering the
// iframe (and re-call before `expiresAt` to keep it alive).
export interface WorkspaceGrantDTO {
  proxyPath: string;
  expiresAt: string;
}
export function grantWorkspaceProxy(): Promise<WorkspaceGrantDTO> {
  return request<WorkspaceGrantDTO>('/api/v1/me/workspace/grant', { method: 'POST' });
}

// proxyURL returns the absolute URL to drop into an iframe src. Same-origin
// in production; uses VITE_KNAIC_API when the frontend is configured to talk
// to a separate backend host.
export function proxyURL(): string {
  return `${apiBaseUrl}/api/v1/me/workspace/proxy/`;
}
