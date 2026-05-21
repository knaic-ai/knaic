// Typed HTTP client for the AI Storage backend
// (internal/aistorage + internal/api/aistorage.go).
//
// All endpoints are namespaced under /api/v1/namespaces/{ns}/aistorage/...
// — the namespace is the user's currently-selected one (see AppContext).
//
// Naming convention: list*, get*, create*, patch*, delete* for the metadata
// side; upload*, download*, browse* for the data-plane side.

import { request, apiBaseUrl, authHeaders, ApiError } from './client';

const nsPath = (ns: string) => `/api/v1/namespaces/${encodeURIComponent(ns)}/aistorage`;

// -------------------- S3 --------------------

export type S3SecretKind = 'aws' | 'compatible';

export interface S3SecretDTO {
  name: string;
  namespace: string;
  kind: S3SecretKind;
  endpoint: string;
  region?: string;
  useHttps: boolean;
  bucket?: string;
  serviceAccount?: string;
  createdAt?: string;
}

export interface CreateS3SecretInput {
  name: string;
  kind: S3SecretKind;
  endpoint: string;
  region?: string;
  useHttps: boolean;
  bucket?: string;
  accessKeyId: string;
  secretAccessKey: string;
  serviceAccount?: string;
}

export interface PatchS3SecretInput {
  endpoint?: string;
  region?: string;
  useHttps?: boolean;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface S3ObjectDTO {
  key: string;
  size: number;
  lastModified?: string;
  isPrefix: boolean;
}

export const listS3Secrets = (ns: string) =>
  request<S3SecretDTO[]>(`${nsPath(ns)}/s3/secrets`);

export const createS3Secret = (ns: string, body: CreateS3SecretInput) =>
  request<S3SecretDTO>(`${nsPath(ns)}/s3/secrets`, { method: 'POST', body });

export const patchS3Secret = (ns: string, name: string, body: PatchS3SecretInput) =>
  request<S3SecretDTO>(`${nsPath(ns)}/s3/secrets/${encodeURIComponent(name)}`, { method: 'PATCH', body });

export const deleteS3Secret = (ns: string, name: string) =>
  request<void>(`${nsPath(ns)}/s3/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const listS3Buckets = (ns: string, secret: string) =>
  request<string[]>(`${nsPath(ns)}/s3/secrets/${encodeURIComponent(secret)}/buckets`);

export const listS3Objects = (ns: string, secret: string, bucket?: string, prefix?: string) => {
  const q = new URLSearchParams();
  if (bucket) q.set('bucket', bucket);
  if (prefix) q.set('prefix', prefix);
  return request<S3ObjectDTO[]>(`${nsPath(ns)}/s3/secrets/${encodeURIComponent(secret)}/objects?${q}`);
};

export const deleteS3Object = (ns: string, secret: string, key: string, bucket?: string) => {
  const q = new URLSearchParams({ key });
  if (bucket) q.set('bucket', bucket);
  return request<void>(`${nsPath(ns)}/s3/secrets/${encodeURIComponent(secret)}/objects?${q}`, { method: 'DELETE' });
};

// uploadS3Object streams a File / Blob to the backend. Uses XMLHttpRequest
// (not fetch) so the caller can observe upload progress via the optional
// onProgress callback — fetch's request side has no progress events in
// browsers as of 2026, ReadableStream upload is still patchy across
// engines, so XHR remains the portable way to show a progress bar.
export async function uploadS3Object(
  ns: string,
  secret: string,
  bucket: string | undefined,
  key: string,
  file: File | Blob,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const q = new URLSearchParams({ key });
  if (bucket) q.set('bucket', bucket);
  const url = `${apiBaseUrl}${nsPath(ns)}/s3/secrets/${encodeURIComponent(secret)}/objects?${q}`;
  return xhrUpload(url, file, onProgress);
}

// downloadS3Object kicks off a browser download by navigating an <a download>.
// Returns the URL so callers can either link to it or open in a new tab.
//
// The URL itself has no auth credential — the caller MUST mint a grant
// cookie via s3DownloadGrant() right before triggering the download,
// otherwise the browser's plain GET (no Authorization header) is rejected
// with 401 "missing bearer token". See downloadS3File() below for the
// usual click-handler shape.
export function s3DownloadUrl(ns: string, secret: string, key: string, bucket?: string): string {
  const q = new URLSearchParams({ key });
  if (bucket) q.set('bucket', bucket);
  return `${apiBaseUrl}${nsPath(ns)}/s3/secrets/${encodeURIComponent(secret)}/objects/raw?${q}`;
}

// s3DownloadGrant mints a path-scoped HttpOnly grant cookie that
// authenticates the next call to the S3 raw-download URL for this secret.
// The grant lives ~10 minutes; we re-mint on every click to keep the code
// simple (POST is cheap, cookie just gets refreshed).
export interface AIStorageGrantDTO {
  downloadPath: string;
  expiresAt: string;
}
export const s3DownloadGrant = (ns: string, secret: string) =>
  request<AIStorageGrantDTO>(
    `${nsPath(ns)}/s3/secrets/${encodeURIComponent(secret)}/objects/grant`,
    { method: 'POST' },
  );

// downloadS3File is the one-shot helper components use as an onClick
// handler. It mints the grant cookie, then triggers the download via a
// temporary <a download> click — Content-Disposition on the response
// makes the browser save instead of navigating.
export async function downloadS3File(
  ns: string,
  secret: string,
  key: string,
  bucket?: string,
): Promise<void> {
  await s3DownloadGrant(ns, secret);
  const url = s3DownloadUrl(ns, secret, key, bucket);
  triggerDownload(url, basename(key));
}

// -------------------- GitLab --------------------

export interface GitLabConfigDTO {
  name: string;
  namespace: string;
  url: string;
  username?: string;
  createdAt?: string;
}

export interface CreateGitLabConfigInput {
  name: string;
  url: string;
  username?: string;
  token: string;
}

export interface PatchGitLabConfigInput {
  url?: string;
  username?: string;
  token?: string;
}

export interface GitLabProjectDTO {
  id: number;
  pathWithNamespace: string;
  defaultBranch?: string;
  webUrl?: string;
  lfsEnabled: boolean;
}

export interface GitLabTreeEntryDTO {
  name: string;
  path: string;
  type: 'tree' | 'blob';
  mode?: string;
  isLfs: boolean;
  size?: number;
}

export const listGitLabConfigs = (ns: string) =>
  request<GitLabConfigDTO[]>(`${nsPath(ns)}/gitlab/configs`);

export const createGitLabConfig = (ns: string, body: CreateGitLabConfigInput) =>
  request<GitLabConfigDTO>(`${nsPath(ns)}/gitlab/configs`, { method: 'POST', body });

export const patchGitLabConfig = (ns: string, name: string, body: PatchGitLabConfigInput) =>
  request<GitLabConfigDTO>(`${nsPath(ns)}/gitlab/configs/${encodeURIComponent(name)}`, { method: 'PATCH', body });

export const deleteGitLabConfig = (ns: string, name: string) =>
  request<void>(`${nsPath(ns)}/gitlab/configs/${encodeURIComponent(name)}`, { method: 'DELETE' });

// listGitLabProjects pulls accessible projects via the knaic passthrough
// proxy — that is, hits GitLab's `GET /api/v4/projects?membership=true`
// directly through `${nsPath}/gitlab/configs/{c}/api/v4/...`, with the
// token attached server-side. We page through up to 50 × 100 results so a
// huge instance doesn't hang us.
//
// The on-wire shape is GitLab's snake_case JSON; we map it down to the
// camelCase DTO the UI expects so the rest of the page stays untouched.
export async function listGitLabProjects(ns: string, config: string): Promise<GitLabProjectDTO[]> {
  type GitLabRaw = {
    id: number;
    path_with_namespace: string;
    default_branch?: string;
    web_url?: string;
    lfs_enabled?: boolean;
  };
  const out: GitLabProjectDTO[] = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await request<GitLabRaw[]>(
      `${gitlabAPIPath(ns, config)}/projects?membership=true&simple=false&per_page=100&page=${page}`,
    );
    for (const p of batch) {
      out.push({
        id: p.id,
        pathWithNamespace: p.path_with_namespace,
        defaultBranch: p.default_branch,
        webUrl: p.web_url,
        lfsEnabled: !!p.lfs_enabled,
      });
    }
    if (batch.length < 100) break;
  }
  out.sort((a, b) => a.pathWithNamespace.localeCompare(b.pathWithNamespace));
  return out;
}

// gitlabAPIPath builds the base URL for a GitLab passthrough call —
// callers append `/projects`, `/groups/123`, etc. and the proxy handles
// the rest (token injection, host rewrite, header stripping).
export function gitlabAPIPath(ns: string, config: string): string {
  return `${nsPath(ns)}/gitlab/configs/${encodeURIComponent(config)}/api/v4`;
}

// gitlabGraphQL POSTs a query against the GitLab GraphQL endpoint through
// the same proxy that fronts the REST API. Used for the tree-with-size
// + LFS-detection query — a single round trip beats the REST tree (which
// doesn't return size) plus N HEAD calls.
//
// We throw on GraphQL-level errors so callers can surface them through
// the usual catch path.
export async function gitlabGraphQL<T>(
  ns: string,
  config: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const path = `${nsPath(ns)}/gitlab/configs/${encodeURIComponent(config)}/api/graphql`;
  type GraphQLResponse = { data?: T; errors?: { message: string }[] };
  const res = await request<GraphQLResponse>(path, {
    method: 'POST',
    body: { query, variables },
  });
  if (res.errors && res.errors.length > 0) {
    throw new ApiError(0, res.errors.map(e => e.message).join('; '));
  }
  if (res.data === undefined) {
    throw new ApiError(0, 'graphql: empty data');
  }
  return res.data;
}

// listGitLabRefs returns the project's branches and tags in a single
// shape so the project detail page can show a combined ref Select. We use
// the REST proxy (per_page=100) because the GraphQL `branches`/`tags`
// fields don't expose anything we need beyond names, and REST keeps the
// types simpler.
export interface GitLabRefs {
  branches: string[];
  tags: string[];
}
export async function listGitLabRefs(
  ns: string,
  config: string,
  projectID: number,
): Promise<GitLabRefs> {
  type RefRaw = { name: string };
  const base = `${gitlabAPIPath(ns, config)}/projects/${projectID}/repository`;
  const [bs, ts] = await Promise.all([
    request<RefRaw[]>(`${base}/branches?per_page=100`).catch(() => []),
    request<RefRaw[]>(`${base}/tags?per_page=100`).catch(() => []),
  ]);
  return {
    branches: bs.map(b => b.name).sort(),
    tags: ts.map(t => t.name).sort(),
  };
}

// listGitLabTreeViaGraphQL fetches one folder's contents — trees, blobs,
// LFS markers — in a single GraphQL request. Then issues one follow-up
// `repository.blobs(paths)` query for byte sizes (the tree blob nodes
// don't expose size).
//
// Returns the same shape `GitLabTreeEntryDTO` does so the page didn't
// need to learn GitLab's snake_case JSON.
export async function listGitLabTreeViaGraphQL(
  ns: string,
  config: string,
  projectPath: string,
  path: string,
  ref: string,
): Promise<GitLabTreeEntryDTO[]> {
  type TreeQueryResult = {
    project: {
      repository: {
        tree: {
          trees: { nodes: Array<{ name: string; path: string; type: string; mode?: string }> };
          blobs: { nodes: Array<{ name: string; path: string; type: string; mode?: string; lfsOid?: string | null }> };
        } | null;
      } | null;
    } | null;
  };
  // `blobs.nodes` is a TreeEntry interface in GitLab's schema; the
  // Blob-specific fields (mode, lfsOid) need an inline fragment to be
  // selectable. The folder side (`trees.nodes`) is also TreeEntry but we
  // only read interface-level fields there.
  const treeQ = `
    query TreeAtPath($projectPath: ID!, $path: String!, $ref: String!) {
      project(fullPath: $projectPath) {
        repository {
          tree(path: $path, ref: $ref, recursive: false) {
            trees { nodes { name path type } }
            blobs {
              nodes {
                name
                path
                type
                ... on Blob { mode lfsOid }
              }
            }
          }
        }
      }
    }
  `;
  const treeData = await gitlabGraphQL<TreeQueryResult>(ns, config, treeQ, {
    projectPath,
    path,
    ref,
  });
  const tree = treeData.project?.repository?.tree;
  if (!tree) return [];
  const entries: GitLabTreeEntryDTO[] = [];
  for (const t of tree.trees.nodes) {
    entries.push({ name: t.name, path: t.path, type: 'tree', mode: t.mode, isLfs: false });
  }
  for (const b of tree.blobs.nodes) {
    entries.push({
      name: b.name,
      path: b.path,
      type: 'blob',
      mode: b.mode,
      isLfs: !!b.lfsOid,
      // size is filled in by the follow-up query below.
    });
  }

  // Follow-up: ask for raw blob sizes by path. Empty result is fine — we
  // just leave sizes undefined and the column shows "—".
  const blobPaths = entries.filter(e => e.type === 'blob').map(e => e.path);
  if (blobPaths.length > 0) {
    type SizesResult = {
      project: {
        repository: {
          blobs: { nodes: Array<{ path: string; rawSize?: string | number | null }> };
        };
      } | null;
    };
    const sizesQ = `
      query BlobSizes($projectPath: ID!, $paths: [String!]!, $ref: String!) {
        project(fullPath: $projectPath) {
          repository {
            blobs(paths: $paths, ref: $ref) {
              nodes { path rawSize }
            }
          }
        }
      }
    `;
    try {
      const sizeData = await gitlabGraphQL<SizesResult>(ns, config, sizesQ, {
        projectPath,
        paths: blobPaths,
        ref,
      });
      const sizeMap = new Map<string, number>();
      for (const n of sizeData.project?.repository?.blobs?.nodes ?? []) {
        const raw = n.rawSize;
        const num = typeof raw === 'string' ? Number(raw) : (raw ?? NaN);
        if (Number.isFinite(num)) sizeMap.set(n.path, num);
      }
      for (const e of entries) {
        if (e.type === 'blob') e.size = sizeMap.get(e.path);
      }
    } catch {
      // Non-fatal — the tree still renders, sizes just stay blank.
    }
  }

  // Folders before files, then alphabetical, to match GitLab UI ordering.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

// fetchGitLabFileText fetches the raw bytes of a file (through the typed
// `/file/raw` endpoint, so LFS pointer resolution still works) and decodes
// them as UTF-8. Used by the in-app text viewer.
//
// The function refuses to download files larger than `maxBytes` based on
// the upstream Content-Length, so a 5 GB safetensors LFS object doesn't
// silently get streamed into the browser before we slice the first MB.
// On size overrun we throw a typed error the caller can display as
// "file too large to preview" without it looking like a network failure.
export class FileTooLargeError extends Error {
  sizeBytes: number;
  constructor(sizeBytes: number) {
    super(`file too large to preview (${sizeBytes} bytes)`);
    this.sizeBytes = sizeBytes;
    this.name = 'FileTooLargeError';
  }
}

export async function fetchGitLabFileText(
  ns: string,
  config: string,
  projectID: number,
  path: string,
  ref: string | undefined,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; sizeBytes: number }> {
  const q = new URLSearchParams({ path });
  if (ref) q.set('ref', ref);
  const url = `${apiBaseUrl}${nsPath(ns)}/gitlab/configs/${encodeURIComponent(config)}/projects/${projectID}/file/raw?${q}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: authHeaders(),
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || `HTTP ${res.status}`);
  }
  const cl = Number(res.headers.get('Content-Length') || '0');
  // Hard cap at 5× the text decode limit. Anything bigger than this is
  // almost certainly a binary asset that slipped past the extension
  // filter; reading it all into memory would freeze the tab.
  const downloadCap = Math.max(maxBytes * 5, 5 * 1024 * 1024);
  if (cl > 0 && cl > downloadCap) {
    // Cancel the response body so we don't accidentally drain the
    // socket on a huge model file.
    res.body?.cancel().catch(() => undefined);
    throw new FileTooLargeError(cl);
  }
  const blob = await res.blob();
  const total = blob.size;
  if (total > maxBytes) {
    const head = blob.slice(0, maxBytes);
    return { text: await head.text(), truncated: true, sizeBytes: total };
  }
  return { text: await blob.text(), truncated: false, sizeBytes: total };
}

