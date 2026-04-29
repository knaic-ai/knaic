import { createStore, useStore, uid } from './store';
import type { NamespaceRole } from '@/context/AppContext';

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
