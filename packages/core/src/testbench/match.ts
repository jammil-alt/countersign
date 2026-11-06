// v0.12 W2-C: comparing what a case got with what it expected (docs/plan.md §1.46). Plain JSON
// in, a pass and a list of differences out. Numbers and money are compared with decimal.js, dates
// in days. Paths are read with own-property checks only, so no key ever reaches a prototype.

import { deepEqual, isPlainObject } from "../json";
import { Decimal } from "../money";
import { type LabelField, type Matcher, type Tolerance, UNSAFE_PATH_SEGMENTS } from "./case";

export type DiffProblem = "missing" | "extra" | "different" | "outside_tolerance";

export interface MatchDiff {
  path: string;
  problem: DiffProblem;
  expected?: unknown;
  got?: unknown;
}

export interface MatchResult {
  pass: boolean;
  /** The first differences found (at most MAX_DIFFS). */
  diff: MatchDiff[];
}

export const MAX_DIFFS = 50;

type Segments = readonly string[];

const joinPath = (segs: Segments): string => (segs.length === 0 ? "(output)" : segs.join("."));

/** Own property `key` of a plain object or index of an array; undefined otherwise. */
function child(value: unknown, key: string): unknown {
  if (UNSAFE_PATH_SEGMENTS.has(key)) return undefined;
  if (Array.isArray(value)) {
    if (!/^\d{1,6}$/.test(key)) return undefined;
    return value[Number(key)];
  }
  if (isPlainObject(value) && Object.hasOwn(value, key)) return value[key];
  return undefined;
}

/** The value at a dot path (no wildcards), or undefined. */
export function valueAt(value: unknown, path: string): unknown {
  let cur = value;
  for (const seg of path.split(".")) {
    cur = child(cur, seg);
    if (cur === undefined) return undefined;
  }
  return cur;
}

interface Rule {
  segs: string[];
  tolerance: Tolerance;
}

function rulesOf(matcher: Pick<Matcher, "tolerances">): Rule[] {
  return Object.entries(matcher.tolerances).map(([path, tolerance]) => ({
    segs: path.split("."),
    tolerance,
  }));
}

const segMatches = (pattern: string, seg: string) =>
  pattern === seg || (pattern === "*" && /^\d{1,6}$/.test(seg));

function ruleAt(rules: readonly Rule[], segs: Segments): Tolerance | null {
  for (const r of rules) {
    if (r.segs.length !== segs.length) continue;
    if (r.segs.every((p, i) => segMatches(p, segs[i] as string))) return r.tolerance;
  }
  return null;
}

/** Whether some rule names a field under `segs` (or `segs` itself). */
function ruleBelow(rules: readonly Rule[], segs: Segments): boolean {
  return rules.some(
    (r) =>
      r.segs.length >= segs.length && segs.every((s, i) => segMatches(r.segs[i] as string, s)),
  );
}

