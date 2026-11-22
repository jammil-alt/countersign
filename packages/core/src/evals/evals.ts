// docs/plan.md §1.212 (round 4, plan 2): the eval and replay harness. A workflow's dataset is a set
// of cases, each a trigger, the client's world as the case starts (synthetic, never a client's
// records), and the writes the run should make. A case is scored on its writes (exact match), the
// verifier's agreement (once the verifier lands: a hook here), its cost and its run time. The
// golden datasets live in `fixtures/evals/` and run in CI on replayed model answers; a case saved
// from an approved or corrected inbox item is a test bench case (`test_case`, §1.46) whose expected
// output carries the same writes under `$writes`.

import { z } from "zod";
import { isPlainObject } from "../json";
import { Decimal } from "../money";
import { type VerifyOutcome, WriteVerification } from "../oversight/verify";
import { Slug } from "../schemas/common";
import { FieldPath, type Matcher, Tolerance } from "../testbench/case";
import { type MatchDiff, matchOutput } from "../testbench/match";

/** The key of a template case's expected output that holds its expected writes. */
// DECISION: `$` can't start a step id, so the key never meets a step's output.
export const WRITES_KEY = "$writes";
/**
 * Beside `$writes`: `all` (the default) holds the run to exactly those writes; `named` only to
 * the steps they name (a case saved from one approved change names that change alone).
 */
export const WRITES_SCOPE_KEY = "$writesScope";
export const WRITES_SCOPES = ["all", "named"] as const;
export type WritesScope = (typeof WRITES_SCOPES)[number];

/** A step id (inside a for_each, the child step's own id). */
const StepId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "a step id");

/**
 * One write the run should make: the write step and what it must hold. `expect` is compared as a
 * subset of `{tool, input, output}` (only the fields it names; lists item by item, their lengths
 * equal), so ids a run makes up and wording nobody judges are left out.
 */
export const ExpectedWrite = z.strictObject({
  step: StepId,
  expect: z
    .strictObject({
      tool: z.string().max(200).optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
    })
    .default({}),
});
export type ExpectedWrite = z.infer<typeof ExpectedWrite>;
export type ExpectedWriteInput = z.input<typeof ExpectedWrite>;

export const ExpectedWrites = z.array(ExpectedWrite).max(200);

/** A write a run made (or, in a test run, would have made): a write step that succeeded. */
export interface RunWrite {
  /** The step id (a for_each child's own id). */
  step: string;
  /** The step's node id in the run (`post:0:write-purchase` inside a for_each). */
  nodeId: string;
  tool: string | null;
  input: unknown;
  output: unknown;
}

