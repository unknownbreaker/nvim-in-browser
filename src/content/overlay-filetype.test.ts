import { describe, expect, it } from "vitest";
import { filetypeForHost } from "./filetype";

describe("filetypeForHost", () => {
  it("maps known markdown-authoring hosts to markdown", () => {
    expect(filetypeForHost("github.com")).toBe("markdown");
    expect(filetypeForHost("www.github.com")).toBe("markdown");
    expect(filetypeForHost("gitlab.com")).toBe("markdown");
    expect(filetypeForHost("news.ycombinator.com")).toBe("markdown");
    expect(filetypeForHost("stackoverflow.com")).toBe("markdown");
    expect(filetypeForHost("reddit.com")).toBe("markdown");
  });

  it("returns undefined for unknown hosts", () => {
    expect(filetypeForHost("example.com")).toBeUndefined();
  });

  it("does not match look-alike / suffix-spoofed hosts", () => {
    // A leading label glued on with a hyphen is a different domain.
    expect(filetypeForHost("evil-github.com")).toBeUndefined();
    // github.com as a subdomain of an attacker domain must not match.
    expect(filetypeForHost("github.com.evil.com")).toBeUndefined();
  });
});
