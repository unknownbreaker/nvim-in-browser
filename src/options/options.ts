// Options page shell: owns the shared status line and wires the config + plugin
// UI modules. All feature logic lives in options-config.ts / options-plugins.ts.
import { initConfigUI } from "./options-config";
import { initPluginsUI } from "./options-plugins";
import { initNav } from "./options-nav";
import { initStatusUI } from "./options-status";

const statusEl = document.getElementById("status") as HTMLDivElement | null;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(message: string, kind: "ok" | "err" | "info", autoClear: boolean): void {
  if (!statusEl) return;
  if (statusTimer !== undefined) {
    clearTimeout(statusTimer);
    statusTimer = undefined;
  }
  statusEl.textContent = message;
  statusEl.className = kind;
  if (autoClear) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "";
      statusTimer = undefined;
    }, 5000);
  }
}

document.addEventListener("nib-status", (e) => {
  const d = (e as CustomEvent<{ message: string; kind: "ok" | "err" | "info" }>).detail;
  setStatus(d.message, d.kind, d.kind !== "err");
});

initNav();
initConfigUI();
initPluginsUI();
initStatusUI();
