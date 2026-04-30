import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Result, Spin } from 'antd';
import { LoginOutlined, ReloadOutlined } from '@ant-design/icons';
import { ApiError, apiEnabled, setBearerToken, setUnauthorizedHandler } from '@/api/client';
import { authConfig, whoami, type PublicAuthConfig, type WhoamiUser } from '@/api/auth';
import { clearSeedStoresForApiMode } from '@/data/reset';
import {
  beginOIDCLogin,
  clearStoredAuth,
  completeOIDCCallback,
  discoverOIDC,
  hasUsableAccessToken,
  isCallbackPath,
  loadTokenSet,
  logoutURL,
  refreshOIDCToken,
  saveTokenSet,
  type OIDCDiscovery,
  type TokenSet,
} from './oidc';

type AuthStatus = 'loading' | 'authenticated' | 'redirecting' | 'error';
type AuthMode = 'prototype' | 'dev-bypass' | 'oidc';

interface AuthContextValue {
  status: AuthStatus;
  mode: AuthMode;
  user: WhoamiUser | null;
  error: string | null;
  login: () => void;
  logout: () => void;
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [mode, setMode] = useState<AuthMode>(apiEnabled ? 'oidc' : 'prototype');
  const [user, setUser] = useState<WhoamiUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef<PublicAuthConfig | null>(null);
  const discoveryRef = useRef<OIDCDiscovery | null>(null);
  const tokensRef = useRef<TokenSet | null>(null);
  const bootedRef = useRef(false);
  const redirectingRef = useRef(false);

  const startLogin = async () => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    setStatus('redirecting');
    try {
      const config = await loadAuthConfig();
      const discovery = await loadDiscovery(config);
      await beginOIDCLogin(config, discovery);
    } catch (err) {
      redirectingRef.current = false;
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to start OIDC login');
    }
  };

  const clearAndLogin = () => {
    clearStoredAuth();
    setBearerToken(null);
    tokensRef.current = null;
    void startLogin();
  };

  useEffect(() => {
    setUnauthorizedHandler(clearAndLogin);
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void bootstrap();
  }, []);

  async function bootstrap() {
    if (!apiEnabled) {
      setMode('prototype');
      setStatus('authenticated');
      return;
    }

    try {
      if (isCallbackPath()) {
        await finishCallback();
        return;
      }

      let tokens = loadTokenSet();
      if (tokens && !hasUsableAccessToken(tokens)) {
        try {
          const config = await loadAuthConfig();
          const discovery = await loadDiscovery(config);
          tokens = await refreshOIDCToken(config, discovery, tokens);
          saveTokenSet(tokens);
        } catch {
          clearStoredAuth();
          setBearerToken(null);
          tokensRef.current = null;
          await startLogin();
          return;
        }
      }
      if (tokens) {
        tokensRef.current = tokens;
        setBearerToken(tokens.accessToken);
      } else {
        setBearerToken(null);
      }

      const remote = await whoami({ skipUnauthorizedHandler: true });
      clearSeedStoresForApiMode();
      setUser(remote);
      setMode(tokens ? 'oidc' : 'dev-bypass');
      setStatus('authenticated');
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearStoredAuth();
        setBearerToken(null);
        tokensRef.current = null;
        await startLogin();
        return;
      }
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Authentication failed');
    }
  }

  async function finishCallback() {
    const config = await loadAuthConfig();
    const discovery = await loadDiscovery(config);
    const { tokens, returnTo } = await completeOIDCCallback(config, discovery);
    saveTokenSet(tokens);
    tokensRef.current = tokens;
    setBearerToken(tokens.accessToken);

    const remote = await whoami({ skipUnauthorizedHandler: true });
    clearSeedStoresForApiMode();
    setUser(remote);
    setMode('oidc');
    setStatus('authenticated');
    setError(null);
    window.history.replaceState(null, '', returnTo);
  }

  async function loadAuthConfig(): Promise<PublicAuthConfig> {
    if (configRef.current) return configRef.current;
    const config = await authConfig();
    if (!config.issuer || !config.clientId) {
      throw new Error('Backend did not return OIDC issuer and clientId');
    }
    configRef.current = config;
    return config;
  }

  async function loadDiscovery(config: PublicAuthConfig): Promise<OIDCDiscovery> {
    if (discoveryRef.current) return discoveryRef.current;
    const discovery = await discoverOIDC(config);
    discoveryRef.current = discovery;
    return discovery;
  }

  const value = useMemo<AuthContextValue>(() => ({
    status,
    mode,
    user,
    error,
    login: () => void startLogin(),
    logout: () => {
      const logoutRedirect = logoutURL(discoveryRef.current, tokensRef.current);
      clearStoredAuth();
      setBearerToken(null);
      tokensRef.current = null;
      setUser(null);
      setStatus('redirecting');
      if (logoutRedirect) {
        window.location.assign(logoutRedirect);
      } else {
        window.location.assign('/');
      }
    },
    retry: () => {
      setStatus('loading');
      setError(null);
      bootedRef.current = false;
      redirectingRef.current = false;
      void bootstrap();
    },
  }), [status, mode, user, error]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.status === 'authenticated') return <>{children}</>;
  return <AuthStatusScreen />;
}

export function AuthCallback() {
  return <AuthStatusScreen title="Completing sign in" />;
}

function AuthStatusScreen({ title }: { title?: string }) {
  const auth = useAuth();
  const heading = title ?? (auth.status === 'redirecting' ? 'Redirecting to sign in' : 'Preparing knaic');

  if (auth.status === 'error') {
    return (
      <CenteredCard>
        <Result
          status="warning"
          title="Sign in failed"
          subTitle={auth.error ?? 'Authentication failed'}
          extra={[
            <Button key="retry" icon={<ReloadOutlined />} onClick={auth.retry}>
              Retry
            </Button>,
            <Button key="login" type="primary" icon={<LoginOutlined />} onClick={auth.login}>
              Sign in
            </Button>,
          ]}
        />
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <Spin size="large" />
      <h2 style={{ margin: '16px 0 8px' }}>{heading}</h2>
      <Alert
        type="info"
        showIcon
        message="The console waits for backend authentication before loading cluster data."
      />
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <Card style={{ width: 520, maxWidth: '100%' }}>
        {children}
      </Card>
    </div>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
