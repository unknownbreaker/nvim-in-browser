// Stores the user's GitHub token in a DEDICATED IndexedDB database, separate
// from the "nvim-in-browser" config/plugins DB. This isolation is deliberate:
// the token is never written into the editor's virtual filesystem, never staged
// into a config file, never returned by the config store's loadFiles(), and is
// untouched by the config "Clear all". It is sent only to GitHub over HTTPS
// (see github-fetch.ts) and never logged.
import { serializeError } from "./idb";

const DB_NAME = "nvim-in-browser-secrets";
const DB_VERSION = 1;
const STORE = "secrets";
const TOKEN_KEY = "github-token";

export interface TokenStore {
  /** The saved token, or null if none is stored. */
  get(): Promise<string | null>;
  /** Whether a token is stored (without returning its value). */
  has(): Promise<boolean>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

function openSecretsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(serializeError(req.error)));
    req.onblocked = () => reject(new Error(`${DB_NAME} open blocked`));
  });
}

export function openTokenStore(): TokenStore {
  const tx = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> => {
    const db = await openSecretsDb();
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
    async get() {
      const v = await tx<unknown>("readonly", (s) => s.get(TOKEN_KEY));
      return typeof v === "string" && v.length > 0 ? v : null;
    },
    async has() {
      // Check presence without materializing the secret into memory.
      const n = await tx<number>("readonly", (s) => s.count(TOKEN_KEY));
      return n > 0;
    },
    async set(token) {
      await tx<IDBValidKey>("readwrite", (s) => s.put(token, TOKEN_KEY));
    },
    async clear() {
      await tx<undefined>("readwrite", (s) => s.delete(TOKEN_KEY));
    },
  };
}
