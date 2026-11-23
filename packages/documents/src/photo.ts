// A photo's location and time taken, read from its own metadata in code (DQ-001, Get document's
// `photoMetadata`): the EXIF block of a JPEG (APP1), a PNG (eXIf) or a HEIC/HEIF (the `Exif`
// item of its `meta` box). No model, and never a guess: anything missing, malformed or out of
// range gives none, not an error.

// DECISION: our own reader rather than a library: we need four values from one well-defined
// block (TIFF IFDs), the maintained readers are large or MPL-licensed (ExifReader) and the small
// one is unmaintained since 2022 (exifr). Every read is bounds-checked; a bad file gives none.

/** The image types whose metadata Get document reads. */
export const PHOTO_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

export function isPhotoMime(mimeType: string): boolean {
  return PHOTO_MIME_TYPES.has(mimeType.toLowerCase().split(";")[0]?.trim() ?? "");
}

export interface PhotoMetadata {
  /** Decimal degrees, north positive; null without a GPS position. */
  latitude: number | null;
  /** Decimal degrees, east positive; null without a GPS position. */
  longitude: number | null;
  /** When the photo was taken, ISO 8601 with its offset; null when the file doesn't say. */
  takenAt: string | null;
  locationSource: "exif" | "none";
}

export const NO_PHOTO_METADATA: PhotoMetadata = {
  latitude: null,
  longitude: null,
  takenAt: null,
  locationSource: "none",
};

/** The photo's metadata; none for anything that isn't a readable JPEG, PNG or HEIC. */
export function readPhotoMetadata(bytes: Uint8Array): PhotoMetadata {
  try {
    const tiff = tiffBlockOf(bytes);
    return tiff ? fromTiff(tiff) : NO_PHOTO_METADATA;
  } catch {
    return NO_PHOTO_METADATA;
  }
}

// ── Finding the EXIF (TIFF) block ────────────────────────────────────────────────────────────────

class Bad extends Error {}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, at: number, n: number): string {
  if (at < 0 || at + n > bytes.length) throw new Bad();
  return String.fromCharCode(...bytes.subarray(at, at + n));
}

function tiffBlockOf(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegExif(bytes);
  if (bytes.length >= 8 && ascii(bytes, 1, 3) === "PNG") return pngExif(bytes);
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") return heifExif(bytes);
  return null;
}

/** JPEG: the APP1 segment that starts `Exif\0\0`, before the image data. */
function jpegExif(bytes: Uint8Array): Uint8Array | null {
  const dv = view(bytes);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // Fill bytes, and markers with no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    // Start of scan or end of image: no metadata after this.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = dv.getUint16(at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return null;
    if (marker === 0xe1 && length >= 8 && ascii(bytes, at + 4, 6) === "Exif\0\0") {
      return bytes.subarray(at + 10, at + 2 + length);
    }
    at += 2 + length;
  }
  return null;
}

/** PNG: the `eXIf` chunk (PNG 1.5), the TIFF block as it is. */
function pngExif(bytes: Uint8Array): Uint8Array | null {
  const dv = view(bytes);
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = dv.getUint32(at);
    const type = ascii(bytes, at + 4, 4);
    const start = at + 8;
    if (start + length > bytes.length) return null;
    if (type === "eXIf") return bytes.subarray(start, start + length);
    if (type === "IEND") return null;
    at = start + length + 4;
  }
  return null;
}

interface Box {
  type: string;
  /** Where the box's content starts (after its header). */
  start: number;
  end: number;
}

