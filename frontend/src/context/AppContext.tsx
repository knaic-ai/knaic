import {
  createContext,
  useContext,
  useMemo,
  useState,
  useEffect,
  type ReactNode,
} from 'react';
import { apiEnabled } from '@/api/client';
import * as adminApi from '@/api/admin';
import { useAuth } from '@/auth/AuthContext';

export type NamespaceRole = 'admin' | 'editor' | 'viewer';

export interface User {
  name: string;
  email: string;
  isPlatformAdmin: boolean;
  memberships: Record<string, NamespaceRole>;
}

export type ThemeMode = 'light' | 'dark' | 'auto';

export interface AppState {
  user: User;
  setUser: (u: User) => void;
  namespace: string;
  setNamespace: (ns: string) => void;
  namespaces: string[];
  addNamespace: (ns: string) => void;
  removeNamespace: (ns: string) => void;
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  prefersDark: boolean;
  isDark: boolean;
  roleIn: (ns: string) => NamespaceRole | null;
  canEdit: (ns: string) => boolean;
  canAdminNs: (ns: string) => boolean;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [user, setUser] = useState<User>({
    name: apiEnabled ? '' : 'alice',
    email: apiEnabled ? '' : 'alice@example.com',
    isPlatformAdmin: !apiEnabled,
    memberships: apiEnabled ? {} : {
      'team-ml': 'admin',
      'team-vision': 'editor',
      'team-llm': 'viewer',
    },
  });

  const [namespaces, setNamespaces] = useState<string[]>([
    ...(apiEnabled ? [] : ['team-ml', 'team-vision', 'team-llm']),
    'default',
  ]);
  const [namespace, setNamespace] = useState<string>(apiEnabled ? 'default' : 'team-ml');

  useEffect(() => {
    if (!apiEnabled || auth.status !== 'authenticated' || !auth.user) return;
    const remote = auth.user;
    void (async () => {
      setUser(prev => ({
        name: remote.name,
        email: remote.email,
        isPlatformAdmin: remote.isPlatformAdmin,
        memberships: remote.isPlatformAdmin ? prev.memberships : {},
      }));

      // /api/v1/namespaces is open to any authenticated user; the heavier
      // /admin/namespaces and /admin/users endpoints are platform-admin only.
      const myNamespaces = await adminApi.listMyNamespaces().catch(() => null);
      if (myNamespaces) {
        const names = myNamespaces.map(ns => ns.name);
        if (names.length > 0) {
          setNamespaces(names);
          setNamespace(prev => (names.includes(prev) ? prev : names[0]));
        }
      }
      if (!remote.isPlatformAdmin) return;

      const remoteUsers = await adminApi.listUsers().catch(() => null);
      const remoteUser = remoteUsers?.find(
        u =>
          u.id === remote.subject ||
          u.oidcSub === remote.subject ||
          u.email === remote.email ||
          u.name === remote.name,
      );
      if (remoteUser) {
        setUser(prev => ({
          ...prev,
          isPlatformAdmin: remoteUser.isPlatformAdmin,
          memberships: remoteUser.memberships ?? {},
        }));
      }
    })()
      .catch(() => undefined);
  }, [auth.status, auth.user]);

  const [themeMode, setThemeModeRaw] = useState<ThemeMode>(() => {
    const v = localStorage.getItem('knaic:theme');
    return (v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto') as ThemeMode;
  });
  const setThemeMode = (m: ThemeMode) => {
    localStorage.setItem('knaic:theme', m);
    setThemeModeRaw(m);
  };

  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const isDark = themeMode === 'dark' || (themeMode === 'auto' && prefersDark);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  const value = useMemo<AppState>(() => {
    const roleIn = (ns: string): NamespaceRole | null => user.memberships[ns] ?? null;
    const canEdit = (ns: string) =>
      user.isPlatformAdmin || roleIn(ns) === 'admin' || roleIn(ns) === 'editor';
    const canAdminNs = (ns: string) => user.isPlatformAdmin || roleIn(ns) === 'admin';
    return {
      user,
      setUser,
      namespace,
      setNamespace,
      namespaces,
      addNamespace: ns => setNamespaces(prev => (prev.includes(ns) ? prev : [...prev, ns])),
      removeNamespace: ns => setNamespaces(prev => prev.filter(n => n !== ns)),
      themeMode,
      setThemeMode,
      prefersDark,
      isDark,
      roleIn,
      canEdit,
      canAdminNs,
    };
  }, [user, namespace, namespaces, themeMode, prefersDark, isDark]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
