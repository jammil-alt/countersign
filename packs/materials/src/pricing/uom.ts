// Units of measure (ARCHITECTURE §12.3 "UOM conversion table", §12.4): how many of an item's
// standard unit one invoice unit holds. `unit_price_std = unit_price / factor` and
// `qty_std = qty × factor`. No rule, no price: invariant 7 says prices are never compared across
// units without a conversion rule, so a line whose unit can't be converted is not recorded.

import { type Decimal, dec } from "@countersign/core";
import type { Attributes } from "../catalog/parsers";
import type { StandardUom } from "../schema";

// DECISION: the conversion table lives in the pack, not packages/core/units as ARCHITECTURE §12.3
// sketches: only this pack converts units, and its pack sizes and containers come from its own
// parsers. Spellings are the invoice's, uppercased with dots and spaces removed.
const SPELLINGS: Record<string, string> = {
  SHT: "sheet",
  SHTS: "sheet",
  SH: "sheet",
  SHEET: "sheet",
  SHEETS: "sheet",
  PNL: "sheet",
  PANEL: "sheet",
  EA: "each",
  EACH: "each",
  PC: "each",
  PCS: "each",
  PIECE: "each",
  UNIT: "each",
  BF: "board_foot",
  BDFT: "board_foot",
  FBM: "board_foot",
  BOARDFOOT: "board_foot",
  MBF: "thousand_board_feet",
  LF: "linear_foot",
  LFT: "linear_foot",
  LINFT: "linear_foot",
  FT: "linear_foot",
  FOOT: "linear_foot",
  FEET: "linear_foot",
  ROLL: "roll",
  RL: "roll",
  RLL: "roll",
  GAL: "gallon",
  GALLON: "gallon",
  GL: "gallon",
  QT: "quart",
  QUART: "quart",
  PR: "pair",
  PAIR: "pair",
  BX: "pack",
  BOX: "pack",
  PK: "pack",
  PKG: "pack",
  CS: "pack",
  CASE: "pack",
  CTN: "pack",
  PAIL: "container",
  CAN: "container",
  DRUM: "container",
  KIT: "container",
};

// A box, a case and a carton are all a `pack` to the conversion table, but not the same pack: the
// word a vendor wrote, in one spelling, tells a vendor's box from its case.
const PACKAGING_WORDS: Record<string, string> = {
  BX: "box",
  BOX: "box",
  BOXES: "box",
  PK: "pack",
  PKG: "pack",
  PACK: "pack",
  CS: "case",
  CASE: "case",
  CTN: "carton",
  CARTON: "carton",
  PAIL: "pail",
  CAN: "can",
  DRUM: "drum",
  KIT: "kit",
};

/** Units that are a vendor's packaging: their size is the vendor's, not the item's. */
export const PACKAGING_UOMS: ReadonlySet<string> = new Set(["pack", "container"]);

/**
 * The unit a vendor wrote, finer than `readUom` for packaging (`box`, `case`, `carton`, `pail`),
 * else as `readUom` reads it, else its own words; null when none is given.
 */
export function unitWord(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const key = raw.toUpperCase().replace(/[.\s]/g, "");
  return PACKAGING_WORDS[key] ?? readUom(raw) ?? raw.trim().toLowerCase();
}

const PACKAGING_TOKENS = "BOXES|BOX|BX|CASE|CS|CARTON|CTN|PACK|PKG|PK|PAIL|CAN|DRUM|KIT";
// Measures a number is in when one follows it: "PAIL 5 GAL" is a 5-gallon pail, not 5 to a pail.
const MEASURES =
  "GALLONS|GALLON|GAL|GL|QUARTS|QUART|QT|PINT|PT|OUNCES|OUNCE|OZ|POUNDS|POUND|LBS|LB|FEET|FOOT|FT|INCHES|INCH|IN|YARDS|YARD|YDS|YD|LITERS|LITER|LTR|ML|MM|CM|M|L|SF|SQFT|LF|BF";
// DECISION (fourth review of fix/materials, finding 4): a number is a pack's size in `BX 100`
// only when nothing after it says otherwise: not another pack ("100/BX 10 BX/CS" is ten boxes
// to a case), a measure ("CAN 12 OZ"), a fraction or dimension ("BOX 2-1/8", "BOX 10 X 3").
const NOT_A_COUNT = `(?![\\d.\\/-])(?!\\s*(?:["']|X\\s*\\d|\\d|(?:${PACKAGING_TOKENS}|${MEASURES})(?![A-Z])))`;
const PACK_PATTERNS: readonly { re: RegExp; size: number; word: number }[] = [
  // 100/BX, 100 PER BOX
  {
    re: new RegExp(`(?:^|[^\\d.])(\\d+)\\s*(?:\\/|PER)\\s*(${PACKAGING_TOKENS})(?![A-Z])`, "g"),
    size: 1,
    word: 2,
  },
  // BX/100, BOX OF 100, CS 1000
  {
    re: new RegExp(
      `(?<![A-Z])(${PACKAGING_TOKENS})\\s*(?:\\/|OF|\\s)\\s*(\\d+)${NOT_A_COUNT}`,
      "g",
    ),
    size: 2,
    word: 1,
  },
];

