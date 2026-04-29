import { useSyncExternalStore } from 'react';

export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (updater: T | ((prev: T) => T)) => {
      state = typeof updater === 'function' ? (updater as (p: T) => T)(state) : updater;
      listeners.forEach(l => l());
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export function useStore<T>(store: { get: () => T; subscribe: (l: () => void) => () => void }): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export const uid = (prefix = 'id') =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
