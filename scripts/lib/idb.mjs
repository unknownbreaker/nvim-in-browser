// Shared in-page IndexedDB helper for browser-smoke's config/plugins store
// writes and clears. Consumed by: scripts/browser-smoke.mjs.
//
// browser-smoke drove the app's IndexedDB via page.evaluate() six times
// (idbWriteConfig, idbClearConfig, idbClearPlugins, idbWritePlugin,
// idbSetPluginEnabled, idbWriteConfigFiles), each repeating an identical
// open -> transaction -> complete/close skeleton and differing only in which
// store they open and what they do inside the transaction. This collapses
// them onto ONE parameterized in-page helper, `idbTx`, dispatched by an `op`
// name — each op's body is ordinary in-page code behind a switch, not a
// source string handed to `new Function`/`eval`, because the extension's own
// CSP (script-src 'self' 'wasm-unsafe-eval'; see src/manifest.json) does not
// grant 'unsafe-eval' and would block that.
//
// HARD CONSTRAINT (persistence keys): the IndexedDB database name
// "nvim-in-browser", version 3, and store names "config" / "plugins" are LIVE
// persistence keys that match the app's real DB (src/storage/idb.ts). These
// literals must stay exactly as they are — do not parameterize or "clean up"
// them away.
//
// Two small, deliberate consistency fixes made while collapsing onto one
// skeleton (both call sites are strictly safer than before, and neither
// changes any happy-path behavior the smoke exercises):
//   1. onblocked handler: idbSetPluginEnabled and idbWriteConfigFiles were the
//      only two of the six that omitted `open.onblocked`. All six now get it.
//   2. tx-open try/catch: idbWriteConfig was the only one of the six that
//      guarded `db.transaction(...)` with try/catch (rejecting cleanly on a
//      synchronous throw instead of hanging forever). All six now get it.
export function idbTx(page, storeName, op, args) {
  return page.evaluate(
    ({ storeName, op, args }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("nvim-in-browser", 3);
        open.onerror = () => reject(new Error("open failed: " + (open.error?.message ?? "?")));
        open.onblocked = () => reject(new Error("open blocked"));
        open.onsuccess = () => {
          const db = open.result;
          let tx;
          try {
            tx = db.transaction(storeName, "readwrite");
          } catch (e) {
            db.close();
            reject(new Error("tx open failed: " + (e?.message ?? String(e))));
            return;
          }
          const store = tx.objectStore(storeName);
          switch (op) {
            case "writeConfig":
              store.put(args.initLua, "file:init.lua");
              store.put({ enabled: args.enabled }, "meta");
              break;
            case "clearConfig":
              store.delete("file:init.lua");
              store.put({ enabled: false }, "meta");
              break;
            case "clearPlugins":
              store.clear();
              break;
            case "writePlugin": {
              const enc = new TextEncoder();
              store.put(
                {
                  name: args.name,
                  source: "upload",
                  enabled: args.enabled,
                  addedAt: 0,
                  files: args.files.map((f) => ({ path: f.path, data: enc.encode(f.text) })),
                },
                args.name,
              );
              break;
            }
            case "setPluginEnabled": {
              const get = store.get(args.name);
              get.onsuccess = () => {
                const rec = get.result;
                rec.enabled = args.enabled;
                store.put(rec, args.name);
              };
              break;
            }
            case "writeConfigFiles":
              for (const [relpath, content] of Object.entries(args.filesObj)) {
                store.put(content, "file:" + relpath);
              }
              store.put({ enabled: args.enabled }, "meta");
              break;
            default:
              // Unreachable via the six exported wrappers; guards against a
              // future call site passing an unknown op (which would otherwise
              // resolve an empty transaction and silently write nothing).
              db.close();
              reject(new Error("unknown idb op: " + op));
              return;
          }
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => {
            db.close();
            reject(new Error("tx error: " + (tx.error?.message ?? "?")));
          };
        };
      }),
    { storeName, op, args },
  );
}

// Thin call-throughs preserving the original six function names/signatures so
// browser-smoke.mjs's call sites (idbWriteConfig(page, "vim.o.tabstop = 7",
// true), etc.) don't need to change at all.
export const idbWriteConfig = (page, initLua, enabled) =>
  idbTx(page, "config", "writeConfig", { initLua, enabled });

export const idbClearConfig = (page) => idbTx(page, "config", "clearConfig", {});

export const idbClearPlugins = (page) => idbTx(page, "plugins", "clearPlugins", {});

export const idbWritePlugin = (page, record) => idbTx(page, "plugins", "writePlugin", record);

export const idbSetPluginEnabled = (page, name, enabled) =>
  idbTx(page, "plugins", "setPluginEnabled", { name, enabled });

export const idbWriteConfigFiles = (page, filesObj, enabled) =>
  idbTx(page, "config", "writeConfigFiles", { filesObj, enabled });
