import { describe, it, expect } from "vitest";
import { detectFormatLang, formatVim } from "./options-format";

describe("detectFormatLang", () => {
  it("maps .lua and .vim, rejects others", () => {
    expect(detectFormatLang("init.lua")).toBe("lua");
    expect(detectFormatLang("lua/opts.lua")).toBe("lua");
    expect(detectFormatLang("plugin/foo.vim")).toBe("vim");
    expect(detectFormatLang("README.md")).toBeNull();
    expect(detectFormatLang("noext")).toBeNull();
    expect(detectFormatLang("weird.luau")).toBeNull(); // only exact .lua/.vim
  });
});

describe("formatVim reindenter", () => {
  it("indents nested block keywords by two spaces", () => {
    const src = ["function! Foo()", "if x", "echo 'hi'", "endif", "endfunction"].join("\n");
    expect(formatVim(src)).toBe(
      ["function! Foo()", "  if x", "    echo 'hi'", "  endif", "endfunction", ""].join("\n"),
    );
  });

  it("keeps else/elseif at the block's outer level", () => {
    const src = ["if a", "echo 1", "elseif b", "echo 2", "else", "echo 3", "endif"].join("\n");
    expect(formatVim(src)).toBe(
      ["if a", "  echo 1", "elseif b", "  echo 2", "else", "  echo 3", "endif", ""].join("\n"),
    );
  });

  it("indents continuation lines deeper than their opening line", () => {
    // The opening `[` bumps depth, and continuation lines sit one level deeper
    // again — so list items land at 4 spaces here. The exact depth matters less
    // than that it's consistent and idempotent (covered below).
    const src = ["let g:x = [", "\\ 1,", "\\ 2,", "\\ ]"].join("\n");
    const out = formatVim(src).split("\n");
    expect(out[0]).toBe("let g:x = [");
    expect(out[1]).toBe("    \\ 1,");
    expect(out[2]).toBe("    \\ 2,");
    expect(out[3]).toBe("    \\ ]");
  });

  it("trims trailing whitespace and collapses blank runs", () => {
    const src = ["let a = 1   ", "", "", "", "let b = 2\t"].join("\n");
    expect(formatVim(src)).toBe(["let a = 1", "", "let b = 2", ""].join("\n"));
  });

  it("ensures exactly one trailing newline and no leading blanks", () => {
    expect(formatVim("\n\nlet a = 1")).toBe("let a = 1\n");
    expect(formatVim("let a = 1\n\n\n")).toBe("let a = 1\n");
  });

  it("normalizes CRLF to LF", () => {
    expect(formatVim("if a\r\necho 1\r\nendif")).toBe("if a\n  echo 1\nendif\n");
  });

  it("is idempotent", () => {
    const samples = [
      "function! Foo()\nif x\necho 'hi'\nendif\nendfunction",
      "if a\necho 1\nelseif b\necho 2\nelse\necho 3\nendif",
      "augroup Foo\nautocmd!\nautocmd BufRead * echo 1\naugroup END",
      "let g:x = {\n\\ 'a': 1,\n\\ }",
    ];
    for (const s of samples) {
      const once = formatVim(s);
      expect(formatVim(once)).toBe(once);
    }
  });

  it("never drops non-whitespace content (whitespace-only transform)", () => {
    const src = "let a=1\n  function! B(x,y)\n  return x+y\n  endfunction";
    const strip = (s: string) => s.replace(/\s+/g, "");
    expect(strip(formatVim(src))).toBe(strip(src));
  });

  it("handles an empty buffer", () => {
    expect(formatVim("")).toBe("");
    expect(formatVim("\n\n")).toBe("");
  });
});