// getGitLabProject fetches metadata for a single project via the proxy.
// Used by the project detail page so users can deep-link / refresh without
// the project-list page having to be loaded first.
export async function getGitLabProject(
  ns: string,
  config: string,
  projectID: number,
): Promise<GitLabProjectDTO> {
  type GitLabRaw = {
    id: number;
    path_with_namespace: string;
    default_branch?: string;
    web_url?: string;
    lfs_enabled?: boolean;
  };
  const p = await request<GitLabRaw>(`${gitlabAPIPath(ns, config)}/projects/${projectID}`);
  return {
    id: p.id,
    pathWithNamespace: p.path_with_namespace,
    defaultBranch: p.default_branch,
    webUrl: p.web_url,
    lfsEnabled: !!p.lfs_enabled,
  };
}

export const listGitLabTree = (
  ns: string,
  config: string,
  projectID: number,
  path?: string,
  ref?: string,
) => {
  const q = new URLSearchParams();
  if (path) q.set('path', path);
  if (ref) q.set('ref', ref);
  return request<GitLabTreeEntryDTO[]>(
    `${nsPath(ns)}/gitlab/configs/${encodeURIComponent(config)}/projects/${projectID}/tree?${q}`,
  );
};

export function gitlabDownloadUrl(
  ns: string,
  config: string,
  projectID: number,
  path: string,
  ref?: string,
): string {
  const q = new URLSearchParams({ path });
  if (ref) q.set('ref', ref);
  return `${apiBaseUrl}${nsPath(ns)}/gitlab/configs/${encodeURIComponent(config)}/projects/${projectID}/file/raw?${q}`;
}

