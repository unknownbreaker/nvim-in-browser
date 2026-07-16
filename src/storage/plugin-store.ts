// IndexedDB-backed persistence for installed Neovim plugins. Each plugin is one
// record in the "plugins" store keyed by its `name` (also its FS dir name under
// pack/plugins/start/). Only the pure isSafePluginName validator is unit-tested
// (node has no IndexedDB); the IDB round-trip is proven by browser-smoke PHASE F.
import { openDb, serializeError } from "./idb";

const STORE = "plugins";

export interface PluginRecord {
  name: string;
  source: "github" | "upload";
  repo?: string;
  ref?: string;
  enabled: boolean;
  files: { path: string; data: Uint8Array }[];
  addedAt: number;
}

export interface PluginStore {
  list(): Promise<PluginRecord[]>;
  add(rec: PluginRecord): Promise<void>;
  remove(name: string): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  get(name: string): Promise<PluginRecord | null>;
}

// A plugin name is a single safe path segment: it becomes an FS directory under
// pack/plugins/start/, so no separators, no "." / ".." traversal, non-empty.
export function isSafePluginName(name: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  return name !== "." && name !== "..";
}

export function openPluginStore(): PluginStore {
  const tx = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> => {
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
    async list() {
      const db = await openDb();
      try {
        return await new Promise<PluginRecord[]>((resolve, reject) => {
          const store = db.transaction(STORE, "readonly").objectStore(STORE);
          const req = store.getAll();
          req.onsuccess = () => resolve((req.result as PluginRecord[]) ?? []);
          req.onerror = () => reject(new Error(serializeError(req.error)));
        });
      } finally {
        db.close();
      }
    },

    async add(rec) {
      if (!isSafePluginName(rec.name)) {
        throw new Error(`unsafe plugin name: ${rec.name}`);
      }
      await tx<IDBValidKey>("readwrite", (s) => s.put(rec, rec.name));
    },

    async remove(name) {
      await tx<undefined>("readwrite", (s) => s.delete(name));
    },

    async get(name) {
      const v = await tx<unknown>("readonly", (s) => s.get(name));
      return v && typeof v === "object" ? (v as PluginRecord) : null;
    },

    async setEnabled(name, enabled) {
      const rec = await this.get(name);
      if (!rec) throw new Error(`no such plugin: ${name}`);
      rec.enabled = enabled;
      await tx<IDBValidKey>("readwrite", (s) => s.put(rec, name));
    },
  };
}
