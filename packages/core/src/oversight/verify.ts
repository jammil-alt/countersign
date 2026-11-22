// Round 4, item D (docs/plan.md §1.211; ARCHITECTURE §10.18): the evidence and verifier layer.
//
// Before a write an agent proposed reaches a person (or goes ahead on its own), a second model call
// works out the same write from the run's sources without seeing the proposal. Code then compares
// the two, field by field: they agree (the write goes on as it would have), they disagree (it goes
// to a person with both answers), or the verifier can't work it out (it goes to the operator). The
// verifier never writes, never changes a step, an approval, a matrix or a mode, and can only send a
// write to a person (invariant 8: it only tightens).
//
// Also here: the client's dollar thresholds (a write at or over one waits for a person, whatever
// the matrix says; only tightens) and the evidence a person reads on the card. Pure, so the
// runtime, the API and both screens share one copy.

import { z } from "zod";
import { isPlainObject } from "../json";
import { CurrencyCode, Decimal, DecimalString } from "../money";

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

/** `definition.oversight.verify`: off, or every write the agent proposes to a client's tool. */
export const VERIFY_MODES = ["off", "writes"] as const;
export const VerifyMode = z.enum(VERIFY_MODES);
export type VerifyMode = z.infer<typeof VerifyMode>;

/** Whether an agent's writes are verified: only `writes`; absent (every agent before) is off. */
export function verifiesWrites(settings: { verify?: VerifyMode | undefined } | undefined): boolean {
  return settings?.verify === "writes";
}

// ── The verifier's answer ───────────────────────────────────────────────────────────────────────

export const VERIFY_FINISH_TOOL = "finish";
export const VERIFY_READ_TOOL = "read_sources";
export const VERIFY_NOTE_MAX = 1000;

/** What the verifier answers through `finish`. */
export const VerifyAnswer = z.object({
  /** False when the sources don't say what the write should be. */
  derivable: z.boolean(),
  /** The write's input as the verifier works it out: only the fields it can tell from the sources. */
  input: z.record(z.string(), z.unknown()).optional(),
  note: z.string().trim().max(VERIFY_NOTE_MAX).default(""),
  sources: z.array(z.string()).max(50).default([]),
});
export type VerifyAnswer = z.infer<typeof VerifyAnswer>;

export function verifyFinishSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      derivable: {
        type: "boolean",
        description:
          "true when the sources say what this change should be; false when they don't (then leave out `input`).",
      },
      input: {
        type: "object",
        description:
          "The tool's input as you work it out from the sources: only the fields the sources tell you. Never guess a field; leave it out.",
      },
      note: {
        type: "string",
        maxLength: VERIFY_NOTE_MAX,
        description: "For the operator, in English: how you worked it out, or why you couldn't.",
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "The record ids you relied on.",
      },
    },
    required: ["derivable", "note"],
  };
}

// ── Comparing ───────────────────────────────────────────────────────────────────────────────────

export const VERIFY_OUTCOMES = ["agreed", "disagreed", "cannot_verify"] as const;
export type VerifyOutcome = (typeof VERIFY_OUTCOMES)[number];

/** Why a write could not be verified (codes, never the model's words: the portal reads them). */
export const VERIFY_CANNOT = [
  /** The run kept nothing to work from. */
  "no_sources",
  /** The verifier said the sources don't say what the write should be. */
  "not_derivable",
  /** It answered, but with no field the write has. */
  "nothing_compared",
  /** The call failed, was cut off or gave no valid answer. */
  "review_failed",
] as const;
export type VerifyCannot = (typeof VERIFY_CANNOT)[number];

/** One field the two answers give differently. */
export const VerifyDifference = z.object({
  /** Dotted path into the tool's input, e.g. `Line.0.Amount`. */
  path: z.string(),
  proposed: z.unknown(),
  derived: z.unknown(),
});
export type VerifyDifference = z.infer<typeof VerifyDifference>;

/**
 * What the card's payload keeps (`payload.verification`). No note, model or cost: the portal
 * shows the payload (invariant 11); the operator reads the call itself in the run's model calls.
 */
export const WriteVerification = z.object({
  outcome: z.enum(VERIFY_OUTCOMES),
  /** How many of the write's fields the verifier worked out and compared. */
  checked: z.number().int().min(0),
  differences: z.array(VerifyDifference),
  reason: z.enum(VERIFY_CANNOT).nullable(),
  /** The record ids the verifier relied on. */
  sources: z.array(z.string()),
});
export type WriteVerification = z.infer<typeof WriteVerification>;

