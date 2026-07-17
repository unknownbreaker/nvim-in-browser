// Caches the discovered plugin marketplace in a DEDICATED IndexedDB database,
// separate from the shared "nvim-in-browser" config/plugins DB (whose version
// must not be touched) and from the "nvim-in-browser-secrets" token DB. A single
// record holds the vetted list + when it was refreshed. Every op degrades to a
// no-op / null on failure so a storage error never blanks the options page.
import { serializeError } from "./idb";
import type { MarketplacePlugin } from "../plugins/marketplace-discovery";

const DB_NAME = "nvim-in-browser-marketplace";
const DB_VERSION = 1;
const STORE = "marketplace";
const CACHE_KEY = "cache";

export interface MarketplaceCache {
  plugins: MarketplacePlugin[];
  updatedAt: number;
}

export interface MarketplaceStore {
  /** The cached list + timestamp, or null if none is stored (or on any error). */
  load(): Promise<MarketplaceCache | null>;
  save(plugins: MarketplacePlugin[], updatedAt: number): Promise<void>;
  clear(): Promise<void>;
}

function openMarketplaceDb(): Promise<IDBDatabase> {
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

export function openMarketplaceStore(): MarketplaceStore {
  const tx = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> => {
    const db = await openMarketplaceDb();
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
      try {
        const v = await tx<unknown>("readonly", (s) => s.get(CACHE_KEY));
        if (
          v &&
          typeof v === "object" &&
          Array.isArray((v as MarketplaceCache).plugins) &&
          typeof (v as MarketplaceCache).updatedAt === "number"
        ) {
          return v as MarketplaceCache;
        }
        return null;
      } catch {
        return null;
      }
    },
    async save(plugins, updatedAt) {
      try {
        await tx<IDBValidKey>("readwrite", (s) => s.put({ plugins, updatedAt }, CACHE_KEY));
      } catch {
        // Degrade silently: a failed cache write just means the next open
        // re-discovers or falls back to the bundled seed.
      }
    },
    async clear() {
      try {
        await tx<undefined>("readwrite", (s) => s.delete(CACHE_KEY));
      } catch {
        // no-op on failure
      }
    },
  };
}