// gitlabDownloadGrant mirrors s3DownloadGrant: a path-scoped grant cookie
// for the next GitLab raw-download GET.
export const gitlabDownloadGrant = (ns: string, config: string, projectID: number) =>
  request<AIStorageGrantDTO>(
    `${nsPath(ns)}/gitlab/configs/${encodeURIComponent(config)}/projects/${projectID}/file/grant`,
    { method: 'POST' },
  );

export async function downloadGitLabFile(
  ns: string,
  config: string,
  projectID: number,
  path: string,
  ref?: string,
): Promise<void> {
  await gitlabDownloadGrant(ns, config, projectID);
  const url = gitlabDownloadUrl(ns, config, projectID, path, ref);
  triggerDownload(url, basename(path));
}

export async function uploadGitLabFile(
  ns: string,
  config: string,
  projectID: number,
  path: string,
  branch: string,
  commitMsg: string,
  file: File | Blob,
  asLfs: boolean,
): Promise<void> {
  const q = new URLSearchParams({ path, branch });
  if (commitMsg) q.set('message', commitMsg);
  if (asLfs) q.set('lfs', 'true');
  const res = await fetch(
    `${apiBaseUrl}${nsPath(ns)}/gitlab/configs/${encodeURIComponent(config)}/projects/${projectID}/file?${q}`,
    {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': file.type || 'application/octet-stream',
      }),
      body: file,
      credentials: 'include',
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || `HTTP ${res.status}`);
  }
}

