// Syntax-highlight overlay for the config editor. Rather than replacing the
// <textarea id="editor"> (which options-config.ts drives for autosave / dirty
// tracking), we paint a colored <pre id="editor-highlight"> directly BEHIND a
// transparent-text textarea, pixel-aligned via identical box metrics. The
// textarea keeps a visible caret; the coloring shows through it.
//
// SYNC: repaint on textarea "input" (typing) and on the custom "nib-editor-set"
// event (options-config sets editor.value programmatically in select/onFetch/
// onClear WITHOUT firing "input"); mirror scroll offsets on "scroll".

// Lua + a small Vimscript keyword subset. Correctness over completeness: the
// only hard rule is that highlight() never corrupts the displayed text.
const KEYWORDS = new Set([
  // Lua
  "local", "function", "end", "if", "then", "else", "elseif", "for", "while",
  "do", "return", "require", "nil", "true", "false", "and", "or", "not", "in",
  "repeat", "until", "break",
  // Vimscript
  "set", "let", "call", "autocmd", "endfunction",
]);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function span(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function isWordChar(c: string): boolean {
  return c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c >= "0" && c <= "9" || c === "_";
}

// A `"` starts a Vim line comment only when it's the first non-blank on its
// line (Vim comments are ambiguous with Lua strings otherwise — keep it simple).
function isVimCommentStart(code: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (code[k] === " " || code[k] === "\t")) k--;
  return k < 0 || code[k] === "\n";
}

// Tokenize `code` into HTML: every source character is HTML-escaped and emitted
// exactly once (inside a <span class="tok-..."> or as plain text), so the <pre>'s
// visible text equals the source. Handles Lua/Vim line + block comments, single/
// double/long strings, numbers, and the keyword set above.
export function highlight(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];

    // Lua comments: --[[ block ]] or -- line
    if (c === "-" && code[i + 1] === "-") {
      if (code[i + 2] === "[" && code[i + 3] === "[") {
        const close = code.indexOf("]]", i + 4);
        const end = close === -1 ? n : close + 2;
        out += span("tok-comment", code.slice(i, end));
        i = end;
        continue;
      }
      let j = i;
      while (j < n && code[j] !== "\n") j++;
      out += span("tok-comment", code.slice(i, j));
      i = j;
      continue;
    }

    // Vim line comment: leading `"` on a line
    if (c === '"' && isVimCommentStart(code, i)) {
      let j = i;
      while (j < n && code[j] !== "\n") j++;
      out += span("tok-comment", code.slice(i, j));
      i = j;
      continue;
    }

    // Strings: "..." or '...' (stop at unescaped quote or line end)
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === c) { j++; break; }
        if (code[j] === "\n") break;
        j++;
      }
      out += span("tok-string", code.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }

    // Lua long string [[ ... ]]
    if (c === "[" && code[i + 1] === "[") {
      const close = code.indexOf("]]", i + 2);
      const end = close === -1 ? n : close + 2;
      out += span("tok-string", code.slice(i, end));
      i = end;
      continue;
    }

    // Numbers (incl. 0x.., decimals)
    if ((c >= "0" && c <= "9") || (c === "." && code[i + 1] >= "0" && code[i + 1] <= "9")) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX._]/.test(code[j])) j++;
      out += span("tok-number", code.slice(i, j));
      i = j;
      continue;
    }

    // Words / keywords
    if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(code[j])) j++;
      const word = code.slice(i, j);
      out += KEYWORDS.has(word) ? span("tok-keyword", word) : escapeHtml(word);
      i = j;
      continue;
    }

    // Plain character
    out += escapeHtml(c);
    i++;
  }
  return out;
}

export function initEditorHighlight(): void {
  const textarea = document.getElementById("editor") as HTMLTextAreaElement | null;
  if (!textarea) return;
  if (document.getElementById("editor-highlight")) return; // already wired

  const parent = textarea.parentNode;
  if (!parent) return;

  // Wrap the textarea in a positioned container and slip the <pre> behind it.
  const wrap = document.createElement("div");
  wrap.className = "editor-highlight-wrap";
  parent.insertBefore(wrap, textarea);

  const pre = document.createElement("pre");
  pre.id = "editor-highlight";
  pre.setAttribute("aria-hidden", "true");
  wrap.append(pre);
  wrap.append(textarea); // moves the textarea into the wrapper, in front of the pre

  const paint = (): void => {
    const code = textarea.value;
    // A trailing newline keeps the last line aligned (a textarea renders a blank
    // final line when the content ends in "\n"; without one, add it to match).
    pre.innerHTML = code.endsWith("\n") ? highlight(code) : highlight(code) + "\n";
  };

  textarea.addEventListener("input", paint);
  textarea.addEventListener("scroll", () => {
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
  });
  // Repaint after a programmatic value set (select/onFetch/onClear).
  document.addEventListener("nib-editor-set", paint);

  paint(); // initial paint (in case this runs after the first select's event)
}
