import { request } from './client';

export interface WhoamiUser {
  subject: string;
  email: string;
  name: string;
  groups: string[];
  isPlatformAdmin: boolean;
}

export interface PublicAuthConfig {
  issuer: string;
  clientId: string;
  scopes: string;
  redirectUri?: string;
}

export function whoami(opts: { skipUnauthorizedHandler?: boolean } = {}): Promise<WhoamiUser> {
  return request<WhoamiUser>('/api/v1/whoami', opts);
}

export function authConfig(): Promise<PublicAuthConfig> {
  return request<PublicAuthConfig>('/api/v1/auth/config', { skipUnauthorizedHandler: true });
}