// 10 BX/CS, 4 BOXES PER CASE: how many of one pack another holds.
const NESTED_PACK = new RegExp(
  `(?:^|[^\\d.])(\\d+)\\s*(${PACKAGING_TOKENS})\\s*(?:\\/|PER)\\s*(${PACKAGING_TOKENS})(?![A-Z])`,
  "g",
);

/**
 * The packs a text states with their size (`100/BX`, `CS/1000`, `BOX OF 100`, `CS 100`): each
 * word (`box`, `case`...) with how many it holds. A word with no number states nothing (a "BOX
 * NAIL" is a kind of nail).
 */
export function packsIn(text: string | null | undefined): { word: string; size: string }[] {
  const upper = (text ?? "").toUpperCase().slice(0, 500);
  const out: { word: string; size: string }[] = [];
  for (const p of PACK_PATTERNS) {
    for (const m of upper.matchAll(p.re)) {
      const word = unitWord(m[p.word]);
      const size = m[p.size];
      if (word && size && Number(size) > 0) out.push({ word, size: String(Number(size)) });
    }
  }
  // DECISION (fifth review of fix/materials, S2): "10 BX/CS" is ten boxes to a case, so the
  // case holds ten times the box's size when the text states the box's one size; else it states
  // nothing about the case.
  for (const m of upper.matchAll(NESTED_PACK)) {
    const inner = unitWord(m[2]);
    const outer = unitWord(m[3]);
    const n = Number(m[1]);
    const innerSizes = [...new Set(out.filter((p) => p.word === inner).map((p) => p.size))];
    const one = innerSizes.length === 1 ? innerSizes[0] : undefined;
    if (outer && inner !== outer && n > 0 && one !== undefined) {
      out.push({ word: outer, size: dec(one).times(n).toString() });
    }
  }
  return out;
}

/** What a line states about the size of its own unit: a box, case or pail's word and its sizes. */
export interface StatedPack {
  /** The line's unit as the vendor wrote it (`unitWord`), or null. */
  word: string | null;
  /** The distinct sizes the line states for its own unit; empty when it states none. */
  sizes: string[];
  /** The one size, when the line states exactly one for its unit; else null (none, or two). */
  size: string | null;
}

// The parser's count forms (catalog/parsers.ts: `100PK`, `100PC`, `100CT`).
const PARSER_COUNT = /(?:^|\s)\d+(?:PK|PC|PCS|CT)(?=\s|$)/g;
// A pack word beside a number, either way round: `10 BX`, `BX 10`, `10/CS`, `BOX OF 4`.
const PACK_NEAR_NUMBER = new RegExp(
  `\\d\\s*(?:\\/|PER|OF)?\\s*(?:${PACKAGING_TOKENS})(?![A-Z])|(?<![A-Z])(?:${PACKAGING_TOKENS})\\s*(?:\\/|OF|-)?\\s*\\d`,
);

// The order packs usually nest in, inner first: a box holds packs, a case holds boxes.
const NESTING: Readonly<Record<string, number>> = { pack: 1, box: 2, carton: 3, case: 4 };

/**
 * Whether a pack of `size` in `word` sits with one of `otherSize` in `otherWord` without doubt:
 * the outer one (`NESTING`) strictly bigger. A word outside that order sits with no other size.
 */
function nests(word: string, size: string, otherWord: string, otherSize: string): boolean {
  const a = NESTING[word];
  const b = NESTING[otherWord];
  if (a === undefined || b === undefined) return false;
  return a > b ? dec(size).greaterThan(otherSize) : dec(size).lessThan(otherSize);
}

/**
 * The pack size a line states for its own unit, read one way for matching and for converting:
 * for a box, case or pail, the sizes `packsIn` reads in the unit's own word (`100/BX` for a box
 * line, never the `1000/CS` beside it); when the text names no pack beside a number anywhere,
 * the parser's pack size (`100CT`); else none. Any doubt gives no size: sizes that disagree, or
 * a size beside another pack's that doesn't nest in it (`100/BX 10/CS`: a case smaller than its
 * box, `NESTING`). Other units state none.
 */
