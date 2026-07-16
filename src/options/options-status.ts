// Options-page Overview pane: a small read-only dashboard of stat cards showing
// the master switch, config file count, enabled/total plugins, and whether a
// GitHub token is saved. It never writes any store — it only reads them and
// re-renders on the `nib-refresh` event (dispatched by the other modules after
// a write, and by the nav when this pane is shown). Every store read is wrapped
// so a failure shows a dash rather than blanking the page.
import { openConfigStore } from "../storage/config-store";
import { openPluginStore } from "../storage/plugin-store";
import { openTokenStore } from "../storage/token-store";

const configStore = openConfigStore();
const pluginStore = openPluginStore();
const tokenStore = openTokenStore();

const DASH = "—";

function statCard(label: string, value: string, opts?: { cls?: string; sub?: string }): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "stat";

  const labelEl = document.createElement("div");
  labelEl.className = "stat-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = opts?.cls ? `stat-value ${opts.cls}` : "stat-value";
  valueEl.textContent = value;

  card.append(labelEl, valueEl);
  if (opts?.sub) {
    const subEl = document.createElement("div");
    subEl.className = "stat-sub";
    subEl.textContent = opts.sub;
    card.append(subEl);
  }
  return card;
}

async function configCard(): Promise<HTMLDivElement> {
  try {
    const { enabled } = await configStore.getMeta();
    const fileCount = Object.keys(await configStore.loadFiles()).length;
    const files = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
    return statCard("Config", enabled ? "On" : "Off", {
      cls: enabled ? "on" : "off",
      sub: files,
    });
  } catch {
    return statCard("Config", DASH);
  }
}

async function pluginsCard(): Promise<HTMLDivElement> {
  try {
    const plugins = await pluginStore.list();
    const enabled = plugins.filter((p) => p.enabled).length;
    return statCard("Plugins", `${enabled} / ${plugins.length} enabled`);
  } catch {
    return statCard("Plugins", DASH);
  }
}

async function tokenCard(): Promise<HTMLDivElement> {
  try {
    const has = await tokenStore.has();
    return statCard("GitHub token", has ? "Saved" : "Not set", {
      cls: has ? "on" : "off",
    });
  } catch {
    return statCard("GitHub token", DASH);
  }
}

export async function refreshStatus(): Promise<void> {
  const body = document.getElementById("overview-body");
  if (!body) return;

  const [cfg, plugins, token] = await Promise.all([configCard(), pluginsCard(), tokenCard()]);

  const grid = document.createElement("div");
  grid.className = "stat-grid";
  grid.append(cfg, plugins, token);

  const note = document.createElement("div");
  note.className = "note";
  note.style.borderLeftColor = "var(--accent)";
  note.textContent =
    "Runtime status (safe-mode recovery, memory guard) shows in the editor tab itself — the options page runs no engine.";

  body.replaceChildren(grid, note);
}

export function initStatusUI(): void {
  document.addEventListener("nib-refresh", () => void refreshStatus());
  void refreshStatus();
}