/** One golden case of a dataset. */
export const EvalCase = z.strictObject({
  id: Slug,
  name: z.string().trim().min(1).max(200),
  /** Plain tags for reading the scorecard (`rules`, `model`, `contract`, …). */
  tags: z.array(Slug).max(10).default([]),
  /** The trigger's payload; `@name` strings are the world's ids (see `resolveRefs`). */
  trigger: z.record(z.string(), z.unknown()).default({}),
  /** A skill's parameters as a client agent sets them (the skill ref's `parameters`), by skill id. */
  parameters: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** The client's records as the case starts, in the dataset's own shape (its world seeder). */
  world: z.unknown(),
  /** Every write the run makes, in order per step. A write not listed fails the case. */
  writes: ExpectedWrites,
  /**
   * A guard case: the run stops at this step (a for_each child's own id) with an error that holds
   * `error`; the writes before it are scored as usual. Absent, any stop but a person's is an error.
   */
  stops: z.strictObject({ step: StepId, error: z.string().min(1).max(500) }).optional(),
  /** Paths `<step>.<index>.<input|output>.…`, `*` for any index. */
  tolerances: z.record(FieldPath, Tolerance).default({}),
  /**
   * The model's answers (each a `finish` input, in call order) the case was written with. Only
   * read when its replays are written by hand (no API key); tests replay `fixtures/llm`.
   */
  answers: z.array(z.unknown()).max(20).default([]),
  /**
   * The verifier's answers (§1.211: each its `finish` input, in the order the case's external
   * writes are checked), written by hand like `answers`.
   */
  checks: z.array(z.unknown()).max(20).default([]),
  /** Why the case is here: what it proves. */
  note: z.string().max(1000).optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;
export type EvalCaseInput = z.input<typeof EvalCase>;

export const EVAL_DATASET_SCHEMA = 1;

/** A workflow's dataset: the template's workflow and its cases. */
export const EvalDataset = z
  .strictObject({
    schemaVersion: z.literal(EVAL_DATASET_SCHEMA),
    /** The template's slug. */
    template: Slug,
    /** The workflow's slug. */
    workflow: Slug,
    description: z.string().max(2000).default(""),
    cases: z.array(EvalCase).min(1).max(500),
  })
  .refine((d) => new Set(d.cases.map((c) => c.id)).size === d.cases.length, {
    message: "case ids are unique",
    path: ["cases"],
  });
export type EvalDataset = z.infer<typeof EvalDataset>;
export type EvalDatasetInput = z.input<typeof EvalDataset>;

/**
 * Replaces each string `@name` (whole string; a name may hold spaces, `@account:Bank Fees`), and
 * each `{@name}` inside a string (`bt-{@txn:shell}`), with the world's id for `name`; an unknown
 * name is
 * an error, so a typo never compares as a literal.
 */
export function resolveRefs<T>(value: T, ids: Readonly<Record<string, string>>): T {
  const idOf = (name: string): string => {
    const id = ids[name];
    if (id === undefined) throw new Error(`no world id named @${name}`);
    return id;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && /^@[A-Za-z0-9_.:-][A-Za-z0-9_.: -]*$/.test(v)) {
      return idOf(v.slice(1));
    }
    if (typeof v === "string" && v.includes("{@")) {
      return v.replace(/\{@([A-Za-z0-9_.:-][A-Za-z0-9_.: -]*)\}/g, (_m, name: string) =>
        idOf(name),
      );
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v))
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The step id of a run node: a for_each child's node id is `<loop>:<index>:<child>`. */
export function stepIdOf(nodeId: string): string {
  const parts = nodeId.split(":");
  return parts[parts.length - 1] ?? nodeId;
}

/** Writes grouped by step, in run order. */
function byStep<T extends { step: string }>(writes: readonly T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const w of writes) {
    out[w.step] ??= [];
    out[w.step]?.push(w);
  }
  return out;
}

export interface WriteScore {
  /** Every write expected was made, holding what it should, and no other. */
  exact: boolean;
  /** Steps expected to write that didn't (or wrote fewer times). */
  missing: string[];
  /** Steps that wrote and weren't expected to (or wrote more times). */
  extra: string[];
  /** Field differences in the writes both made. */
  fields: MatchDiff[];
}

/**
 * Scores a run's writes against a case's (docs/plan.md §1.212). Exact match: the same write steps
 * the same number of times, and every field each expected write names equal (within the case's
 * tolerances).
 */
// DECISION: "exact" is exact on which writes happen and on every field a case names; fields it
// leaves out (ids a run makes up, timestamps) aren't compared. A golden names the fields a person
// checking the run would check.
export function scoreWrites(
  expected: readonly ExpectedWrite[],
  got: readonly RunWrite[],
  tolerances: Record<string, Tolerance> = {},
  scope: WritesScope = "all",
): WriteScore {
  if (scope === "named") return scoreNamed(expected, got, tolerances);
  const want = byStep(expected);
  const have = byStep(got);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [step, list] of Object.entries(want)) {
    const n = have[step]?.length ?? 0;
    if (n < list.length) missing.push(step);
  }
  for (const [step, list] of Object.entries(have)) {
    const n = want[step]?.length ?? 0;
    if (list.length > n) extra.push(step);
  }
  // The writes both made, compared item by item as subsets.
  const e: Record<string, unknown[]> = {};
  const g: Record<string, unknown[]> = {};
  for (const [step, list] of Object.entries(want)) {
    const made = have[step] ?? [];
    const n = Math.min(list.length, made.length);
    e[step] = list.slice(0, n).map((w) => w.expect);
    g[step] = made.slice(0, n).map((w) => ({ tool: w.tool, input: w.input, output: w.output }));
  }
  const matcher: Matcher = { kind: "subset", tolerances };
  const match = matchOutput(matcher, e, g);
  return {
    exact: missing.length === 0 && extra.length === 0 && match.pass,
    missing: missing.sort(),
    extra: extra.sort(),
    fields: match.diff,
  };
}

/**
 * The named scope: each expected write is matched by some write of its step (a step in a loop
 * writes once per item, and a case saved from one approved change names that one); other writes
 * aren't held to anything.
 */
function scoreNamed(
  expected: readonly ExpectedWrite[],
  got: readonly RunWrite[],
  tolerances: Record<string, Tolerance>,
): WriteScore {
  const missing: string[] = [];
  const fields: MatchDiff[] = [];
  for (const [i, w] of expected.entries()) {
    const own = Object.fromEntries(
      Object.entries(tolerances)
        .filter(([p]) => p.startsWith(`${w.step}.`))
        .map(([p, t]) => [p.split(".").slice(2).join("."), t]),
    );
    const tries = got
      .filter((g) => g.step === w.step)
      .map((g) =>
        matchOutput({ kind: "subset", tolerances: own }, w.expect, {
          tool: g.tool,
          input: g.input,
          output: g.output,
        }),
      );
    if (tries.some((t) => t.pass)) continue;
    missing.push(w.step);
    const closest = tries[0];
    if (closest) {
      fields.push(...closest.diff.map((d) => ({ ...d, path: `${w.step}.${i}.${d.path}` })));
    }
  }
  return { exact: missing.length === 0, missing: [...new Set(missing)].sort(), extra: [], fields };
}

export const EVAL_CASE_STATUSES = ["pass", "fail", "error"] as const;
export type EvalCaseStatus = (typeof EVAL_CASE_STATUSES)[number];

