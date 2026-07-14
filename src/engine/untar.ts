export interface TarEntry { path: string; type: "file" | "dir"; data: Uint8Array }

const dec = new TextDecoder();
const field = (b: Uint8Array, off: number, len: number) =>
  dec.decode(b.subarray(off, off + len)).replace(/\0.*$/, "");
const octal = (b: Uint8Array, off: number, len: number) =>
  parseInt(field(b, off, len).trim() || "0", 8);

export function untar(bytes: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let pos = 0;
  while (pos + 512 <= bytes.length) {
    const header = bytes.subarray(pos, pos + 512);
    if (header.every((x) => x === 0)) break; // terminator
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const fullPath = prefix ? `${prefix}/${name}` : name;
    pos += 512;
    const dataEnd = pos + size;
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      out.push({ path: fullPath, type: "file", data: bytes.slice(pos, dataEnd) });
    } else if (typeflag === "5") {
      out.push({ path: fullPath, type: "dir", data: new Uint8Array(0) });
    } // other typeflags (pax x/g, gnu L, symlinks): skip payload
    pos += Math.ceil(size / 512) * 512;
  }
  return out;
}
