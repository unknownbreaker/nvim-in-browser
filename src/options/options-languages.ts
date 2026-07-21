// Options-page Languages pane: pick the treesitter language pack, which is an
// engine VARIANT — "base" (the default, smaller) or "web" (a superset that
// statically links the web treesitter grammars + queries). The choice is
// exclusive (one engine boots), so the two controls behave like radios. The
// selection is a small UI preference kept in localStorage (nib:languagePack),
// matching the other lightweight toggles (nib:formatOnSave, etc.) rather than
// the config-store meta schema. engine-frame reads it at boot, so a change
// needs an editor-tab reload — surfaced via the shared nib-status line.
import { el, emitStatus as status, makeStringPref } from "./options-dom";

type LanguagePack = "base" | "web";
const languagePackPref = makeStringPref<LanguagePack>("nib:languagePack", "base", ["base", "web"]);
const languagePack = (): LanguagePack => languagePackPref.get();
const setLanguagePack = (pack: LanguagePack): void => languagePackPref.set(pack);

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