function* boxes(bytes: Uint8Array, from: number, to: number): Generator<Box> {
  const dv = view(bytes);
  let at = from;
  while (at + 8 <= to) {
    let size = dv.getUint32(at);
    const type = ascii(bytes, at + 4, 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) throw new Bad();
      const big = dv.getBigUint64(at + 8);
      if (big > BigInt(to - at)) throw new Bad();
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) throw new Bad();
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

function child(bytes: Uint8Array, parent: Box, type: string, skip = 0): Box | null {
  for (const b of boxes(bytes, parent.start + skip, parent.end)) if (b.type === type) return b;
  return null;
}

function uint(dv: DataView, at: number, size: number): number {
  if (size === 0) return 0;
  if (size === 1) return dv.getUint8(at);
  if (size === 2) return dv.getUint16(at);
  if (size === 4) return dv.getUint32(at);
  if (size === 8) {
    const n = dv.getBigUint64(at);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Bad();
    return Number(n);
  }
  throw new Bad();
}

/**
 * HEIC/HEIF (ISO/IEC 23008-12): the item of type `Exif` named in `meta`'s `iinf`, its bytes where
 * `iloc` puts them (in the file, or in `meta`'s `idat`). Its payload starts with a 4-byte offset
 * to the TIFF header.
 */
function heifExif(bytes: Uint8Array): Uint8Array | null {
  const dv = view(bytes);
  const all: Box = { type: "", start: 0, end: bytes.length };
  const meta = child(bytes, all, "meta");
  if (!meta) return null;
  // `meta` is a full box: version and flags first.
  const iinf = child(bytes, meta, "iinf", 4);
  const iloc = child(bytes, meta, "iloc", 4);
  if (!iinf || !iloc) return null;

  let exifId: number | null = null;
  const iinfVersion = dv.getUint8(iinf.start);
  const entriesAt = iinf.start + 4 + (iinfVersion === 0 ? 2 : 4);
  for (const infe of boxes(bytes, entriesAt, iinf.end)) {
    if (infe.type !== "infe") continue;
    const version = dv.getUint8(infe.start);
    if (version < 2) continue;
    const idSize = version === 2 ? 2 : 4;
    const id = uint(dv, infe.start + 4, idSize);
    const type = ascii(bytes, infe.start + 4 + idSize + 2, 4);
    if (type === "Exif") {
      exifId = id;
      break;
    }
  }
  if (exifId === null) return null;

  const version = dv.getUint8(iloc.start);
  let at = iloc.start + 4;
  const sizes = dv.getUint16(at);
  at += 2;
  const offsetSize = sizes >> 12;
  const lengthSize = (sizes >> 8) & 0xf;
  const baseOffsetSize = (sizes >> 4) & 0xf;
  const indexSize = version === 1 || version === 2 ? sizes & 0xf : 0;
  const itemCount = version < 2 ? dv.getUint16(at) : dv.getUint32(at);
  at += version < 2 ? 2 : 4;
  for (let i = 0; i < itemCount; i++) {
    const id = version < 2 ? dv.getUint16(at) : dv.getUint32(at);
    at += version < 2 ? 2 : 4;
    let method = 0;
    if (version === 1 || version === 2) {
      method = dv.getUint16(at) & 0xf;
      at += 2;
    }
    at += 2; // data_reference_index
    const base = uint(dv, at, baseOffsetSize);
    at += baseOffsetSize;
    const extentCount = dv.getUint16(at);
    at += 2;
    const extents: { offset: number; length: number }[] = [];
    for (let e = 0; e < extentCount; e++) {
      at += indexSize;
      const offset = uint(dv, at, offsetSize);
      at += offsetSize;
      const length = uint(dv, at, lengthSize);
      at += lengthSize;
      extents.push({ offset, length });
    }
    if (id !== exifId) continue;
    // Construction method 0: offsets in the file; 1: in `meta`'s `idat`. Others: none.
    let origin = 0;
    if (method === 1) {
      const idat = child(bytes, meta, "idat", 4);
      if (!idat) return null;
      origin = idat.start;
    } else if (method !== 0) {
      return null;
    }
    const parts: Uint8Array[] = [];
    for (const { offset, length } of extents) {
      const from = origin + base + offset;
      const to = length === 0 ? bytes.length : from + length;
      if (to > bytes.length || to <= from) return null;
      parts.push(bytes.subarray(from, to));
    }
    const payload = concat(parts);
    if (payload.length < 4) return null;
    const skip = view(payload).getUint32(0);
    if (4 + skip >= payload.length) return null;
    return payload.subarray(4 + skip);
  }
  return null;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── Reading the TIFF block ───────────────────────────────────────────────────────────────────────

const ASCII = 2;
const RATIONAL = 5;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

interface Entry {
  type: number;
  count: number;
  /** Where the value is: inline in the entry, or at its offset. */
  at: number;
}

class Tiff {
  readonly dv: DataView;
  readonly little: boolean;
  constructor(readonly bytes: Uint8Array) {
    this.dv = view(bytes);
    const order = ascii(bytes, 0, 2);
    if (order !== "II" && order !== "MM") throw new Bad();
    this.little = order === "II";
    if (this.u16(2) !== 42) throw new Bad();
  }
  u16(at: number): number {
    return this.dv.getUint16(at, this.little);
  }
  u32(at: number): number {
    return this.dv.getUint32(at, this.little);
  }
  ifd(offset: number): Map<number, Entry> {
    const out = new Map<number, Entry>();
    if (offset < 8 || offset + 2 > this.bytes.length) return out;
    const n = this.u16(offset);
    if (n > 1000 || offset + 2 + n * 12 > this.bytes.length) throw new Bad();
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 0) * count;
      if (size === 0) continue;
      const at = size <= 4 ? e + 8 : this.u32(e + 8);
      if (at + size > this.bytes.length) continue;
      out.set(this.u16(e), { type, count, at });
    }
    return out;
  }
  text(e: Entry | undefined): string | null {
    if (!e || e.type !== ASCII) return null;
    const raw = ascii(this.bytes, e.at, e.count);
    const end = raw.indexOf("\0");
    return (end === -1 ? raw : raw.slice(0, end)).trim();
  }
  rationals(e: Entry | undefined, n: number): number[] | null {
    if (!e || e.type !== RATIONAL || e.count < n) return null;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const num = this.u32(e.at + i * 8);
      const den = this.u32(e.at + i * 8 + 4);
      if (den === 0) return null;
      out.push(num / den);
    }
    return out;
  }
  pointer(e: Entry | undefined): number | null {
    if (e?.count !== 1 || (e.type !== 4 && e.type !== 13)) return null;
    return this.u32(e.at);
  }
}