// DECISION (fifth review of fix/materials, finding 1): matching (`effectiveWord`) and every
// conversion (`convertLine`) read a line's pack size here, so a line is never filed under a box
// of 100 and converted at the case's 1000 beside it. The parser's first X/N (`pack_size`) counts
// only when the text names no pack in any word, since it may be another pack's. No usable size:
// the line converts as a line without one does (the vendor item's conversion, else none).
// DECISION (sixth review of fix/materials): invoices word packs in endless ways, so this reads a
// size only when the text leaves no doubt, and otherwise reads none: the line is then converted
// by a vendor item that agrees with it, or held for a person. It never guesses.
export function statedPack(
  uomRaw: string | null | undefined,
  text: string | null | undefined,
  parsedPackSize?: string | null | undefined,
): StatedPack {
  const word = unitWord(uomRaw);
  const unit = readUom(uomRaw);
  if (word === null || unit === null || !PACKAGING_UOMS.has(unit)) {
    return { word, sizes: [], size: null };
  }
  const none: StatedPack = { word, sizes: [], size: null };
  const packs = packsIn(text);
  const own = [...new Set(packs.filter((p) => p.word === word).map((p) => dec(p.size).toString()))];
  if (own.length > 0) {
    // A case of 10 beside a box of 100 is ten boxes, not ten: no size to convert at. The sizes
    // the line can mean stay, so a vendor item that holds another (`contradictsSize`) is not taken
    // for it: a count of the inner packs times their size (`50/BX 10/CS` is 500, never a case of
    // 1000), else what it states.
    const others = packs.filter((p) => p.word !== word);
    if (own.some((x) => others.some((o) => !nests(word, x, o.word, o.size)))) {
      const outer = NESTING[word];
      const inner = others.filter((o) => {
        const n = NESTING[o.word];
        return outer !== undefined && n !== undefined && n < outer;
      });
      const read =
        inner.length > 0
          ? own.flatMap((x) => inner.map((o) => dec(x).times(o.size).toString()))
          : own;
      return { word, sizes: [...new Set(read)], size: null };
    }
    return { word, sizes: own, size: own.length === 1 ? (own[0] ?? null) : null };
  }
  // The parser's own reading (`100CT`, `100PK`) aside, a pack beside a number anywhere may be
  // what its number counts (`100CT 10 BX/CS`): no size.
  const rest = (text ?? "").toUpperCase().slice(0, 500).replace(PARSER_COUNT, " ");
  if (packs.length > 0 || PACK_NEAR_NUMBER.test(rest) || new RegExp(NESTED_PACK).test(rest)) {
    return none;
  }
  if (!parsedPackSize || !(Number(parsedPackSize) > 0)) return none;
  const size = dec(parsedPackSize).toString();
  return { word, sizes: [size], size };
}

/**
 * A unit as two lines' units are told apart: its one spelling (`sheet`, `each`), a box, case or
 * pail by its word (`pack:box` is not `pack:case`), else its own words; null when none is given.
 */
export function unitKey(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const uom = readUom(raw);
  if (uom !== null && PACKAGING_UOMS.has(uom)) return `${uom}:${unitWord(raw)}`;
  return uom ?? raw.trim().toLowerCase();
}

/** An invoice unit in one spelling (`sheet`, `board_foot`, `pack`, …), or null if unknown. */
export function readUom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.toUpperCase().replace(/[.\s]/g, "");
  return SPELLINGS[key] ?? null;
}

export type Conversion =
  | { ok: true; factor: Decimal; rule: string; assumed: boolean }
  | { ok: false; reason: string };

const one = (rule: string, assumed = false): Conversion => ({
  ok: true,
  factor: dec("1"),
  rule,
  assumed,
});

/** `5 gallon` → 5 (gallons), `1 quart` → 0.25; null when the container isn't read. */
function containerGallons(container: string | undefined): Decimal | null {
  const m = /^((?:\d+(?:\.\d+)?|\.\d+))\s+(gallon|gal|quart|qt)/.exec(container ?? "");
  if (!m?.[1] || !m[2]) return null;
  const n = dec(m[1]);
  return m[2].startsWith("q") ? n.dividedBy(4) : n;
}

/**
 * How many standard units one invoice unit is, for an item in `standardUom`. `attributes` are the
 * line's own (pack size, container, roll length) over the item's.
 */
