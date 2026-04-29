import { createStore, useStore, uid } from './store';

export interface StorageTarget {
  id: string;
  name: string;
  kind: 's3' | 'oci' | 'pvc';
  endpoint: string;
  bucket?: string;
  prefix?: string;
  builtin: boolean;
}

const initial: StorageTarget[] = [
  {
    id: uid('st'),
    name: 'Built-in object store',
    kind: 's3',
    endpoint: 'minio.knaic-system.svc.cluster.local:9000',
    bucket: 'knaic-models',
    prefix: '',
    builtin: true,
  },
  {
    id: uid('st'),
    name: 'Built-in OCI registry',
    kind: 'oci',
    endpoint: 'registry.knaic.local',
    prefix: 'models',
    builtin: true,
  },
  {
    id: uid('st'),
    name: 'External S3 (aws-prod)',
    kind: 's3',
    endpoint: 's3.us-east-1.amazonaws.com',
    bucket: 'acme-ml-models',
    prefix: 'prod/',
    builtin: false,
  },
];

export const storageTargetsStore = createStore<StorageTarget[]>(initial);
export const useStorageTargets = () => useStore(storageTargetsStore);

export function targetUri(t: StorageTarget, subpath: string): string {
  if (t.kind === 's3') return `s3://${t.bucket}/${(t.prefix ?? '').replace(/^\/|\/$/g, '')}${t.prefix ? '/' : ''}${subpath}`;
  if (t.kind === 'oci') return `oci://${t.endpoint}/${(t.prefix ?? '').replace(/^\/|\/$/g, '')}${t.prefix ? '/' : ''}${subpath}`;
  return `pvc://${t.name}/${subpath}`;
}
