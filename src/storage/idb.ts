// Shared IndexedDB opener for the "nvim-in-browser" database. Bumped to version
// 3 to add the "plugins" store alongside the "config" and M2 "docs" (scratch)
// stores. The onupgradeneeded handler creates each store only if absent, so an
// existing v2 database upgrades cleanly by adding just "plugins" without
// touching the "docs" or "config" data. The IndexedDB round-trip is exercised by
// scripts/browser-smoke.mjs; only the pure serializeError helper is unit-tested
// (vitest's node env has no IndexedDB).

const DB_NAME = "nvim-in-browser";
const DB_VERSION = 3;
const STORES = ["docs", "config", "plugins"] as const;

export function serializeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const name = "name" in e ? `${(e as { name: unknown }).name}: ` : "";
    return `${name}${(e as { message: unknown }).message}`;
  }
  return String(e);
}

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(serializeError(req.error)));
    req.onblocked = () => reject(new Error(`${DB_NAME} open blocked`));
  });
}