/** The leaves of a JSON value by dotted path (arrays by index). An empty object or array is a leaf. */
export function leaves(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node) && node.length > 0) {
      for (const [i, v] of node.entries()) walk(v, path ? `${path}.${i}` : String(i));
    } else if (isPlainObject(node) && Object.keys(node).length > 0) {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    } else {
      out.set(path, node);
    }
  };
  walk(value, prefix);
  return out;
}

function asDecimal(v: unknown): Decimal | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Decimal(String(v));
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return new Decimal(t);
}

function words(v: string): string {
  return v.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Whether two leaf values say the same: numbers (and numeric text) as decimals, never floats
 * (invariant 6); text without case or extra spaces; anything else exactly.
 */
// DECISION: "1,250.00", "1250" and 1250 agree; "ACME  Supply" and "Acme Supply" agree. A date
// written two ways ("2026-11-03" and "11/3/2026") disagrees: a person looks, rather than code guess
// a date's order (docs/plan.md §1.211).
export function sameValue(a: unknown, b: unknown): boolean {
  const da = asDecimal(a);
  const db = asDecimal(b);
  if (da && db) return da.equals(db);
  if (typeof a === "string" && typeof b === "string") return words(a) === words(b);
  if (a === null || a === undefined) return b === null || b === undefined;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compares the verifier's fields with the proposal's. Only the fields the verifier gave count (it
 * leaves out what the sources don't say); a field it gave that the proposal lacks is a difference.
 */
export function compareDerived(
  proposed: unknown,
  derived: unknown,
): { checked: number; differences: VerifyDifference[] } {
  const want = leaves(proposed);
  const got = leaves(derived);
  const differences: VerifyDifference[] = [];
  let checked = 0;
  for (const [path, value] of got) {
    if (path === "" || value === undefined) continue;
    checked += 1;
    const theirs = want.get(path);
    if (!sameValue(theirs, value)) {
      differences.push({ path, proposed: theirs ?? null, derived: value ?? null });
    }
  }
  return { checked, differences };
}

/** The outcome of one verification, from the verifier's parsed answer (or null: it failed). */
export function verificationOf(
  proposed: unknown,
  answer: VerifyAnswer | null,
  failed: VerifyCannot = "review_failed",
): WriteVerification {
  const cannot = (reason: VerifyCannot): WriteVerification => ({
    outcome: "cannot_verify",
    checked: 0,
    differences: [],
    reason,
    sources: answer?.sources ?? [],
  });
  if (!answer) return cannot(failed);
  if (!answer.derivable || !answer.input) return cannot("not_derivable");
  const { checked, differences } = compareDerived(proposed, answer.input);
  if (checked === 0) return cannot("nothing_compared");
  return {
    outcome: differences.length > 0 ? "disagreed" : "agreed",
    checked,
    differences,
    reason: null,
    sources: answer.sources,
  };
}

// ── Dollar thresholds (per client; only tighten) ────────────────────────────────────────────────

/**
 * A write carrying an amount at or over `approveFrom`, in `currency`, waits for a person, whatever
 * the step, matrix and mode would allow. Below it nothing changes: a write goes ahead on its own
 * only where invariant 8 already allows `auto`.
 */
export const WriteThreshold = z.strictObject({
  currency: CurrencyCode,
  approveFrom: DecimalString,
});
export type WriteThreshold = z.infer<typeof WriteThreshold>;

export const WRITE_THRESHOLDS_MAX = 10;

/** `tenant.settings.write_thresholds`: the thresholds and a revision bumped on every save. */
export const WriteThresholdSet = z.object({
  revision: z.number().int().min(0),
  thresholds: z.array(WriteThreshold).max(WRITE_THRESHOLDS_MAX),
});
export type WriteThresholdSet = z.infer<typeof WriteThresholdSet>;

export const EMPTY_THRESHOLDS: WriteThresholdSet = { revision: 0, thresholds: [] };

/** Reads the stored thresholds; anything unreadable is none (the matrix alone decides). */
export function readWriteThresholds(settings: Record<string, unknown>): WriteThresholdSet {
  const parsed = WriteThresholdSet.safeParse(settings.write_thresholds);
  return parsed.success ? parsed.data : EMPTY_THRESHOLDS;
}

/** The threshold an amount is at or over, in its own currency only (never across currencies). */
export function thresholdReached(
  thresholds: readonly WriteThreshold[],
  amount: { value: string; currency: string } | null,
): WriteThreshold | null {
  if (!amount) return null;
  const t = thresholds.find((x) => x.currency === amount.currency);
  if (!t) return null;
  return new Decimal(amount.value).abs().gte(new Decimal(t.approveFrom)) ? t : null;
}

export interface ThresholdProblem {
  currency: string;
  code: "raised" | "removed" | "duplicate";
  message: string;
}

/**
 * What in `next` would loosen `current`: a threshold raised or removed. Lowering one, or adding
 * one for another currency, only tightens.
 */
export function thresholdLooseningProblems(
  current: readonly WriteThreshold[],
  next: readonly WriteThreshold[],
): ThresholdProblem[] {
  const problems: ThresholdProblem[] = [];
  const seen = new Set<string>();
  for (const t of next) {
    if (seen.has(t.currency)) {
      problems.push({
        currency: t.currency,
        code: "duplicate",
        message: `${t.currency} has two thresholds`,
      });
    }
    seen.add(t.currency);
  }
  for (const old of current) {
    const now = next.find((t) => t.currency === old.currency);
    if (!now) {
      problems.push({
        currency: old.currency,
        code: "removed",
        message: `the ${old.currency} threshold can only be lowered, not removed`,
      });
    } else if (new Decimal(now.approveFrom).gt(new Decimal(old.approveFrom))) {
      problems.push({
        currency: old.currency,
        code: "raised",
        message: `the ${old.currency} threshold can only be lowered`,
      });
    }
  }
  return problems;
}

// ── The evidence on a card ──────────────────────────────────────────────────────────────────────

/** One value the write changes: what the record held before and what it will hold. */
export const EvidenceValue = z.object({
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});

/** Something the run read that the write rests on: a document, a feed line, a vendor. */
export const EvidenceSource = z.object({
  kind: z.string(),
  label: z.string().nullable(),
  number: z.string().nullable(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  /** Our record's id (a document opens from it). */
  recordId: z.string().nullable(),
});
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** A step of the agent's process, by its id and the name the operator gave it. */
export const EvidenceStep = z.object({ id: z.string(), name: z.string() });

/**
 * The evidence for one proposed write (`GET .../inbox/:id/evidence`): read at once from the rows the
 * write already left (its external action, its run's steps and subjects, its document's reading
 * and the card), never stored again.
 */
export const WriteEvidence = z.object({
  itemId: z.string(),
  actionId: z.string().nullable(),
  /** What it read: the run's documents, feed lines and records. */
  sources: z.array(EvidenceSource),
  /** The step that proposes the write, the earlier steps its input came from, and the rule. */
  producedBy: z.object({
    step: EvidenceStep.nullable(),
    from: z.array(EvidenceStep),
    /** The step's `when`, in words, or a client rule the input names. */
    rule: z.string().nullable(),
  }),
  /** 0–1, as text: the document reading's, else the producing step's own. */
  confidence: z.object({
    value: z.string().nullable(),
    basis: z.enum(["document", "step"]).nullable(),
  }),
  values: z.array(EvidenceValue),
  verification: WriteVerification.nullable(),
  threshold: WriteThreshold.nullable(),
});
export type WriteEvidence = z.infer<typeof WriteEvidence>;

/** The values a write changes: each field of the input (or the signer's edit) beside its before. */
export function evidenceValues(
  after: unknown,
  before: unknown,
  max = 40,
): z.infer<typeof EvidenceValue>[] {
  const was = leaves(before);
  const out: z.infer<typeof EvidenceValue>[] = [];
  for (const [path, value] of leaves(after)) {
    if (path === "") continue;
    out.push({
      path,
      before: was.has(path) ? (was.get(path) ?? null) : null,
      after: value ?? null,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** The ids of the earlier steps a step's input reads (`{{steps.<id>.…}}`), in order, once each. */
export function stepsReferenced(input: unknown): string[] {
  const text = JSON.stringify(input ?? null);
  const ids: string[] = [];
  for (const m of text.matchAll(/\{\{\s*steps\.([A-Za-z0-9_-]+)\./g)) {
    const id = m[1] as string;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A confidence somewhere at the top of a step's output (`confidence`, 0–1), as text. */
export function confidenceIn(output: unknown): string | null {
  const read = (v: unknown): string | null => {
    const d = asDecimal(v);
    return d?.gte(0) && d.lte(1) ? d.toFixed() : null;
  };
  if (!isPlainObject(output)) return null;
  const top = read(output.confidence);
  if (top) return top;
  for (const v of Object.values(output)) {
    if (isPlainObject(v)) {
      const inner = read(v.confidence);
      if (inner) return inner;
    }
  }
  return null;
}
