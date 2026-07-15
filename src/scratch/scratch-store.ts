// IndexedDB-backed persistence for the scratch page's single draft. The store
// holds one document under key "scratch". The IndexedDB round-trip is exercised
// by scripts/browser-smoke.mjs (reload-persistence assertion); only the pure
// serializeError helper is unit-tested (vitest's node env has no IndexedDB).
export interface ScratchStore {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

const STORE = "docs";
const KEY = "scratch";

export function serializeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const name = "name" in e ? `${(e as { name: unknown }).name}: ` : "";
    return `${name}${(e as { message: unknown }).message}`;
  }
  return String(e);
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(serializeError(req.error)));
    req.onblocked = () => reject(new Error("scratch store open blocked"));
  });
}

export function openScratchStore(dbName = "nvim-in-browser"): ScratchStore {
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await openDb(dbName);
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
