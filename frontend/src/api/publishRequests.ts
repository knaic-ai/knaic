// Typed bindings for /api/v1/model-publish-requests. Mirrors
// backend/internal/publish/types.go.

import { request } from './client';

export type PublishStatus = 'pending' | 'approved' | 'rejected';

export interface PublishRequestDTO {
  id: string;
  privateModelId: string;
  privateNamespace: string;
  privateName: string;
  privateUri: string;
  targetName: string;
  targetCollectionId?: string;
  requestedBy: string;
  note?: string;
  status: PublishStatus;
  reviewedBy?: string;
  reviewerNote?: string;
  catalogModelId?: string;
  createdAt: string;
  updatedAt: string;
}

export function listPublishRequests(opts: { status?: PublishStatus; namespace?: string } = {}): Promise<PublishRequestDTO[]> {
  const qs = new URLSearchParams();
  if (opts.status) qs.set('status', opts.status);
  if (opts.namespace) qs.set('namespace', opts.namespace);
  const suffix = qs.toString() ? `?${qs}` : '';
  return request<PublishRequestDTO[]>(`/api/v1/model-publish-requests${suffix}`);
}

export interface CreatePublishRequest {
  privateModelId: string;
  targetName: string;
  targetCollectionId?: string;
  note?: string;
}

export function createPublishRequest(req: CreatePublishRequest): Promise<PublishRequestDTO> {
  return request<PublishRequestDTO>('/api/v1/model-publish-requests', { method: 'POST', body: req });
}

export interface ReviewRequest {
  reviewerNote?: string;
}

export function approvePublishRequest(id: string, body: ReviewRequest = {}): Promise<PublishRequestDTO> {
  return request<PublishRequestDTO>(`/api/v1/model-publish-requests/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body,
  });
}

export function rejectPublishRequest(id: string, body: ReviewRequest = {}): Promise<PublishRequestDTO> {
  return request<PublishRequestDTO>(`/api/v1/model-publish-requests/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body,
  });
}

export function deletePublishRequest(id: string): Promise<void> {
  return request<void>(`/api/v1/model-publish-requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
