// Options-page Languages pane: pick the treesitter language pack, which is an
// engine VARIANT — "base" (the default, smaller) or "web" (a superset that
// statically links the web treesitter grammars + queries). The choice is
// exclusive (one engine boots), so the two controls behave like radios. The
// selection is a small UI preference kept in localStorage (nib:languagePack),
// matching the other lightweight toggles (nib:formatOnSave, etc.) rather than
// the config-store meta schema. engine-frame reads it at boot, so a change
// needs an editor-tab reload — surfaced via the shared nib-status line.
type LanguagePack = "base" | "web";
const LANGUAGE_PACK_KEY = "nib:languagePack";

function languagePack(): LanguagePack {
  try {
    return localStorage.getItem(LANGUAGE_PACK_KEY) === "web" ? "web" : "base";
  } catch {
    return "base";
  }
}

function setLanguagePack(pack: LanguagePack): void {
  try {
    localStorage.setItem(LANGUAGE_PACK_KEY, pack);
  } catch {
    // Private-mode / storage-disabled: the selection just won't persist.
  }
}

function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as unknown as T;
}

function status(message: string, kind: "ok" | "err" | "info"): void {
  document.dispatchEvent(new CustomEvent("nib-status", { detail: { message, kind } }));
}

// Reflect the active pack: check the matching radio and reveal its "Active"
// pill (hide the other's).
function reflect(pack: LanguagePack): void {
  el<HTMLInputElement>("lang-pack-base").checked = pack === "base";
  el<HTMLInputElement>("lang-pack-web").checked = pack === "web";
  el<HTMLElement>("lang-pack-base-active").hidden = pack !== "base";
  el<HTMLElement>("lang-pack-web-active").hidden = pack !== "web";
}

export function initLanguagesUI(): void {
  reflect(languagePack());

  const onChoose = (pack: LanguagePack): void => {
    setLanguagePack(pack);
    reflect(pack);
    const name = pack === "web" ? "Web" : "Base";
    status(`Language pack set to ${name} — reload your editor tab to apply.`, "info");
  };

  el<HTMLInputElement>("lang-pack-base").addEventListener("change", () => onChoose("base"));
  el<HTMLInputElement>("lang-pack-web").addEventListener("change", () => onChoose("web"));
}
