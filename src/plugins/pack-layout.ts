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
