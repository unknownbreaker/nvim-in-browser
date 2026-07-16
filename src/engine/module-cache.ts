// Persisted cache for the compiled Neovim WebAssembly.Module.
//
// Compiling the ~11 MB Asyncified wasm is by far the biggest boot cost, and
// Chrome redoes it on every fresh tab because we compile from bytes (its
// implicit code cache only helps compileStreaming). A compiled WebAssembly.Module
// is structured-cloneable, so we stash it in IndexedDB after the first compile
// and reuse it on later boots — a new worker can then skip both the wasm fetch
// AND the recompile and go straight to instantiate.
//
// Keyed by the extension version: a new release ships a (possibly) new engine
// and bumps the version, so a stale module is never served. This module runs in
// the worker (IndexedDB is available there); EVERY failure degrades silently to
// recompiling, so the cache can never break boot.
const DB_NAME = "nvim-in-browser-modcache";
const DB_VERSION = 1;
const STORE = "modules";
const KEY = "engine"; // single-entry cache, overwritten when the version changes

interface CacheRecord {
  version: string;
  module: WebAssembly.Module;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("modcache open failed"));
    req.onblocked = () => reject(new Error("modcache open blocked"));
  });
}

/** The cached compiled module for this version, or null (miss / any failure). */
export async function loadCachedModule(version: string): Promise<WebAssembly.Module | null> {
  try {
    const db = await openDb();
    try {
      const rec = await new Promise<CacheRecord | undefined>((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result as CacheRecord | undefined);
        req.onerror = () => reject(req.error);
      });
      if (rec && rec.version === version && rec.module instanceof WebAssembly.Module) {
        return rec.module;
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Best-effort store of the compiled module (overwrites the single entry). */
export async function saveCachedModule(version: string, module: WebAssembly.Module): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ version, module }, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // A browser that refuses to clone a WebAssembly.Module just won't get the
    // cache; boot still works by recompiling next time.
  }
}
