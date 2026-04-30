import { request } from './client';
import type { NodeInfo, Taint } from '@/data/nodes';
import type { UserRecord, Role, RoleBinding } from '@/data/users';
import type { NamespaceRole } from '@/context/AppContext';

export interface Quota {
  cpu: number;
  memory: number;
  gpu: number;
  pods: number;
}

export interface NamespaceInfo {
  name: string;
  status: string;
  labels?: Record<string, string>;
  quota: Quota;
}

export function listUsers(): Promise<UserRecord[]> {
  return request<UserRecord[]>('/api/v1/admin/users');
}

export function patchUser(
  id: string,
  patch: { isPlatformAdmin?: boolean; memberships?: Record<string, NamespaceRole> },
): Promise<UserRecord> {
  return request<UserRecord>(`/api/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function listNodes(): Promise<NodeInfo[]> {
  return request<NodeInfo[]>('/api/v1/admin/nodes');
}

export function patchNode(
  name: string,
  patch: { labels?: Record<string, string>; taints?: Taint[] },
): Promise<NodeInfo> {
  return request<NodeInfo>(`/api/v1/admin/nodes/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function listNamespaces(): Promise<NamespaceInfo[]> {
  return request<NamespaceInfo[]>('/api/v1/admin/namespaces');
}

export interface NamespaceRef {
  name: string;
  status: string;
}

// Lightweight list available to any authenticated user — used by the
// namespace selector. The full NamespaceInfo (quota, labels) is admin-only.
export function listMyNamespaces(): Promise<NamespaceRef[]> {
  return request<NamespaceRef[]>('/api/v1/namespaces');
}

export function createNamespace(req: { name: string; labels?: Record<string, string>; quota: Quota }): Promise<NamespaceInfo> {
  return request<NamespaceInfo>('/api/v1/admin/namespaces', { method: 'POST', body: req });
}

export function updateNamespaceQuota(name: string, quota: Quota): Promise<NamespaceInfo> {
  return request<NamespaceInfo>(`/api/v1/admin/namespaces/${encodeURIComponent(name)}/quota`, {
    method: 'PATCH',
    body: quota,
  });
}

export function deleteNamespace(name: string): Promise<void> {
  return request<void>(`/api/v1/admin/namespaces/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export function listRoles(namespace: string): Promise<Role[]> {
  return request<Role[]>(`/api/v1/admin/namespaces/${encodeURIComponent(namespace)}/roles`);
}

export function upsertRole(namespace: string, role: Omit<Role, 'id'> & { id?: string }): Promise<Role> {
  return request<Role>(`/api/v1/admin/namespaces/${encodeURIComponent(namespace)}/roles`, {
    method: 'POST',
    body: role,
  });
}

export function deleteRole(namespace: string, kind: Role['kind'], name: string): Promise<void> {
  return request<void>(
    `/api/v1/admin/namespaces/${encodeURIComponent(namespace)}/roles/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}

export function listRoleBindings(namespace: string): Promise<RoleBinding[]> {
  return request<RoleBinding[]>(`/api/v1/admin/namespaces/${encodeURIComponent(namespace)}/rolebindings`);
}

export function upsertRoleBinding(
  namespace: string,
  binding: Omit<RoleBinding, 'id'> & { id?: string },
): Promise<RoleBinding> {
  return request<RoleBinding>(`/api/v1/admin/namespaces/${encodeURIComponent(namespace)}/rolebindings`, {
    method: 'POST',
    body: binding,
  });
}

export function deleteRoleBinding(namespace: string, name: string): Promise<void> {
  return request<void>(
    `/api/v1/admin/namespaces/${encodeURIComponent(namespace)}/rolebindings/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}
