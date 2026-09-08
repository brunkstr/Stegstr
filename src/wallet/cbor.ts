/** Minimal CBOR decoder (RFC 8949) for Cashu V4 tokens: ints, byte and text strings, arrays, maps, tags, simple values, floats. */
export function decodeCbor(bytes: Uint8Array): unknown {
  let pos = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (n: number) => { if (pos + n > bytes.length) throw new Error("CBOR: truncated"); };
  function readLen(info: number): number {
    if (info < 24) return info;
    if (info === 24) { need(1); return bytes[pos++]; }
    if (info === 25) { need(2); const v = view.getUint16(pos); pos += 2; return v; }
    if (info === 26) { need(4); const v = view.getUint32(pos); pos += 4; return v; }
    if (info === 27) { need(8); const v = Number(view.getBigUint64(pos)); pos += 8; return v; }
    throw new Error("CBOR: indefinite lengths unsupported");
  }
  function item(): unknown {
    need(1);
    const b = bytes[pos++]; const major = b >> 5; const info = b & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); need(n); const v = bytes.slice(pos, pos + n); pos += n; return v; }
      case 3: { const n = readLen(info); need(n); const v = new TextDecoder().decode(bytes.subarray(pos, pos + n)); pos += n; return v; }
      case 4: { const n = readLen(info); const a: unknown[] = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: { const n = readLen(info); const o: Record<string, unknown> = {}; for (let i = 0; i < n; i++) { const k = item(); o[String(k)] = item(); } return o; }
      case 6: { readLen(info); return item(); } // tag: ignore, return content
      case 7: {
        if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; if (info === 23) return undefined;
        if (info === 25) { need(2); const h = view.getUint16(pos); pos += 2; return halfToNumber(h); }
        if (info === 26) { need(4); const v = view.getFloat32(pos); pos += 4; return v; }
        if (info === 27) { need(8); const v = view.getFloat64(pos); pos += 8; return v; }
        if (info === 24) { need(1); return bytes[pos++]; }
        return readLen(info);
      }
      default: throw new Error("CBOR: bad major type");
    }
  }
  const v = item();
  if (pos !== bytes.length) throw new Error("CBOR: trailing bytes");
  return v;
}

function halfToNumber(h: number): number {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** Minimal CBOR encoder (used by tests and for re-serialising tokens). */
export function encodeCbor(value: unknown): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 0x100) out.push((major << 5) | 24, n);
    else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 0xff);
    else out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  };
  const enc = (v: unknown) => {
    if (v === false) out.push(0xf4); else if (v === true) out.push(0xf5); else if (v === null) out.push(0xf6); else if (v === undefined) out.push(0xf7);
    else if (typeof v === "number") { if (Number.isInteger(v)) { if (v >= 0) head(0, v); else head(1, -1 - v); } else { out.push(0xfb); const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); out.push(...b); } }
    else if (typeof v === "string") { const b = new TextEncoder().encode(v); head(3, b.length); out.push(...b); }
    else if (v instanceof Uint8Array) { head(2, v.length); out.push(...v); }
    else if (Array.isArray(v)) { head(4, v.length); v.forEach(enc); }
    else if (typeof v === "object") { const e = Object.entries(v as Record<string, unknown>); head(5, e.length); for (const [k, x] of e) { enc(k); enc(x); } }
    else throw new Error("CBOR: cannot encode " + typeof v);
  };
  enc(value);
  return Uint8Array.from(out);
}
