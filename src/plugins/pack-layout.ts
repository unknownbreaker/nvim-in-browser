// Pure mapping: enabled plugins -> absolute WASI FS entries under the Neovim
// site pack "start" dir, which nvim auto-sources at startup (that dir is on the
// default packpath). Consumed by engine-frame's resolveBoot, which hands the
// entries to nvim-host's configFiles mechanism (written before instantiate).
import type { PluginRecord } from "../storage/plugin-store";

// HOME=/home, XDG_DATA_HOME=/home/.local/share (see NVIM_ENV in nvim-host.ts);
// $XDG_DATA_HOME/nvim/site is on the default packpath.
export const PACK_BASE = "/home/.local/share/nvim/site/pack/plugins/start/";

export function pluginsToConfigFiles(
  plugins: PluginRecord[],
): { path: string; data: Uint8Array }[] {
  const out: { path: string; data: Uint8Array }[] = [];
  for (const p of plugins) {
    if (!p.enabled) continue;
    for (const f of p.files) {
      out.push({ path: `${PACK_BASE}${p.name}/${f.path}`, data: f.data });
    }
  }
  return out;
}

// The "opt" sibling of PACK_BASE: plugins staged here do NOT auto-load at boot
// (unlike `start/`); they load only on an explicit `:packadd <name>`. The compat
// verifier stages a candidate here so it can install a recording prelude BEFORE
// the plugin runs, then packadd it and observe what it tried to do.
export const OPT_BASE = "/home/.local/share/nvim/site/pack/plugins/opt/";

// Map one plugin's files to absolute WASI FS entries under the site pack "opt"
// dir. Pure mirror of the per-plugin half of pluginsToConfigFiles, but rooted at
// OPT_BASE and taking the files directly (no enabled filtering — the caller has
// already chosen exactly one candidate to verify).
export function pluginFilesToOpt(
  name: string,
  files: { path: string; data: Uint8Array }[],
): { path: string; data: Uint8Array }[] {
  return files.map((f) => ({ path: `${OPT_BASE}${name}/${f.path}`, data: f.data }));
}
