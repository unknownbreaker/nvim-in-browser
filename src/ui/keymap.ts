type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">;

const SPECIAL: Record<string, string> = {
  Escape: "Esc", Enter: "CR", Backspace: "BS", Tab: "Tab", Delete: "Del",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
  " ": "Space",
};
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

export function isEscapeChord(ev: KeyLike): boolean {
  return ev.key === "Escape" && ev.ctrlKey && ev.shiftKey;
}

export function keyEventToNvim(ev: KeyLike): string | null {
  if (isEscapeChord(ev)) return null;
  if (MODIFIER_KEYS.has(ev.key)) return null;
  const special = SPECIAL[ev.key];
  const isPrintable = !special && ev.key.length === 1;
  if (!special && !isPrintable) return null;

  let mods = "";
  if (ev.ctrlKey) mods += "C-";
  if (ev.altKey) mods += "M-";
  if (ev.metaKey) mods += "D-";
  // Shift is only explicit for special keys or when combined with other mods;
  // printable chars already carry case ("A" vs "a").
  if (ev.shiftKey && (special || mods)) {
    if (!(isPrintable && !mods)) mods += "S-";
  }
  // Reorder to nvim's canonical C-S / C-M order: C, S, M, D
  const order = ["C-", "S-", "M-", "D-"];
  const present = order.filter((m) => mods.includes(m));
  mods = present.join("");

  let base = special ?? ev.key;
  if (base === "<") base = "lt";
  if (!mods && isPrintable && ev.key !== "<") return base;
  return `<${mods}${base}>`;
}