export interface EvalCaseResult {
  caseId: string;
  status: EvalCaseStatus;
  /** Exact match on writes (false for an error). */
  exact: boolean;
  /** Whether the verifier agreed with the case's writes; null: it checked none. */
  verifier: boolean | null;
  /** The verifier's outcome on the case's writes (`verificationOfWrites`); null: none checked. */
  verification?: VerifyOutcome | null;
  costUsd: string;
  ms: number;
  score?: WriteScore;
  error?: string;
}

/**
 * The verifier's outcome on a run's writes (§1.211, kept on a test run's write output): disagreed
 * when it disagreed with any, else cannot_verify when it couldn't work one out, else agreed; null
 * when it checked none (no external write, or the agent doesn't verify).
 */
// DECISION: one outcome per case, the worst of its writes': a case is as trustworthy as its least
// checked write. Agreement is agreed over every case the verifier looked at, cannot_verify included.
export function verificationOfWrites(writes: readonly RunWrite[]): VerifyOutcome | null {
  const outcomes = writes
    .map((w) =>
      isPlainObject(w.output) ? WriteVerification.safeParse(w.output.verification) : null,
    )
    .filter((r) => r?.success)
    .map((r) => (r?.success ? r.data.outcome : null));
  if (outcomes.length === 0) return null;
  if (outcomes.includes("disagreed")) return "disagreed";
  if (outcomes.includes("cannot_verify")) return "cannot_verify";
  return "agreed";
}

export interface EvalScorecard {
  cases: number;
  passed: number;
  errors: number;
  /** Cases with an exact match on writes / cases, 0 to 1. */
  exactRate: number;
  /** Cases the verifier agreed with / cases it judged; null when it judged none. */
  verifierAgreement: number | null;
  verifierChecked: number;
  /** The verifier's outcomes, by case. */
  verification: { agreed: number; disagreed: number; cannotVerify: number };
  /** USD, 6 places. */
  costUsd: string;
  costPerCase: string;
  /** Run time, milliseconds. */
  msMedian: number;
  msP90: number;
}

const ratio = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000);

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] ?? 0;
}

/** A dataset's scorecard from its cases' results. */
export function evalScorecard(
  results: readonly (Pick<EvalCaseResult, "status" | "exact" | "verifier" | "costUsd" | "ms"> &
    Pick<Partial<EvalCaseResult>, "verification">)[],
): EvalScorecard {
  const cases = results.length;
  const cost = results.reduce((s, r) => s.plus(r.costUsd || "0"), new Decimal(0));
  const judged = results.filter((r) => r.verifier !== null);
  const ms = results.map((r) => r.ms);
  return {
    cases,
    passed: results.filter((r) => r.status === "pass").length,
    errors: results.filter((r) => r.status === "error").length,
    exactRate: ratio(results.filter((r) => r.exact).length, cases),
    verifierAgreement:
      judged.length === 0 ? null : ratio(judged.filter((r) => r.verifier).length, judged.length),
    verifierChecked: judged.length,
    verification: {
      agreed: results.filter((r) => r.verification === "agreed").length,
      disagreed: results.filter((r) => r.verification === "disagreed").length,
      cannotVerify: results.filter((r) => r.verification === "cannot_verify").length,
    },
    costUsd: cost.toFixed(6),
    costPerCase: cases === 0 ? "0.000000" : cost.div(cases).toFixed(6),
    msMedian: percentile(ms, 50),
    msP90: percentile(ms, 90),
  };
}

/** The writes of a template case's expected output (`$writes`), and their scope; null: none. */
export function expectedWritesOf(
  expected: unknown,
): { writes: ExpectedWrite[]; scope: WritesScope } | null {
  if (!isPlainObject(expected) || !Object.hasOwn(expected, WRITES_KEY)) return null;
  const parsed = ExpectedWrites.safeParse(expected[WRITES_KEY]);
  if (!parsed.success) return null;
  return { writes: parsed.data, scope: expected[WRITES_SCOPE_KEY] === "named" ? "named" : "all" };
}

/** A run's writes from its step rows: write steps (and v3 action steps) that succeeded. */
export function runWrites(
  steps: readonly {
    nodeId: string;
    nodeType: string;
    status: string;
    input: unknown;
    output: unknown;
  }[],
  toolOf: (stepId: string) => string | null,
): RunWrite[] {
  return steps
    .filter((s) => (s.nodeType === "write" || s.nodeType === "action") && s.status === "succeeded")
    .map((s) => {
      const step = stepIdOf(s.nodeId);
      return {
        step,
        nodeId: s.nodeId,
        tool: toolOf(step),
        input: s.input ?? null,
        output: s.output ?? null,
      };
    });
}

/** Every write step's tool (a v3 action step's tool, a v4 write's tool or action), by step id. */
export function writeStepTools(workflows: unknown): Map<string, string> {
  const tools = new Map<string, string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isPlainObject(v)) return;
    if (typeof v.id === "string" && (v.kind === "write" || v.kind === "action")) {
      const tool =
        typeof v.tool === "string" ? v.tool : typeof v.action === "string" ? v.action : null;
      if (tool) tools.set(v.id, tool);
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(workflows);
  return tools;
}
