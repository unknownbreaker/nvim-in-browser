// Shared DOM/status/pref helpers for the options-page panes — extracted from
// verbatim duplicates in options-config.ts, options-plugins.ts, and
// options-languages.ts (pure extraction; no behavior change).

// --- Custom-event names --------------------------------------------------
// Centralized so a dispatch/listener typo can't silently no-op. Every pane's
// dispatch and every addEventListener site uses these constants.
export const EVT_STATUS = "nib-status";
export const EVT_REFRESH = "nib-refresh";
export const EVT_EDITOR_SET = "nib-editor-set";

// --- DOM lookup ------------------------------------------------------------
export function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as unknown as T;
}

// --- Shared status line + shell refresh ------------------------------------
// Reuse the page's status line (owned by options.ts) via a tiny event so
// individual panes don't duplicate the status widget.
export function emitStatus(message: string, kind: "ok" | "err" | "info"): void {
  document.dispatchEvent(new CustomEvent(EVT_STATUS, { detail: { message, kind } }));
}
// Nudge the nav badges + Overview pane to re-read after a store write.
export function refreshShell(): void {
  document.dispatchEvent(new CustomEvent(EVT_REFRESH));
}

// --- Error stringifier -------------------------------------------------------
export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- localStorage-backed UI-preference factories ----------------------------
// Each bakes in the private-mode try/catch (localStorage can throw when
// storage is disabled) — callers just get()/set().
export function makeBoolPref(key: string, dflt: boolean): { get(): boolean; set(v: boolean): void } {
  return {
    get(): boolean {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? dflt : raw === "1";
      } catch {
        return dflt;
      }
    },
    set(v: boolean): void {
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        // Private-mode / storage-disabled: the toggle just won't persist.
      }
    },
  };
}

export function makeStringPref<T extends string>(
  key: string,
  dflt: T,
  allowed?: readonly T[],
): { get(): T; set(v: T): void } {
  return {
    get(): T {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return dflt;
        if (allowed && !allowed.includes(raw as T)) return dflt;
        return raw as T;
      } catch {
        return dflt;
      }
    },
    set(v: T): void {
      try {
        localStorage.setItem(key, v);
      } catch {
        // Private-mode / storage-disabled: the selection just won't persist.
      }
    },
  };
}
