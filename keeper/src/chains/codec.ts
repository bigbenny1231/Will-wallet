// Dependency-free helpers: keccak256, base58, hex, EIP-55 checksums.

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, n: number) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(s: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array<bigint>(25);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & M64 & b[((x + 2) % 5) + y]);
    s[0] ^= RC[round];
  }
}

/** Ethereum keccak256 (original Keccak padding 0x01, not NIST SHA3). */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((s[i] >> BigInt(8 * j)) & 0xffn);
  return out;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(str: string): Uint8Array {
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 character ${ch}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of str) { if (ch !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

export const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

/** EIP-55 mixed-case checksum. */
export function toChecksumAddress(addr: string): string {
  const a = addr.toLowerCase().replace(/^0x/, '');
  const h = toHex(keccak256(new TextEncoder().encode(a)));
  return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

/** Ethereum address of a 64-byte uncompressed (x||y) secp256k1 key. */
export function evmAddressFromPubkey64(pk: Uint8Array): string {
  if (pk.length !== 64) throw new Error(`expected 64-byte key, got ${pk.length}`);
  return toChecksumAddress('0x' + toHex(keccak256(pk).slice(12)));
}

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = '1' + s; }
  return s;
}

// ------------------------------------------------------------------ RLP (Ethereum recursive length prefix)

export type RlpItem = Uint8Array | RlpItem[];

/** Minimal big-endian bytes of a non-negative integer (0 -> empty, as RLP wants it). */
export function bigToBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('negative integer in RLP');
  if (n === 0n) return new Uint8Array();
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  return fromHex(h);
}
export const bytesToBig = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt('0x' + toHex(b)));

function rlpLength(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const l = bigToBytes(BigInt(len));
  return Uint8Array.from([offset + 55 + l.length, ...l]);
}
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat([rlpLength(item.length, 0x80), item]);
  }
  const body = concat(item.map(rlpEncode));
  return concat([rlpLength(body.length, 0xc0), body]);
}

/** Decode one RLP item that must span all of `data`. */
export function rlpDecode(data: Uint8Array): RlpItem {
  const [item, end] = rlpDecodeAt(data, 0);
  if (end !== data.length) throw new Error('RLP: trailing bytes');
  return item;
}

function rlpDecodeAt(d: Uint8Array, pos: number): [RlpItem, number] {
  if (pos >= d.length) throw new Error('RLP: truncated');
  const b = d[pos];
  const readLen = (n: number, at: number) => {
    if (at + n > d.length) throw new Error('RLP: truncated');
    return Number(bytesToBig(d.subarray(at, at + n)));
  };
  if (b < 0x80) return [d.subarray(pos, pos + 1), pos + 1];
  if (b < 0xb8) {
    const len = b - 0x80;
    if (pos + 1 + len > d.length) throw new Error('RLP: truncated');
    return [d.subarray(pos + 1, pos + 1 + len), pos + 1 + len];
  }
  if (b < 0xc0) {
    const ll = b - 0xb7;
    const len = readLen(ll, pos + 1);
    const start = pos + 1 + ll;
    if (start + len > d.length) throw new Error('RLP: truncated');
    return [d.subarray(start, start + len), start + len];
  }
  let start: number;
  let len: number;
  if (b < 0xf8) {
    len = b - 0xc0;
    start = pos + 1;
  } else {
    const ll = b - 0xf7;
    len = readLen(ll, pos + 1);
    start = pos + 1 + ll;
  }
  const end = start + len;
  if (end > d.length) throw new Error('RLP: truncated');
  const items: RlpItem[] = [];
  let p = start;
  while (p < end) {
    const [it, np] = rlpDecodeAt(d, p);
    items.push(it);
    p = np;
  }
  if (p !== end) throw new Error('RLP: bad list length');
  return [items, end];
}
