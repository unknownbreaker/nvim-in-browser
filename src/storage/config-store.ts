// IndexedDB-backed persistence for the user's Neovim config files (mapped under
// .config/nvim). Files live in the "config" store keyed by "file:" + relpath
// (value = file content); a single metadata record lives under key "meta". Only
// the pure isSafeRelpath validator is unit-tested (vitest's node env has no
// IndexedDB); the IDB round-trip is proven by Task 5's browser smoke.
import { openDb, serializeError } from "./idb";

const STORE = "config";
const FILE_PREFIX = "file:";
const META_KEY = "meta";

export interface ConfigMeta {
  enabled: boolean;
}

export interface ConfigStore {
  loadFiles(): Promise<Record<string, string>>;
  saveFile(relpath: string, content: string): Promise<void>;
  deleteFile(relpath: string): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
  clear(): Promise<void>;
  getMeta(): Promise<ConfigMeta>;
  setMeta(meta: Partial<ConfigMeta>): Promise<void>;
}

const DEFAULT_META: ConfigMeta = { enabled: true };

// A relpath is safe iff it contains only [A-Za-z0-9._-/], has no ".." path
// segment, and is not absolute (doesn't start with "/"). This guarantees writes
// stay within .config/nvim.
export function isSafeRelpath(p: string): boolean {
  if (!/^[A-Za-z0-9._\-/]+$/.test(p)) return false;
  if (p.startsWith("/")) return false;
  return !p.split("/").includes("..");
}

export function openConfigStore(): ConfigStore {
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
    async loadFiles() {
      const db = await openDb();
      try {
        return await new Promise<Record<string, string>>((resolve, reject) => {
          const store = db.transaction(STORE, "readonly").objectStore(STORE);
          const req = store.openCursor();
          const out: Record<string, string> = {};
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve(out);
              return;
            }
            const key = cursor.key;
            if (typeof key === "string" && key.startsWith(FILE_PREFIX)) {
              out[key.slice(FILE_PREFIX.length)] = cursor.value as string;
            }
            cursor.continue();
          };
          req.onerror = () => reject(new Error(serializeError(req.error)));
        });
      } finally {
        db.close();
      }
    },

    async saveFile(relpath, content) {
      if (!isSafeRelpath(relpath)) {
        throw new Error(`unsafe config relpath: ${relpath}`);
      }
      await tx<IDBValidKey>("readwrite", (s) =>
        s.put(content, FILE_PREFIX + relpath),
      );
    },

    async deleteFile(relpath) {
      await tx<undefined>("readwrite", (s) => s.delete(FILE_PREFIX + relpath));
    },

    async renameFile(from, to) {
      if (!isSafeRelpath(to)) throw new Error(`unsafe config relpath: ${to}`);
      const content = await tx<unknown>("readonly", (s) =>
        s.get(FILE_PREFIX + from),
      );
      if (typeof content !== "string")
        throw new Error(`no such config file: ${from}`);
      await tx<IDBValidKey>("readwrite", (s) => s.put(content, FILE_PREFIX + to));
      await tx<undefined>("readwrite", (s) => s.delete(FILE_PREFIX + from));
    },

    async clear() {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const store = db.transaction(STORE, "readwrite").objectStore(STORE);
          const req = store.openCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve();
              return;
            }
            if (
              typeof cursor.key === "string" &&
              cursor.key.startsWith(FILE_PREFIX)
            ) {
              cursor.delete();
            }
            cursor.continue();
          };
          req.onerror = () => reject(new Error(serializeError(req.error)));
        });
      } finally {
        db.close();
      }
    },

    async getMeta() {
      const v = await tx<unknown>("readonly", (s) => s.get(META_KEY));
      if (v && typeof v === "object") {
        return { ...DEFAULT_META, ...(v as Partial<ConfigMeta>) };
      }
      return { ...DEFAULT_META };
    },

    async setMeta(meta) {
      const current = await this.getMeta();
      const merged: ConfigMeta = { ...current, ...meta };
      await tx<IDBValidKey>("readwrite", (s) => s.put(merged, META_KEY));
    },
  };
}
