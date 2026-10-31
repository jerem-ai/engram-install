import type { Store } from './store.js';

/** Read eligibility evidence only; this version grants no identity or authority. */
export function memoryReadVersion(store: Store): string {
  const external = store.db.pragma('data_version', { simple: true });
  const local = (store.db.prepare('SELECT total_changes() AS writes').get() as { writes: number }).writes;
  return JSON.stringify([external, local, store.capturePolicySnapshot().fingerprint]);
}

/** Model work may yield while policy, admission, content or retirement changes. */
export function retainCurrentRead<T>(store: Store, version: string, results: T[]): T[] {
  return memoryReadVersion(store) === version ? results : [];
}
