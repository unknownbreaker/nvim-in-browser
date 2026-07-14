import { describe, expect, it } from "vitest";
import { keyEventToNvim, isEscapeChord } from "./keymap";

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

describe("keyEventToNvim", () => {
  it("passes printable chars through", () => {
    expect(keyEventToNvim(ev("a"))).toBe("a");
    expect(keyEventToNvim(ev("A", { shiftKey: true }))).toBe("A");
  });
  it("escapes < as <lt>", () => {
    expect(keyEventToNvim(ev("<"))).toBe("<lt>");
  });
  it("maps special keys", () => {
    expect(keyEventToNvim(ev("Escape"))).toBe("<Esc>");
    expect(keyEventToNvim(ev("Enter"))).toBe("<CR>");
    expect(keyEventToNvim(ev("Backspace"))).toBe("<BS>");
    expect(keyEventToNvim(ev("Tab"))).toBe("<Tab>");
    expect(keyEventToNvim(ev("ArrowLeft"))).toBe("<Left>");
  });
  it("applies modifiers", () => {
    expect(keyEventToNvim(ev("w", { ctrlKey: true }))).toBe("<C-w>");
    expect(keyEventToNvim(ev("x", { altKey: true }))).toBe("<M-x>");
    expect(keyEventToNvim(ev("Enter", { ctrlKey: true }))).toBe("<C-CR>");
    expect(keyEventToNvim(ev("R", { ctrlKey: true, shiftKey: true }))).toBe("<C-S-R>");
  });
  it("ignores bare modifier keys", () => {
    expect(keyEventToNvim(ev("Shift", { shiftKey: true }))).toBeNull();
    expect(keyEventToNvim(ev("Control", { ctrlKey: true }))).toBeNull();
  });
  it("detects the escape chord and never translates it", () => {
    const chord = ev("Escape", { ctrlKey: true, shiftKey: true });
    expect(isEscapeChord(chord)).toBe(true);
    expect(keyEventToNvim(chord)).toBeNull();
  });
  it("keeps modifiers on <", () => {
    expect(keyEventToNvim(ev("<", { ctrlKey: true }))).toBe("<C-lt>");
    expect(keyEventToNvim(ev("<", { ctrlKey: true, shiftKey: true }))).toBe("<C-S-lt>");
  });
  it("covers additional pass-through cases", () => {
    expect(keyEventToNvim(ev(" "))).toBe("<Space>");
    expect(keyEventToNvim(ev("Tab", { shiftKey: true }))).toBe("<S-Tab>");
    expect(keyEventToNvim(ev("Dead"))).toBeNull();
    expect(keyEventToNvim(ev("a", { metaKey: true }))).toBe("<D-a>");
  });
});
