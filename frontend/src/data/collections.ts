import { createStore, useStore } from './store';
import { apiEnabled } from '@/api/client';
import {
  listCollections,
  type CollectionDTO,
  type CollectionScope,
} from '@/api/collections';

const collectionsStore = createStore<CollectionDTO[]>([]);
export const useCollections = () => useStore(collectionsStore);

const loaded = new Set<string>();

export function ensureCollectionsLoaded(scope: CollectionScope, namespace?: string) {
  if (!apiEnabled) return;
  const key = `${scope}:${namespace ?? ''}`;
  if (loaded.has(key)) return;
  loaded.add(key);
  listCollections(scope, namespace)
    .then(items => {
      collectionsStore.set(prev => {
        const purged = prev.filter(c => {
          if (c.scope !== scope) return true;
          if (scope === 'private' && c.namespace !== namespace) return true;
          return false;
        });
        return [...items, ...purged];
      });
    })
    .catch(() => loaded.delete(key));
}

export function reloadCollections(scope: CollectionScope, namespace?: string) {
  loaded.delete(`${scope}:${namespace ?? ''}`);
  ensureCollectionsLoaded(scope, namespace);
}

export function upsertCollectionLocal(c: CollectionDTO) {
  collectionsStore.set(prev => {
    const idx = prev.findIndex(x => x.id === c.id);
    if (idx < 0) return [c, ...prev];
    const copy = [...prev];
    copy[idx] = c;
    return copy;
  });
}

export function removeCollectionLocal(id: string) {
  collectionsStore.set(prev => prev.filter(c => c.id !== id));
}
