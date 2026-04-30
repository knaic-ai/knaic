import { createStore, useStore, uid } from './store';
import type { NamespaceRole } from '@/context/AppContext';
import { apiEnabled } from '@/api/client';
import * as api from '@/api/admin';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  oidcSub: string;
  firstSeen: string;
  lastSeen: string;
  isPlatformAdmin: boolean;
  memberships: Record<string, NamespaceRole>;
}

export interface Role {
  id: string;
  name: string;
  namespace: string;
  kind: 'Role' | 'ClusterRole';
  rules: { apiGroups: string[]; resources: string[]; verbs: string[] }[];
}

export interface RoleBinding {
  id: string;
  name: string;
  namespace: string;
  roleRef: { kind: 'Role' | 'ClusterRole'; name: string };
  subjects: { kind: 'User' | 'Group'; name: string }[];
}

const now = () => new Date().toISOString().slice(0, 10);

const usersInitial: UserRecord[] = [
  {
    id: uid('u'),
    name: 'alice',
    email: 'alice@example.com',
    oidcSub: 'oidc|dex|alice',
    firstSeen: '2025-12-01',
    lastSeen: now(),
    isPlatformAdmin: true,
    memberships: { 'team-ml': 'admin', 'team-vision': 'editor', 'team-llm': 'viewer' },
  },
  {
    id: uid('u'),
    name: 'bob',
    email: 'bob@example.com',
    oidcSub: 'oidc|dex|bob',
    firstSeen: '2026-01-14',
    lastSeen: now(),
    isPlatformAdmin: false,
    memberships: { 'team-ml': 'editor' },
  },
  {
    id: uid('u'),
    name: 'carol',
    email: 'carol@example.com',
    oidcSub: 'oidc|dex|carol',
    firstSeen: '2026-02-03',
    lastSeen: now(),
    isPlatformAdmin: false,
    memberships: { 'team-vision': 'admin', 'team-llm': 'editor' },
  },
  {
    id: uid('u'),
    name: 'dave',
    email: 'dave@example.com',
    oidcSub: 'oidc|dex|dave',
    firstSeen: '2026-03-22',
    lastSeen: now(),
    isPlatformAdmin: false,
    memberships: { 'team-llm': 'viewer' },
  },
];

const rolesInitial: Role[] = [
  {
    id: uid('r'),
    name: 'namespace-admin',
    namespace: 'team-ml',
    kind: 'Role',
    rules: [
      { apiGroups: ['*'], resources: ['*'], verbs: ['*'] },
    ],
  },
  {
    id: uid('r'),
    name: 'ml-engineer',
    namespace: 'team-ml',
    kind: 'Role',
    rules: [
      { apiGroups: ['', 'apps'], resources: ['pods', 'deployments', 'services'], verbs: ['get', 'list', 'watch', 'create', 'update'] },
      { apiGroups: ['serving.kserve.io'], resources: ['inferenceservices', 'servingruntimes'], verbs: ['*'] },
      { apiGroups: ['kubeflow.org'], resources: ['notebooks'], verbs: ['*'] },
      { apiGroups: ['trainer.kubeflow.org'], resources: ['trainjobs'], verbs: ['*'] },
    ],
  },
  {
    id: uid('r'),
    name: 'viewer',
    namespace: 'team-ml',
    kind: 'Role',
    rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['get', 'list', 'watch'] }],
  },
];

const bindingsInitial: RoleBinding[] = [
  {
    id: uid('rb'),
    name: 'alice-admin',
    namespace: 'team-ml',
    roleRef: { kind: 'Role', name: 'namespace-admin' },
    subjects: [{ kind: 'User', name: 'alice' }],
  },
  {
    id: uid('rb'),
    name: 'ml-engineers',
    namespace: 'team-ml',
    roleRef: { kind: 'Role', name: 'ml-engineer' },
    subjects: [
      { kind: 'User', name: 'bob' },
      { kind: 'User', name: 'carol' },
    ],
  },
];

export const usersStore = createStore<UserRecord[]>(usersInitial);
export const rolesStore = createStore<Role[]>(rolesInitial);
export const bindingsStore = createStore<RoleBinding[]>(bindingsInitial);

export const useUsers = () => useStore(usersStore);
export const useRoles = () => useStore(rolesStore);
export const useBindings = () => useStore(bindingsStore);

const loaded = new Set<string>();

