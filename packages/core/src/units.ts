// Units (CLAUDE.md "units"): the fixed conversions between units of one kind of measure that any
// process may use (Reshape data's "convert units"). Exact factors as decimal strings, to a base
// unit per kind; a value converts only within its kind. Pack sizes, containers and what an
// invoice's "EA" holds are a pack's business (the Materials pack's own table), never these.

import { Decimal } from "./money";

// DECISION: core's unit table holds only conversions that are true everywhere (metric and US
// customary length, mass and volume, counts, board feet); Materials keeps its own invoice-unit
// table (packs/materials/src/pricing/uom.ts), since a "box" or a "pail" means what its vendor says.
const KINDS: Record<string, Record<string, string>> = {
  length: {
    mm: "0.001",
    cm: "0.01",
    m: "1",
    km: "1000",
    in: "0.0254",
    ft: "0.3048",
    yd: "0.9144",
    mi: "1609.344",
  },
  mass: {
    g: "0.001",
    kg: "1",
    t: "1000",
    oz: "0.028349523125",
    lb: "0.45359237",
  },
  volume: {
    ml: "0.001",
    l: "1",
    floz: "0.0295735295625",
    pt: "0.473176473",
    qt: "0.946352946",
    gal: "3.785411784",
  },
  count: { each: "1", pair: "2", dozen: "12" },
  board: { board_foot: "1", thousand_board_feet: "1000" },
};

const ALIASES: Record<string, string> = {
  millimeter: "mm",
  millimeters: "mm",
  centimeter: "cm",
  centimeters: "cm",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  kilometer: "km",
  kilometers: "km",
  inch: "in",
  inches: "in",
  foot: "ft",
  feet: "ft",
  lf: "ft",
  yard: "yd",
  yards: "yd",
  mile: "mi",
  miles: "mi",
  gram: "g",
  grams: "g",
  kilogram: "kg",
  kilograms: "kg",
  kgs: "kg",
  tonne: "t",
  tonnes: "t",
  ounce: "oz",
  ounces: "oz",
  pound: "lb",
  pounds: "lb",
  lbs: "lb",
  milliliter: "ml",
  milliliters: "ml",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  pint: "pt",
  pints: "pt",
  quart: "qt",
  quarts: "qt",
  gallon: "gal",
  gallons: "gal",
  ea: "each",
  pc: "each",
  pcs: "each",
  piece: "each",
  pieces: "each",
  pairs: "pair",
  dz: "dozen",
  doz: "dozen",
  bf: "board_foot",
  fbm: "board_foot",
  mbf: "thousand_board_feet",
};

/** A unit in the table's own spelling (`ft`, `lb`, `each`), or null when the table hasn't it. */
export function unitOf(raw: string): { kind: string; unit: string } | null {
  const key = raw.trim().toLowerCase().replace(/[.\s]/g, "");
  const unit = ALIASES[key] ?? key;
  for (const [kind, units] of Object.entries(KINDS)) {
    if (Object.hasOwn(units, unit)) return { kind, unit };
  }
  return null;
}

/** Every unit the table knows, by kind (for the builder's pickers). */
export function knownUnits(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(KINDS).map(([k, u]) => [k, Object.keys(u)]));
}

/**
 * `value` in `from` as `to`, exactly (decimal.js); null when either unit is unknown or the two
 * measure different things (feet to pounds).
 */
export function convertUnits(value: Decimal, from: string, to: string): Decimal | null {
  const a = unitOf(from);
  const b = unitOf(to);
  if (!a || !b || a.kind !== b.kind) return null;
  const units = KINDS[a.kind] as Record<string, string>;
  return value
    .times(new Decimal(units[a.unit] as string))
    .div(new Decimal(units[b.unit] as string));
}
