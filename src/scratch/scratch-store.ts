// IndexedDB-backed persistence for a scratch page's draft, in the shared "docs"
// store (see ../storage/idb). Each scratch TAB passes a distinct `docId` so its
// draft is independent — key "scratch:<docId>". With no docId the default key
// "scratch" is used (a single shared draft — the pre-per-tab behavior, and what
// the browser smoke exercises). The IndexedDB round-trip is exercised by
// scripts/browser-smoke.mjs; only the pure serializeError helper is unit-tested.
import { openDb, serializeError } from "../storage/idb";

export { serializeError } from "../storage/idb";

export interface ScratchStore {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

const STORE = "docs";
const DEFAULT_KEY = "scratch";

export function openScratchStore(docId?: string): ScratchStore {
  const KEY = docId ? `scratch:${docId}` : DEFAULT_KEY;
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
