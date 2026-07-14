import { describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { NvimRpc } from "./rpc";

describe("NvimRpc", () => {
  it("encodes a request and resolves its response", async () => {
    const sent: Uint8Array[] = [];
    const rpc = new NvimRpc((b) => sent.push(b));
    const p = rpc.request("nvim_eval", ["1+1"]);
    // response: [1, msgid, error, result]
    rpc.feed(encode([1, 0, null, 2]));
    await expect(p).resolves.toBe(2);
    expect(sent).toHaveLength(1);
  });

  it("rejects on error response", async () => {
    const rpc = new NvimRpc(() => {});
    const p = rpc.request("nvim_eval", ["bogus("]);
    rpc.feed(encode([1, 0, [1, "parse error"], null]));
    await expect(p).rejects.toThrow("parse error");
  });

  it("dispatches notifications and survives split chunks", () => {
    const rpc = new NvimRpc(() => {});
    const seen = vi.fn();
    rpc.onNotification = seen;
    const bytes = encode([2, "redraw", [["flush", []]]]);
    rpc.feed(bytes.slice(0, 5));
    rpc.feed(bytes.slice(5));
    expect(seen).toHaveBeenCalledWith("redraw", [["flush", []]]);
  });

  it("handles two messages in one chunk", () => {
    const rpc = new NvimRpc(() => {});
    const seen = vi.fn();
    rpc.onNotification = seen;
    const a = encode([2, "a", []]);
    const b = encode([2, "b", []]);
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    rpc.feed(joined);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
