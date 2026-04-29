import {
  createContext,
  useContext,
  useMemo,
  useState,
  useEffect,
  type ReactNode,
} from 'react';

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
  const [user, setUser] = useState<User>({
    name: 'alice',
    email: 'alice@example.com',
    isPlatformAdmin: true,
    memberships: {
      'team-ml': 'admin',
      'team-vision': 'editor',
      'team-llm': 'viewer',
    },
  });

  const [namespaces, setNamespaces] = useState<string[]>([
    'team-ml',
    'team-vision',
    'team-llm',
    'default',
  ]);
  const [namespace, setNamespace] = useState<string>('team-ml');

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
