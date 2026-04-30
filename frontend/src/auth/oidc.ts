import type { PublicAuthConfig } from '@/api/auth';

export interface OIDCDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType: string;
  expiresAt: number;
  scope?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

const tokenKey = 'knaic:auth:tokens';
const pendingKey = 'knaic:auth:pkce';
const redirectPath = '/auth/callback';

// Resolution order:
//   1. config.redirectUri  — backend-provided override (KNAIC_OIDC_REDIRECT_URI)
//   2. ${window.location.origin}/auth/callback  — same-origin default
//
// The OIDC provider enforces an exact match against its registered
// redirect_uri, so deployments behind a different external URL must set the
// backend env var to the value registered with the IdP.
export function redirectUri(config?: PublicAuthConfig | null): string {
  if (config?.redirectUri) return config.redirectUri;
  return `${window.location.origin}${redirectPath}`;
}

export function loadTokenSet(): TokenSet | null {
  const raw = localStorage.getItem(tokenKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TokenSet;
    return parsed.accessToken ? parsed : null;
  } catch {
    return null;
  }
}

export function saveTokenSet(tokens: TokenSet): void {
  localStorage.setItem(tokenKey, JSON.stringify(tokens));
}

export function clearStoredAuth(): void {
  localStorage.removeItem(tokenKey);
  sessionStorage.removeItem(pendingKey);
}

export function hasUsableAccessToken(tokens: TokenSet | null): tokens is TokenSet {
  return !!tokens?.accessToken && tokens.expiresAt > Date.now() + 30_000;
}

export async function discoverOIDC(config: PublicAuthConfig): Promise<OIDCDiscovery> {
  if (!config.issuer) throw new Error('OIDC issuer is not configured');
  // Dex (and most issuers behind self-signed CAs) does not return CORS
  // headers, so the browser cannot fetch /.well-known/openid-configuration
  // directly. The backend proxies it for us.
  const res = await fetch('/api/v1/auth/discovery');
  if (!res.ok) throw new Error(`OIDC discovery HTTP ${res.status}`);
  return res.json() as Promise<OIDCDiscovery>;
}

export async function beginOIDCLogin(
  config: PublicAuthConfig,
  discovery: OIDCDiscovery,
  returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`,
): Promise<void> {
  const state = randomBase64URL(32);
  const nonce = randomBase64URL(32);
  const codeVerifier = randomBase64URL(64);
  const codeChallenge = await codeChallengeFor(codeVerifier);
  const pending: PendingLogin = {
    state,
    nonce,
    codeVerifier,
    returnTo: returnTo.startsWith(redirectPath) ? '/' : returnTo || '/',
  };
  sessionStorage.setItem(pendingKey, JSON.stringify(pending));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri(config),
    scope: config.scopes || 'openid profile email groups',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  window.location.assign(`${discovery.authorization_endpoint}?${params}`);
}

export async function completeOIDCCallback(
  config: PublicAuthConfig,
  discovery: OIDCDiscovery,
  href = window.location.href,
): Promise<{ tokens: TokenSet; returnTo: string }> {
  const url = new URL(href);
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    throw new Error(description ? `${error}: ${description}` : error);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('OIDC callback is missing code or state');

  const pending = readPendingLogin();
  if (!pending || pending.state !== state) throw new Error('OIDC callback state does not match this session');
  sessionStorage.removeItem(pendingKey);

  const token = await exchangeToken(discovery.token_endpoint, {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    redirect_uri: redirectUri(config),
    code,
    code_verifier: pending.codeVerifier,
  });
  return { tokens: toTokenSet(token), returnTo: pending.returnTo || '/' };
}

export async function refreshOIDCToken(
  config: PublicAuthConfig,
  discovery: OIDCDiscovery,
  tokens: TokenSet,
): Promise<TokenSet> {
  if (!tokens.refreshToken) throw new Error('No refresh token is available');
  const refreshed = await exchangeToken(discovery.token_endpoint, {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: tokens.refreshToken,
  });
  return toTokenSet({
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? tokens.refreshToken,
    id_token: refreshed.id_token ?? tokens.idToken,
  });
}

export function logoutURL(discovery: OIDCDiscovery | null, tokens: TokenSet | null): string | null {
  if (!discovery?.end_session_endpoint) return null;
  const params = new URLSearchParams({
    post_logout_redirect_uri: window.location.origin,
  });
  if (tokens?.idToken) params.set('id_token_hint', tokens.idToken);
  return `${discovery.end_session_endpoint}?${params}`;
}

async function exchangeToken(endpoint: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`OIDC token exchange HTTP ${res.status}`);
  return res.json() as Promise<TokenResponse>;
}

function toTokenSet(token: TokenResponse): TokenSet {
  if (!token.access_token) throw new Error('OIDC token response did not include an access token');
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    idToken: token.id_token,
    tokenType: token.token_type ?? 'Bearer',
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    scope: token.scope,
  };
}

function readPendingLogin(): PendingLogin | null {
  const raw = sessionStorage.getItem(pendingKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingLogin;
  } catch {
    return null;
  }
}

async function codeChallengeFor(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return base64URL(new Uint8Array(digest));
}

function randomBase64URL(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64URL(arr);
}

function base64URL(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// We can't depend on the path here because the redirect URI is now
// configurable. Detect the OIDC callback by the query params the
// authorization server appends to the redirect.
export function isCallbackPath(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('state') && (params.has('code') || params.has('error'));
}
