// Dimensions as vendors write them, in one spelling each: nominal thickness (`3/4"`, `.75`, `18MM`,
// `23/32` → `3/4in`, the actual mm kept beside it) and sheet sizes (`4X8`, `48X96`, `4'X8'`,
// `1220X2440MM` → `48x96in`). Pure functions over normalized text.

const MM_PER_INCH = 25.4;

/** Nominal sheet thicknesses, in inches. A measured or metric thickness reads as the nearest. */
const NOMINALS: readonly [string, number][] = [
  ["1/8in", 0.125],
  ["1/4in", 0.25],
  ["3/8in", 0.375],
  ["1/2in", 0.5],
  ["5/8in", 0.625],
  ["3/4in", 0.75],
  ["1in", 1],
  ["1-1/8in", 1.125],
  ["1-1/4in", 1.25],
  ["1-1/2in", 1.5],
];

// DECISION: a thickness reads as the nearest nominal within 0.05in (about 1.3 mm): 23/32 and 18 mm
// are 3/4, 15/32 and 12 mm are 1/2, 5.2 mm lauan is 1/4. Further than that, it has no nominal.
const NOMINAL_TOLERANCE = 0.05;

export function nominalThickness(inches: number): string | null {
  let best: [string, number] | null = null;
  for (const n of NOMINALS) {
    const d = Math.abs(n[1] - inches);
    if (d <= NOMINAL_TOLERANCE && (!best || d < Math.abs(best[1] - inches))) best = n;
  }
  return best ? best[0] : null;
}

/** `3/4`, `23/32`, `1-1/2`, `.75`, `0.75`, `1` → inches; null when it isn't a number. */
export function parseInches(text: string): number | null {
  const mixed = /^(\d+)-(\d+)\/(\d+)$/.exec(text);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = /^(\d+)\/(\d+)$/.exec(text);
  if (fraction) {
    const den = Number(fraction[2]);
    return den === 0 ? null : Number(fraction[1]) / den;
  }
  if (/^\d*\.?\d+$/.test(text)) return Number(text);
  return null;
}

const FRACTION_DENOMINATORS = new Set([2, 4, 8, 16, 32, 64]);

export interface Thickness {
  /** `3/4in`. */
  nominal: string;
  /** Millimetres, one decimal: what the vendor's figure measures. */
  actualMm: string;
}

const round1 = (n: number) => String(Math.round(n * 10) / 10);

/**
 * The first sheet-goods thickness in the tokens: `18MM`, `3/4`, `3/4"`, `3/4IN`, `23/32`, `.75`,
 * `0.75"`, `1"`. Fractions over a non-binary denominator (`BB/BB`, `4/4` quarters) don't count.
 */
export function findThickness(
  tokens: readonly string[],
): { thickness: Thickness; index: number } | null {
  for (const [index, token] of tokens.entries()) {
    const mm = /^(\d*\.?\d+)MM$/.exec(token);
    if (mm) {
      const value = Number(mm[1]);
      if (value <= 0 || value > 40) continue;
      const nominal = nominalThickness(value / MM_PER_INCH);
      if (nominal) return { thickness: { nominal, actualMm: round1(value) }, index };
      continue;
    }
    const inch = /^((?:\d+-)?\d+\/\d+|\d*\.\d+|\d+)(?:"|IN)?$/.exec(token);
    if (!inch?.[1]) continue;
    const text = inch[1];
    const slash = /\/(\d+)$/.exec(text);
    if (slash && !FRACTION_DENOMINATORS.has(Number(slash[1]))) continue;
    // A bare integer is a thickness only with its unit (`1"`), never alone (`4` in `4 SHEETS`).
    if (/^\d+$/.test(text) && token === text) continue;
    // Quarters (`4/4`, `8/4`) are hardwood thickness, not sheet thickness.
    if (/^\d+\/4$/.test(text) && Number(text.split("/")[0]) >= 4) continue;
    const value = parseInches(text);
    if (value === null || value <= 0 || value > 1.6) continue;
    const nominal = nominalThickness(value);
    if (nominal) return { thickness: { nominal, actualMm: round1(value * MM_PER_INCH) }, index };
  }
  return null;
}

type DimUnit = "mm" | "in" | "ft";

function unitOf(mark: string | undefined): DimUnit | null {
  if (!mark) return null;
  if (mark === "MM") return "mm";
  if (mark === "'" || mark === "FT") return "ft";
  return "in";
}

const DIM = String.raw`((?:\d+-)?\d+\/\d+|\d*\.?\d+)(MM|IN|FT|'|")?`;
const SIZE_RE = new RegExp(`^${DIM}X${DIM}(?:X${DIM})?$`);

export interface SheetSize {
  /** `48x96in`, the shorter side first. */
  size: string;
  /** A thickness given as the first of three dimensions (`3/4X48X96`), in inches. */
  thicknessInches: number | null;
  index: number;
}

/**
 * A sheet's width × length. Feet when both sides are 12 or less (`4X8`, `5X5`), millimetres when
 * marked or when a side is over 200 (`1220X2440`), inches otherwise (`48X96`, `49X97`); rounded to
 * whole inches (`1525MM` → 60).
 */
export function findSheetSize(tokens: readonly string[]): SheetSize | null {
  for (const [index, token] of tokens.entries()) {
    const m = SIZE_RE.exec(token);
    if (!m) continue;
    const parts: { value: number; unit: DimUnit | null }[] = [];
    for (let i = 1; i < m.length; i += 2) {
      const text = m[i];
      if (text === undefined) continue;
      const value = parseInches(text);
      if (value === null) break;
      parts.push({ value, unit: unitOf(m[i + 1]) });
    }
    if (parts.length < 2) continue;
    let thicknessInches: number | null = null;
    let dims = parts;
    if (parts.length === 3) {
      const first = parts[0];
      if (!first) continue;
      const firstInches = first.unit === "mm" ? first.value / MM_PER_INCH : first.value;
      thicknessInches = firstInches;
      dims = parts.slice(1);
    }
    const explicit = dims.find((d) => d.unit !== null)?.unit ?? null;
    const values = dims.map((d) => d.value);
    const unit: DimUnit =
      explicit ?? (values.every((v) => v <= 12) ? "ft" : values.some((v) => v > 200) ? "mm" : "in");
    const inches = values.map((v) =>
      Math.round(unit === "mm" ? v / MM_PER_INCH : unit === "ft" ? v * 12 : v),
    );
    const [a = 0, b = 0] = inches.sort((x, y) => x - y);
    if (a <= 0 || b <= 0) continue;
    return { size: `${a}x${b}in`, thicknessInches, index };
  }
  return null;
}

/** Millimetres from `22MM`, `7/8`, `15/16"`, `1-1/8IN`, `.5MM`, `10MIL`, `.018`; null otherwise. */
export function toMm(token: string): number | null {
  const mm = /^(\d*\.?\d+)MM$/.exec(token);
  if (mm) return Number(mm[1]);
  const mil = /^(\d+)MIL$/.exec(token);
  if (mil) return Number(mil[1]) * 0.0254;
  const inch = /^((?:\d+-)?\d+\/\d+|\d*\.\d+|\d+)(?:"|IN)?$/.exec(token);
  if (!inch?.[1]) return null;
  const slash = /\/(\d+)$/.exec(inch[1]);
  if (slash && !FRACTION_DENOMINATORS.has(Number(slash[1]))) return null;
  const value = parseInches(inch[1]);
  return value === null ? null : value * MM_PER_INCH;
}

export function formatMm(mm: number): string {
  return `${round1(mm)}mm`;
}
