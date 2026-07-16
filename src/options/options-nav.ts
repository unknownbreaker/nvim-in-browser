// Options-page navigation: a left rail that switches between the Config,
// Plugins, Overview, and Advanced panes (only one visible at a time) and keeps
// small rail badges (installed-plugin count, a config-off dot) in sync. It owns
// only presentation + badge reads — the feature modules (options-config,
// options-plugins, options-status) still own all store writes. Badges refresh
// on each nav click and whenever any module dispatches the `nib-refresh` event
// after a store write.
import { openConfigStore } from "../storage/config-store";
import { openPluginStore } from "../storage/plugin-store";

const configStore = openConfigStore();
const pluginStore = openPluginStore();

function panes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".pane"));
}
function railItems(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".rail-item"));
}

function showPane(name: string): void {
  for (const pane of panes()) {
    pane.classList.toggle("active", pane.dataset.pane === name);
  }
  for (const item of railItems()) {
    item.classList.toggle("active", item.dataset.pane === name);
  }
  // The Overview pane is a live snapshot, so refresh it whenever it's shown.
  if (name === "overview") {
    document.dispatchEvent(new CustomEvent("nib-refresh"));
  }
}

// Plugins badge: installed count. Config badge: a yellow "config won't load"
// dot when the master switch is off. Both reads are wrapped so a store failure
// leaves the badge blank rather than throwing out of the nav.
async function refreshBadges(): Promise<void> {
  const pluginBadge = document.getElementById("badge-plugins");
  if (pluginBadge) {
    try {
      const count = (await pluginStore.list()).length;
      pluginBadge.textContent = count > 0 ? String(count) : "";
    } catch {
      pluginBadge.textContent = "";
    }
  }

  const configBadge = document.getElementById("badge-config");
  if (configBadge) {
    try {
      const { enabled } = await configStore.getMeta();
      configBadge.textContent = enabled ? "" : "●";
      configBadge.style.color = enabled ? "" : "var(--yellow)";
      configBadge.title = enabled ? "" : "Config loading is off — editors boot clean.";
    } catch {
      configBadge.textContent = "";
    }
  }
}

export function initNav(): void {
  for (const item of railItems()) {
    item.addEventListener("click", () => {
      const name = item.dataset.pane;
      if (name) showPane(name);
      void refreshBadges();
    });
  }
  // Other modules dispatch nib-refresh after add/remove/toggle so the badges
  // (and the Overview pane) reflect the change without a page reload.
  document.addEventListener("nib-refresh", () => void refreshBadges());
  void refreshBadges();
}
