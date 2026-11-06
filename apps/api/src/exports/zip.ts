// A small ZIP writer for exports (docs/plan.md §1.36): stored entries (no compression), names in
// UTF-8, and ZIP64 records once an entry, an offset or the entry count passes the classic limits.
// Every entry's size and CRC-32 are known before its header is written, so the whole archive's
// size is known up front and it can be streamed into R2 (which needs the length) piece by piece.

// DECISION: entries are stored, not deflated. A table's CSV is written page by page in separate
// Workflow steps and the documents (PDFs, images) are compressed already; storing lets each page
// be appended as it is, its CRC carried from step to step, and the final step only copies bytes.

const encoder = new TextEncoder();

const LIMIT_32 = 0xffffffff;
const LIMIT_16 = 0xffff;
const UTF8_FLAG = 0x0800;
const VERSION_CLASSIC = 20;
const VERSION_ZIP64 = 45;

let table: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 (the ZIP one) of `bytes`, continuing from `previous` (the CRC of what came before). */
export function crc32(bytes: Uint8Array, previous = 0): number {
  const t = crcTable();
  let c = (previous ^ LIMIT_32) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (t[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ LIMIT_32) >>> 0;
}

export interface ZipEntry {
  /** The path inside the archive, `/`-separated. */
  name: string;
  size: number;
  crc: number;
}

export interface ZipPlan {
  /** Each entry's local header, in order; its bytes follow it. */
  headers: Uint8Array[];
  /** The central directory and the end records. */
  trailer: Uint8Array;
  /** The archive's total size in bytes. */
  size: number;
}

/** MS-DOS time and date, the only ones a ZIP header has room for (local time is taken as UTC). */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(at.getUTCFullYear(), 1980);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

class Writer {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private at = 0;
  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(v: number) {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
    return this;
  }
  u32(v: number) {
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(v: number) {
    this.view.setBigUint64(this.at, BigInt(v), true);
    this.at += 8;
    return this;
  }
  raw(b: Uint8Array) {
    this.bytes.set(b, this.at);
    this.at += b.length;
    return this;
  }
}

/**
 * The headers and trailer for `entries`, in order. `zip64: "always"` writes ZIP64 records even when
 * nothing needs them (tests use it to check those records without gigabytes of data).
 */
export function planZip(
  entries: readonly ZipEntry[],
  modified: Date,
  options: { zip64?: "auto" | "always" } = {},
): ZipPlan {
  const always = options.zip64 === "always";
  const { time, date } = dosTime(modified);
  const headers: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = encoder.encode(e.name);
    const bigSize = always || e.size >= LIMIT_32;
    const bigOffset = always || offset >= LIMIT_32;
    const local = new Writer(30 + name.length + (bigSize ? 20 : 0))
      .u32(0x04034b50)
      .u16(bigSize ? VERSION_ZIP64 : VERSION_CLASSIC)
      .u16(UTF8_FLAG)
      .u16(0)
      .u16(time)
      .u16(date)
      .u32(e.crc)
      .u32(bigSize ? LIMIT_32 : e.size)
      .u32(bigSize ? LIMIT_32 : e.size)
      .u16(name.length)
      .u16(bigSize ? 20 : 0)
      .raw(name);
    if (bigSize) local.u16(0x0001).u16(16).u64(e.size).u64(e.size);
    headers.push(local.bytes);

    const big = bigSize || bigOffset;
    const cd = new Writer(46 + name.length + (big ? 28 : 0))
      .u32(0x02014b50)
      .u16(big ? VERSION_ZIP64 : VERSION_CLASSIC)
      .u16(big ? VERSION_ZIP64 : VERSION_CLASSIC)
      .u16(UTF8_FLAG)
      .u16(0)
      .u16(time)
      .u16(date)
      .u32(e.crc)
      .u32(big ? LIMIT_32 : e.size)
      .u32(big ? LIMIT_32 : e.size)
      .u16(name.length)
      .u16(big ? 28 : 0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(big ? LIMIT_32 : offset)
      .raw(name);
    // With every field at its sentinel, the extra field carries all three, in this order.
    if (big) cd.u16(0x0001).u16(24).u64(e.size).u64(e.size).u64(offset);
    central.push(cd.bytes);
    offset += local.bytes.length + e.size;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const cdOffset = offset;
  const count = entries.length;
  const big = always || count >= LIMIT_16 || cdSize >= LIMIT_32 || cdOffset >= LIMIT_32;
  const end: Uint8Array[] = [];
  if (big) {
    end.push(
      new Writer(56)
        .u32(0x06064b50)
        .u64(44)
        .u16(VERSION_ZIP64)
        .u16(VERSION_ZIP64)
        .u32(0)
        .u32(0)
        .u64(count)
        .u64(count)
        .u64(cdSize)
        .u64(cdOffset).bytes,
      new Writer(20)
        .u32(0x07064b50)
        .u32(0)
        .u64(cdOffset + cdSize)
        .u32(1).bytes,
    );
  }
  end.push(
    new Writer(22)
      .u32(0x06054b50)
      .u16(0)
      .u16(0)
      .u16(big ? LIMIT_16 : count)
      .u16(big ? LIMIT_16 : count)
      .u32(big ? LIMIT_32 : cdSize)
      .u32(big ? LIMIT_32 : cdOffset)
      .u16(0).bytes,
  );
  const trailer = concat([...central, ...end]);
  return { headers, trailer, size: offset + trailer.length };
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A whole archive in memory, for small exports answered in one request. */
export function zipSync(
  files: readonly { name: string; bytes: Uint8Array }[],
  modified: Date,
  options: { zip64?: "auto" | "always" } = {},
): Uint8Array {
  const plan = planZip(
    files.map((f) => ({ name: f.name, size: f.bytes.length, crc: crc32(f.bytes) })),
    modified,
    options,
  );
  const parts: Uint8Array[] = [];
  files.forEach((f, i) => parts.push(plan.headers[i] as Uint8Array, f.bytes));
  parts.push(plan.trailer);
  return concat(parts);
}