// DECISION: a line with no unit is taken to be in the item's standard unit (most invoices list
// sheets and pieces without one), and marked `assumed` on the observation.
export function convert(
  uomRaw: string | null | undefined,
  standardUom: StandardUom,
  attributes: Attributes,
): Conversion {
  const unit = readUom(uomRaw);
  if (!uomRaw?.trim()) return one("no unit: the standard unit", true);
  if (!unit) return { ok: false, reason: `no conversion rule for the unit "${uomRaw}"` };
  if (unit === standardUom) return one(`${unit} = ${standardUom}`);
  const packSize = Number(attributes.pack_size);
  switch (standardUom) {
    case "sheet":
      if (unit === "each") return one("each = sheet");
      break;
    case "board_foot":
      if (unit === "thousand_board_feet") {
        return { ok: true, factor: dec("1000"), rule: "MBF = 1000 board feet", assumed: false };
      }
      break;
    case "linear_foot": {
      const length = Number(attributes.length_ft);
      if ((unit === "roll" || unit === "each") && Number.isFinite(length) && length > 0) {
        return {
          ok: true,
          factor: dec(String(length)),
          rule: `${unit} = ${length} linear feet`,
          assumed: false,
        };
      }
      break;
    }
    case "each":
      if (unit === "pair") return { ok: true, factor: dec("2"), rule: "pair = 2", assumed: false };
      if (unit === "pack" && Number.isInteger(packSize) && packSize > 0) {
        return {
          ok: true,
          factor: dec(String(packSize)),
          rule: `pack = ${packSize} each`,
          assumed: false,
        };
      }
      if (unit === "container") return one("container = each");
      break;
    case "gallon": {
      if (unit === "quart")
        return { ok: true, factor: dec("0.25"), rule: "quart = 1/4 gallon", assumed: false };
      const gallons = containerGallons(attributes.container);
      if ((unit === "each" || unit === "container") && gallons && gallons.greaterThan(0)) {
        return {
          ok: true,
          factor: gallons,
          rule: `${unit} = ${gallons.toString()} gallons`,
          assumed: false,
        };
      }
      break;
    }
    case "quart":
      if (unit === "gallon")
        return { ok: true, factor: dec("4"), rule: "gallon = 4 quarts", assumed: false };
      break;
  }
  return { ok: false, reason: `no conversion rule from ${unit} to ${standardUom}` };
}

// ── A line's conversion, vendor-neutral (docs/plan.md §1.88) ─────────────────────────────────────

/** Attributes that are a vendor's packaging, not the item: they live on `vendor_item`. */
export const PACKAGING_ATTRIBUTES: readonly string[] = ["pack_size"];

/** A master item's attributes without a vendor's packaging (its pack size). */
export function withoutPackaging(attributes: Readonly<Record<string, unknown>>): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (!PACKAGING_ATTRIBUTES.includes(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * How many standard units one of a line's units is: from the line's own attributes over its
 * master item's (never the master item's pack size: that was one vendor's box), else from the
 * vendor item's own conversion when the line is in the vendor item's unit.
 */
// DECISION (review of vendor/web3, finding 4): a master item is vendor-neutral, so its pack size
// never converts another vendor's line (a box of 50 is not a box of 100). The line's own words
// ("100/BOX") convert; else the vendor item's `std_per_vendor_uom` for that unit; else there is no
// rule and no price per standard unit (invariant 7).
export function convertLine(
  uomRaw: string | null | undefined,
  standardUom: StandardUom,
  line: {
    /** The line's own words, for the pack size it states (`statedPack`). */
    text: string | null | undefined;
    /** Its attributes as parsed (a request's specs may be added under them). */
    attributes: Readonly<Attributes>;
  },
  item: Readonly<Record<string, unknown>>,
  vendorItem?: { vendorUom: string | null; stdPerVendorUom: string | null } | null,
): Conversion {
  const pack = statedPack(uomRaw, line.text, line.attributes.pack_size);
  const unit = uomRaw?.trim() ? (readUom(uomRaw) ?? uomRaw.trim().toLowerCase()) : null;
  const own: Attributes = { ...line.attributes };
  if (unit !== null && PACKAGING_UOMS.has(unit)) {
    delete own.pack_size;
    if (pack.size !== null) own.pack_size = pack.size;
  }
  const conv = convert(uomRaw, standardUom, { ...withoutPackaging(item), ...own });
  if (conv.ok || !vendorItem?.stdPerVendorUom) return conv;
  const factor = dec(vendorItem.stdPerVendorUom);
  if (unit === null || unit !== vendorItem.vendorUom || !factor.greaterThan(0)) return conv;
  // A size the line states for its unit that isn't the vendor item's is no conversion by it.
  if (pack.sizes.some((x) => !dec(x).equals(factor))) return conv;
  return {
    ok: true,
    factor,
    rule: `${unit} = ${factor.toString()} ${standardUom} (the vendor's item)`,
    assumed: false,
  };
}