const EXIF_IFD = 0x8769;
const GPS_IFD = 0x8825;
const DATE_TIME_ORIGINAL = 0x9003;
const OFFSET_TIME_ORIGINAL = 0x9011;
const GPS_LAT_REF = 1;
const GPS_LAT = 2;
const GPS_LON_REF = 3;
const GPS_LON = 4;
const GPS_TIME = 7;
const GPS_STATUS = 9;
const GPS_DATE = 29;

function fromTiff(block: Uint8Array): PhotoMetadata {
  const t = new Tiff(block);
  const ifd0 = t.ifd(t.u32(4));
  const exifAt = t.pointer(ifd0.get(EXIF_IFD));
  const gpsAt = t.pointer(ifd0.get(GPS_IFD));
  const exif = exifAt === null ? new Map<number, Entry>() : t.ifd(exifAt);
  const gps = gpsAt === null ? new Map<number, Entry>() : t.ifd(gpsAt);

  const position = positionOf(t, gps);
  return {
    latitude: position?.latitude ?? null,
    longitude: position?.longitude ?? null,
    takenAt: takenAtOf(t, exif, gps),
    locationSource: position ? "exif" : "none",
  };
}

function degrees(dms: number[] | null): number | null {
  if (!dms) return null;
  const [d = Number.NaN, m = Number.NaN, s = Number.NaN] = dms;
  const value = d + m / 60 + s / 3600;
  return Number.isFinite(value) ? value : null;
}

function positionOf(t: Tiff, gps: Map<number, Entry>) {
  // A receiver that says its fix is void ("V") gives no position.
  if (t.text(gps.get(GPS_STATUS)) === "V") return null;
  const latRef = t.text(gps.get(GPS_LAT_REF));
  const lonRef = t.text(gps.get(GPS_LON_REF));
  const lat = degrees(t.rationals(gps.get(GPS_LAT), 3));
  const lon = degrees(t.rationals(gps.get(GPS_LON), 3));
  // Without its hemisphere a coordinate could be either sign: none, never a guess.
  if (lat === null || lon === null || !latRef || !lonRef) return null;
  if (!"NS".includes(latRef) || !"EW".includes(lonRef) || latRef.length !== 1) return null;
  if (lonRef.length !== 1) return null;
  const latitude = latRef === "S" ? -lat : lat;
  const longitude = lonRef === "W" ? -lon : lon;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude: round(latitude), longitude: round(longitude) };
}

/** Eight decimals (about a millimetre): drops the float noise of the degree arithmetic. */
function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

const EXIF_TIME = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

// DECISION: takenAt is DateTimeOriginal with OffsetTimeOriginal (what phones write). Without the
// offset, the GPS date and time stamp (always UTC) gives it in `Z`; with neither, none: a local
// time without its offset could be any zone, and we never guess one.
function takenAtOf(t: Tiff, exif: Map<number, Entry>, gps: Map<number, Entry>): string | null {
  const local = EXIF_TIME.exec(t.text(exif.get(DATE_TIME_ORIGINAL)) ?? "");
  const offset = OFFSET.exec(t.text(exif.get(OFFSET_TIME_ORIGINAL)) ?? "");
  if (local && offset) {
    const [, y, mo, d, h, mi, s] = local;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${offset[0]}`;
    return validTime(iso) ? iso : null;
  }
  const date = /^(\d{4}):(\d{2}):(\d{2})$/.exec(t.text(gps.get(GPS_DATE)) ?? "");
  const hms = t.rationals(gps.get(GPS_TIME), 3);
  if (date && hms) {
    const [h = -1, mi = -1, s = -1] = hms.map(Math.floor);
    const two = (n: number) => String(n).padStart(2, "0");
    const iso = `${date[1]}-${date[2]}-${date[3]}T${two(h)}:${two(mi)}:${two(s)}Z`;
    return validTime(iso) ? iso : null;
  }
  return null;
}

function validTime(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (!y || y < 1900 || !mo || mo > 12 || !d || d > 31) return false;
  if ((h ?? 99) > 23 || (mi ?? 99) > 59 || (s ?? 99) > 60) return false;
  return !Number.isNaN(Date.parse(iso));
}
