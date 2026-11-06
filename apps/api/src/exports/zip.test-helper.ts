// A ZIP reader for the export tests: the central directory (with ZIP64 records), each local header,
// and every entry's CRC checked with Node's own zlib.crc32, not the writer's.

import { crc32 as zlibCrc32 } from "node:zlib";

export function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => Number(view.getBigUint64(at, true));
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  let count = u16(eocd + 10);
  let cdSize = u32(eocd + 12);
  let cdOffset = u32(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (u32(locator) !== 0x07064b50) throw new Error("no zip64 locator");
    const z64 = u64(locator + 8);
    if (u32(z64) !== 0x06064b50) throw new Error("no zip64 end record");
    count = u64(z64 + 32);
    cdSize = u64(z64 + 40);
    cdOffset = u64(z64 + 48);
  }
  if (cdOffset + cdSize > eocd) throw new Error("central directory out of place");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const out = new Map<string, Uint8Array>();
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (u32(at) !== 0x02014b50) throw new Error(`bad central header ${n}`);
    if ((u16(at + 8) & 0x0800) === 0) throw new Error("names must be flagged UTF-8");
    if (u16(at + 10) !== 0) throw new Error("entries are stored");
    const crc = u32(at + 16);
    let size = u32(at + 24);
    const nameLen = u16(at + 28);
    const extraLen = u16(at + 30);
    const commentLen = u16(at + 32);
    let offset = u32(at + 42);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen));
    let e = at + 46 + nameLen;
    const end = e + extraLen;
    while (e < end) {
      const id = u16(e);
      const len = u16(e + 2);
      if (id === 0x0001) {
        let f = e + 4;
        if (size === 0xffffffff) {
          size = u64(f);
          f += 16; // uncompressed, then compressed (the same: stored)
        }
        if (offset === 0xffffffff) offset = u64(f);
      }
      e += 4 + len;
    }
    if (u32(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localName = decoder.decode(zip.subarray(offset + 30, offset + 30 + u16(offset + 26)));
    if (localName !== name) throw new Error(`local name ${localName} is not ${name}`);
    if (u32(offset + 14) !== crc) throw new Error(`local CRC of ${name} differs`);
    const dataAt = offset + 30 + u16(offset + 26) + u16(offset + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    if (zlibCrc32(data) >>> 0 !== crc) throw new Error(`CRC mismatch in ${name}`);
    if (out.has(name)) throw new Error(`${name} twice`);
    out.set(name, data);
    at = end + commentLen;
  }
  return out;
}

export const text = (bytes: Uint8Array | undefined): string =>
  bytes ? new TextDecoder().decode(bytes) : "";

/** A CSV's rows as arrays of cells (quotes undone; the byte order mark dropped). */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = csv.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && s[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** A CSV as objects keyed by its header. */
export function csvRecords(csv: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(csv);
  return rows.map((r) => Object.fromEntries((header ?? []).map((h, i) => [h, r[i] ?? ""])));
}