export function ensureUsersLoaded(): void {
  if (!apiEnabled || loaded.has('users')) return;
  loaded.add('users');
  api.listUsers()
    .then(users => usersStore.set(users.map(normalizeUser)))
    .catch(() => loaded.delete('users'));
}

export function reloadUsers(): void {
  loaded.delete('users');
  ensureUsersLoaded();
}

export async function updateUser(id: string, patch: Pick<UserRecord, 'isPlatformAdmin' | 'memberships'>): Promise<void> {
  if (apiEnabled) {
    const updated = await api.patchUser(id, patch);
    usersStore.set(prev => prev.map(u => (u.id === id ? normalizeUser(updated) : u)));
    return;
  }
  usersStore.set(prev =>
    prev.map(u => (u.id === id ? { ...u, isPlatformAdmin: patch.isPlatformAdmin, memberships: patch.memberships } : u)),
  );
}

export function ensureRolesLoaded(namespace: string): void {
  if (!apiEnabled) return;
  const key = `roles:${namespace}`;
  if (loaded.has(key)) return;
  loaded.add(key);
  api.listRoles(namespace)
    .then(roles => rolesStore.set(prev => [...prev.filter(r => r.namespace !== namespace), ...roles]))
    .catch(() => loaded.delete(key));
}

export function reloadRoles(namespace: string): void {
  loaded.delete(`roles:${namespace}`);
  ensureRolesLoaded(namespace);
}

export async function saveRole(namespace: string, role: Omit<Role, 'id' | 'namespace'> & { namespace?: string }): Promise<void> {
  if (apiEnabled) {
    const saved = await api.upsertRole(namespace, { ...role, namespace });
    rolesStore.set(prev => [saved, ...prev.filter(r => r.id !== saved.id)]);
    return;
  }
  const existing = rolesStore.get().find(r => r.namespace === namespace && r.kind === role.kind && r.name === role.name);
  if (existing) {
    rolesStore.set(prev => prev.map(r => (r.id === existing.id ? { ...r, ...role, namespace } : r)));
  } else {
    rolesStore.set(prev => [{ id: uid('r'), namespace, ...role }, ...prev]);
  }
}

export async function removeRole(namespace: string, kind: Role['kind'], name: string, id?: string): Promise<void> {
  if (apiEnabled) {
    await api.deleteRole(namespace, kind, name);
  }
  rolesStore.set(prev => prev.filter(r => (id ? r.id !== id : !(r.namespace === namespace && r.kind === kind && r.name === name))));
}

export function ensureBindingsLoaded(namespace: string): void {
  if (!apiEnabled) return;
  const key = `bindings:${namespace}`;
  if (loaded.has(key)) return;
  loaded.add(key);
  api.listRoleBindings(namespace)
    .then(bindings => bindingsStore.set(prev => [...prev.filter(b => b.namespace !== namespace), ...bindings]))
    .catch(() => loaded.delete(key));
}

export function reloadBindings(namespace: string): void {
  loaded.delete(`bindings:${namespace}`);
  ensureBindingsLoaded(namespace);
}

export async function saveBinding(
  namespace: string,
  binding: Omit<RoleBinding, 'id' | 'namespace'> & { namespace?: string },
): Promise<void> {
  if (apiEnabled) {
    const saved = await api.upsertRoleBinding(namespace, { ...binding, namespace });
    bindingsStore.set(prev => [saved, ...prev.filter(b => b.id !== saved.id)]);
    return;
  }
  const existing = bindingsStore.get().find(b => b.namespace === namespace && b.name === binding.name);
  if (existing) {
    bindingsStore.set(prev => prev.map(b => (b.id === existing.id ? { ...b, ...binding, namespace } : b)));
  } else {
    bindingsStore.set(prev => [{ id: uid('rb'), namespace, ...binding }, ...prev]);
  }
}

export async function removeBinding(namespace: string, name: string, id?: string): Promise<void> {
  if (apiEnabled) {
    await api.deleteRoleBinding(namespace, name);
  }
  bindingsStore.set(prev => prev.filter(b => (id ? b.id !== id : !(b.namespace === namespace && b.name === name))));
}

function normalizeUser(u: UserRecord): UserRecord {
  return {
    ...u,
    firstSeen: String(u.firstSeen).slice(0, 10),
    lastSeen: String(u.lastSeen).slice(0, 10),
    memberships: u.memberships ?? {},
  };
}
