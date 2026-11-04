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
  const m = /^(\d*\.?\d+)\s+(gallon|gal|quart|qt)/.exec(container ?? "");
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