function decimalOf(value: unknown): Decimal | null {
  if (typeof value === "number") return Number.isFinite(value) ? new Decimal(value) : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > 40) return null;
  try {
    const d = new Decimal(text);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

const DAY_MS = 86_400_000;

function dayOf(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(ms) ? null : ms / DAY_MS;
}

/** Whether `got` is within `tolerance` of `expected`. */
export function toleranceHolds(tolerance: Tolerance, expected: unknown, got: unknown): boolean {
  switch (tolerance.kind) {
    case "equal":
      return deepEqual(expected, got);
    case "number": {
      const e = decimalOf(expected);
      const g = decimalOf(got);
      if (!e || !g) return deepEqual(expected, got);
      const abs = new Decimal(tolerance.abs ?? "0");
      const pct = tolerance.pct ? e.abs().times(tolerance.pct).div(100) : new Decimal(0);
      return g.minus(e).abs().lte(Decimal.max(abs, pct));
    }
    case "money": {
      const e = decimalOf(expected);
      const g = decimalOf(got);
      if (!e || !g) return deepEqual(expected, got);
      return g.minus(e).abs().lte(tolerance.abs);
    }
    case "date": {
      const e = dayOf(expected);
      const g = dayOf(got);
      if (e === null || g === null) return deepEqual(expected, got);
      return Math.abs(g - e) <= tolerance.days;
    }
  }
}

type Mode = "exact" | "subset" | "fields";

class Walker {
  readonly diff: MatchDiff[] = [];
  failed = false;

  constructor(
    private readonly mode: Mode,
    private readonly rules: readonly Rule[],
  ) {}

  private add(d: MatchDiff) {
    this.failed = true;
    if (this.diff.length < MAX_DIFFS) this.diff.push(d);
  }

  compare(expected: unknown, got: unknown, segs: string[]): void {
    const tolerance = ruleAt(this.rules, segs);
    if (tolerance) {
      if (got === undefined) {
        this.add({ path: joinPath(segs), problem: "missing", expected });
      } else if (!toleranceHolds(tolerance, expected, got)) {
        this.add({ path: joinPath(segs), problem: "outside_tolerance", expected, got });
      }
      return;
    }
    // `fields` compares only the fields its rules name: skip anything no rule reaches.
    if (this.mode === "fields" && !ruleBelow(this.rules, segs)) return;
    if (got === undefined) {
      this.add({ path: joinPath(segs), problem: "missing", expected });
      return;
    }
    if (Array.isArray(expected)) {
      // DECISION: lists are compared item by item at the same index, and their lengths must
      // match in every mode (a missing or extra line is a real difference); `subset` applies to
      // the items' own fields.
      if (!Array.isArray(got) || got.length !== expected.length) {
        this.add({ path: joinPath(segs), problem: "different", expected, got });
        return;
      }
      expected.forEach((item, i) => {
        this.compare(item, got[i], [...segs, String(i)]);
      });
      return;
    }
    if (isPlainObject(expected)) {
      if (!isPlainObject(got)) {
        this.add({ path: joinPath(segs), problem: "different", expected, got });
        return;
      }
      for (const key of Object.keys(expected)) {
        if (UNSAFE_PATH_SEGMENTS.has(key) || expected[key] === undefined) continue;
        this.compare(expected[key], child(got, key), [...segs, key]);
      }
      if (this.mode === "exact") {
        for (const key of Object.keys(got)) {
          if (got[key] === undefined || UNSAFE_PATH_SEGMENTS.has(key)) continue;
          if (!Object.hasOwn(expected, key)) {
            this.add({ path: joinPath([...segs, key]), problem: "extra", got: got[key] });
          }
        }
      }
      return;
    }
    if (!deepEqual(expected, got)) {
      this.add({ path: joinPath(segs), problem: "different", expected, got });
    }
  }
}

/** Compares a case's output with what it expected, by its matcher. */
export function matchOutput(matcher: Matcher, expected: unknown, got: unknown): MatchResult {
  if (matcher.kind === "label") {
    const label = matcher.label as LabelField;
    const e = valueAt(expected, label.field);
    const g = valueAt(got, label.field);
    const pass = deepEqual(e, g);
    return {
      pass,
      diff: pass ? [] : [{ path: label.field, problem: "different", expected: e, got: g }],
    };
  }
  const walker = new Walker(matcher.kind, rulesOf(matcher));
  walker.compare(expected, got, []);
  return { pass: !walker.failed, diff: walker.diff };
}

/**
 * How a case counts for precision on its label field: whether the skill said the positive label
 * (`predicted`) and whether the case expects it (`actual`); null when the matcher has no label.
 */
export function labelOutcome(
  matcher: Pick<Matcher, "label">,
  expected: unknown,
  got: unknown,
): { field: string; positive: LabelField["positive"]; predicted: boolean; actual: boolean } | null {
  const label = matcher.label;
  if (!label) return null;
  return {
    field: label.field,
    positive: label.positive,
    predicted: deepEqual(valueAt(got, label.field), label.positive),
    actual: deepEqual(valueAt(expected, label.field), label.positive),
  };
}
