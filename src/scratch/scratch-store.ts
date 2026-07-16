// IndexedDB-backed persistence for the scratch page's single draft. The store
// holds one document under key "scratch" in the shared "docs" store (see
// ../storage/idb). The IndexedDB round-trip is exercised by
// scripts/browser-smoke.mjs (reload-persistence assertion); only the pure
// serializeError helper is unit-tested (vitest's node env has no IndexedDB).
import { openDb, serializeError } from "../storage/idb";

export { serializeError } from "../storage/idb";

export interface ScratchStore {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

const STORE = "docs";
const KEY = "scratch";

export function openScratchStore(): ScratchStore {
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(new Error(serializeError(req.error)));
      });
    } finally {
      db.close();
    }
  };
  return {
    async load() {
      const v = await tx<unknown>("readonly", (s) => s.get(KEY));
      return typeof v === "string" ? v : null;
    },
    async save(text) {
      await tx<IDBValidKey>("readwrite", (s) => s.put(text, KEY));
    },
  };
}
