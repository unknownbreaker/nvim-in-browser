import { Decoder, encode } from "@msgpack/msgpack";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * Accesses the private `pos` field that @msgpack/msgpack's Decoder tracks
 * internally while iterating `decodeMulti`. It is `private` in the type
 * declarations (for API-surface reasons) but is a plain, readable property
 * at runtime, and it's the only way to know how many bytes of the input
 * buffer were actually consumed by the messages decoded so far — needed to
 * retain the correct undecoded tail across `feed()` calls.
 */
function consumedBytes(decoder: Decoder<undefined>): number {
  return (decoder as unknown as { pos: number }).pos;
}

// Return type is annotated as the bare `Uint8Array` (i.e.
// Uint8Array<ArrayBufferLike>), not the narrower Uint8Array<ArrayBuffer> that
// `new Uint8Array(n)` infers on its own — chunks passed to feed() may be
// views backed by any ArrayBufferLike (e.g. results of .slice()/.subarray()).
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const joined: Uint8Array = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

/**
 * Frames msgpack-RPC messages over an arbitrary byte transport (nvim --embed
 * speaks msgpack-RPC over stdin/stdout). Runs in both page and worker
 * contexts, so it must not depend on DOM or `chrome.*` APIs.
 */
export class NvimRpc {
  onNotification: (method: string, args: unknown[]) => void = () => {};
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly decoder = new Decoder();

  constructor(private readonly send: (bytes: Uint8Array) => void) {}

  request(method: string, params: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    this.send(encode([0, id, method, params]));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown[]): void {
    this.send(encode([2, method, params]));
  }

  /**
   * Accepts an arbitrary chunk of bytes — which may contain part of a
   * message, multiple whole messages, or a message ending exactly at the
   * chunk boundary — and dispatches every message it can fully decode, in
   * stream order. Any undecoded trailing bytes are retained and prepended to
   * the next chunk.
   *
   * Implementation note: `decodeMulti` yields each complete message and
   * throws a RangeError once it hits a truncated tail. We track how many
   * bytes were consumed via the decoder's internal `pos` (see
   * `consumedBytes` above) so we can slice off exactly the undecoded
   * remainder rather than re-decoding or discarding anything.
   */
  feed(chunk: Uint8Array): void {
    this.buffer = concat(this.buffer, chunk);
    let consumed = 0;
    try {
      for (const msg of this.decoder.decodeMulti(this.buffer)) {
        consumed = consumedBytes(this.decoder);
        this.dispatch(msg);
      }
      this.buffer = new Uint8Array(0);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      this.buffer = this.buffer.subarray(consumed);
    }
  }

  private dispatch(msg: unknown): void {
    const arr = msg as unknown[];
    if (arr[0] === 1) {
      const [, id, err, result] = arr as [number, number, unknown, unknown];
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (err) p.reject(new Error(String((err as unknown[])[1] ?? err)));
      else p.resolve(result);
    } else if (arr[0] === 2) {
      const [, method, params] = arr as [number, string, unknown[]];
      this.onNotification(method, params);
    }
  }
}
