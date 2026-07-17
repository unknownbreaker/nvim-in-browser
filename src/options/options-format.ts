// Autoformatting for config files. Lua is formatted with StyLua (the canonical
// Rust formatter, compiled to WASM); Vimscript gets a conservative,
// whitespace-only reindenter (there is no mature Vimscript formatter). Language
// is chosen by file extension. All formatting is best-effort: on any failure the
// caller leaves the code unchanged.
//
// StyLua's prebuilt wasm-bindgen "web" build (stylua_lib_web.js + the ~3.3MB
// stylua_lib_bg.wasm) is copied into the extension by scripts/build.mjs. We
// dynamic-import() the glue and init() it with explicit wasm bytes on first use,
// so the wasm is lazy (never on the options-page startup path) and esbuild never
// has to resolve wasm-bindgen's `new URL(...import.meta.url)` locator.

export type FormatLang = "lua" | "vim";

/** Pick a formatter by file extension, or null when the type is unsupported. */
export function detectFormatLang(name: string): FormatLang | null {
  if (name.endsWith(".lua")) return "lua";
  if (name.endsWith(".vim")) return "vim";
  return null;
}

// --- StyLua (Lua) ------------------------------------------------------------

// Minimal shape of the StyLua wasm-bindgen web module we rely on.
interface StyluaWeb {
  default: (bytes: BufferSource) => Promise<unknown>; // __wbg_init
  formatCode: (code: string, config: StyluaConfig, range: undefined, verify: number) => string;
  Config: { new: () => StyluaConfig };
  IndentType: { Tabs: number; Spaces: number };
  OutputVerification: { Full: number; None: number };
}
interface StyluaConfig {
  indent_type: number;
  indent_width: number;
}

// Cache the initialized module across calls; on failure, clear so a later Format
// click can retry (e.g. a transient fetch failure).
let styluaPromise: Promise<StyluaWeb> | null = null;

async function loadStylua(): Promise<StyluaWeb> {
  if (!styluaPromise) {
    styluaPromise = (async () => {
      const mod = (await import(
        /* @vite-ignore */ chrome.runtime.getURL("stylua_lib_web.js")
      )) as unknown as StyluaWeb;
      // Pass explicit bytes so wasm-bindgen skips its default
      // `new URL('stylua_lib_bg.wasm', import.meta.url)` fetch path.
      const bytes = await (await fetch(chrome.runtime.getURL("stylua_lib_bg.wasm"))).arrayBuffer();
      await mod.default(bytes);
      return mod;
    })();
    styluaPromise.catch(() => {
      styluaPromise = null;
    });
  }
  return styluaPromise;
}

/**
 * Format Lua with StyLua (2-space indent). Rejects (leaving the source for the
 * caller to keep) if the code has a syntax error — StyLua throws rather than
 * emitting corrupt output.
 */
export async function formatLua(code: string): Promise<string> {
  const s = await loadStylua();
  const cfg = s.Config.new();
  cfg.indent_type = s.IndentType.Spaces;
  cfg.indent_width = 2;
  return s.formatCode(code, cfg, undefined, s.OutputVerification.Full);
}

// --- Vimscript reindenter ----------------------------------------------------

// Lines that reduce indent for THEIR OWN line (block closers / middles).
const VIM_DEDENT = /^(end\w*|else|elseif|catch|finally|augroup\s+END)\b/i;
// Lines that increase indent for the lines that FOLLOW (block openers / middles).
// `else`/`elseif`/`catch`/`finally` both dedent their own line and re-indent the
// body, netting the same depth — exactly right for the middle of a block.
const VIM_INDENT_AFTER = /^(if|elseif|else|while|for|function!?|func|try|catch|finally|augroup\s+(?!END)\S)/i;

function bracketDelta(line: string): number {
  let d = 0;
  for (const ch of line) {
    if (ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ")" || ch === "]" || ch === "}") d--;
  }
  return d;
}

/**
 * Conservative Vimscript reindenter. WHITESPACE-ONLY: it never reorders or edits
 * tokens, so it cannot break code — the worst case is imperfect indentation.
 * Reindents by block keywords and net bracket depth (2-space), indents
 * continuation lines (leading backslash) one level deeper, trims trailing
 * whitespace, collapses runs of blank lines, and ensures one trailing newline.
 */
export function formatVim(code: string): string {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let depth = 0;
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, "");
    const trimmed = line.replace(/^[ \t]+/, "");
    if (trimmed === "") {
      out.push("");
      continue;
    }
    // Line continuation: indent one deeper for readability; brackets on it still
    // count so a closing bracket on a continuation line dedents following lines.
    if (trimmed.startsWith("\\")) {
      out.push("  ".repeat(depth + 1) + trimmed);
      depth = Math.max(0, depth + bracketDelta(trimmed));
      continue;
    }
    if (VIM_DEDENT.test(trimmed)) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + trimmed);
    if (VIM_INDENT_AFTER.test(trimmed)) depth++;
    depth = Math.max(0, depth + bracketDelta(trimmed));
  }
  return collapseBlankLines(out);
}

// Collapse 3+ consecutive blank lines to one, drop leading/trailing blanks, and
// end with exactly one trailing newline.
function collapseBlankLines(lines: string[]): string {
  const collapsed: string[] = [];
  let blanks = 0;
  for (const l of lines) {
    if (l === "") {
      blanks++;
      if (blanks <= 1) collapsed.push("");
    } else {
      blanks = 0;
      collapsed.push(l);
    }
  }
  while (collapsed.length && collapsed[0] === "") collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1] === "") collapsed.pop();
  return collapsed.length ? collapsed.join("\n") + "\n" : "";
}