// -------------------- PVC --------------------

export interface PVCEntryDTO {
  name: string;
  storageClass?: string;
  capacity?: string;
  accessMode?: string;
  phase?: string;
  viewer?: 'running' | 'ready' | '';
  createdAt?: string;
}

export interface CreatePVCInput {
  name: string;
  storageClass?: string;
  capacity: string;
  accessMode?: string;
}

export interface PVCViewerStatusDTO {
  pvc: string;
  running: boolean;
  ready: boolean;
  phase?: string;
  deployment?: string;
  service?: string;
  startedAt?: string;
  viewerPath?: string;
}

export const listAIStoragePVCs = (ns: string) =>
  request<PVCEntryDTO[]>(`${nsPath(ns)}/pvc/`);

export const createAIStoragePVC = (ns: string, body: CreatePVCInput) =>
  request<PVCEntryDTO>(`${nsPath(ns)}/pvc/`, { method: 'POST', body });

export const deleteAIStoragePVC = (ns: string, name: string) =>
  request<void>(`${nsPath(ns)}/pvc/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const pvcViewerStatus = (ns: string, pvc: string) =>
  request<PVCViewerStatusDTO>(`${nsPath(ns)}/pvc/${encodeURIComponent(pvc)}/viewer/status`);

export const pvcViewerStart = (ns: string, pvc: string) =>
  request<PVCViewerStatusDTO>(`${nsPath(ns)}/pvc/${encodeURIComponent(pvc)}/viewer/start`, { method: 'POST' });

export const pvcViewerStop = (ns: string, pvc: string) =>
  request<void>(`${nsPath(ns)}/pvc/${encodeURIComponent(pvc)}/viewer/stop`, { method: 'POST' });

// pvcViewerGrant trades the user's bearer token for a path-scoped
// HttpOnly cookie the iframe can carry. The response body just tells us
// when the grant expires so the UI can re-grant ahead of time; the
// actual auth credential lives in the Set-Cookie header.
export interface PVCViewerGrantDTO {
  viewerPath: string;
  expiresAt: string;
}
export const pvcViewerGrant = (ns: string, pvc: string) =>
  request<PVCViewerGrantDTO>(`${nsPath(ns)}/pvc/${encodeURIComponent(pvc)}/viewer/grant`, { method: 'POST' });

export function pvcViewerUrl(ns: string, pvc: string): string {
  return `${apiBaseUrl}${nsPath(ns)}/pvc/${encodeURIComponent(pvc)}/viewer/`;
}

// -------------------- internal helpers --------------------

// triggerDownload creates a transient <a download> and clicks it, which
// makes the browser save the response instead of navigating. The grant
// cookie that authenticates the request must already be set — typically
// by an await on s3DownloadGrant / gitlabDownloadGrant right before this.
function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  // The empty download attribute means "use whatever Content-Disposition
  // sends". When the server doesn't set one, fall back to the basename
  // we computed from the key/path.
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

// xhrUpload POSTs a File / Blob with the bearer header and fires the
// optional onProgress callback as the request body is sent. The
// percentage we pass back is 0–100 (rounded by the caller if it wants
// integers); we don't round here so callers can also show fractional
// values for very small files.
function xhrUpload(
  url: string,
  file: File | Blob,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    const headers = authHeaders({ 'Content-Type': file.type || 'application/octet-stream' });
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        onProgress((e.loaded / e.total) * 100);
      };
      // Surface "we finished sending" as 100% even when the server is
      // still processing — gives the UI a definite end-of-upload signal
      // before the response settles.
      xhr.upload.onload = () => onProgress(100);
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new ApiError(xhr.status, xhr.responseText || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network error'));
    xhr.onabort = () => reject(new ApiError(0, 'upload aborted'));
    xhr.send(file);
  });
}
