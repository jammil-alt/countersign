// v0.12 W2-C: test cases (ARCHITECTURE §9.10, docs/plan.md §1.46). A case is data: an input,
// fixtures (what each read tool answers, by tool and input), the expected output and a matcher.
// Cases made from a client's records carry that client's id and run and show only in its scope
// (invariant 1); shared cases are the operator's, from synthetic data.

import { z } from "zod";
import { DecimalString } from "../money";
import { Slug, ToolId } from "../schemas/common";

export const TEST_TARGET_KINDS = ["skill", "template"] as const;
export const TestTargetKind = z.enum(TEST_TARGET_KINDS);
export type TestTargetKind = z.infer<typeof TestTargetKind>;

export const TEST_CASE_SOURCES = ["manual", "builder", "run"] as const;
export const TestCaseSource = z.enum(TEST_CASE_SOURCES);
export type TestCaseSource = z.infer<typeof TestCaseSource>;

export const TEST_SUITE_STATUSES = ["running", "done", "failed"] as const;
export const TestSuiteStatus = z.enum(TEST_SUITE_STATUSES);
export type TestSuiteStatus = z.infer<typeof TestSuiteStatus>;

export const TEST_RESULT_STATUSES = ["pass", "fail", "error"] as const;
export const TestResultStatus = z.enum(TEST_RESULT_STATUSES);
export type TestResultStatus = z.infer<typeof TestResultStatus>;

/** Path segments that would reach an object's prototype: never valid in a field path. */
export const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * A field of an output: dot-separated keys and array indexes (`lines.0.unitPrice`); `*` stands for
 * any index (`lines.*.unitPrice`). For a template case the first segment is a step id.
 */
export const FieldPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_$*-]+(?:\.[A-Za-z0-9_$*-]+)*$/, "keys and indexes joined by dots")
  .refine((p) => p.split(".").every((s) => !UNSAFE_PATH_SEGMENTS.has(s)), "not a field name");
export type FieldPath = z.infer<typeof FieldPath>;

/** How close a field must be (docs/plan.md §1.46). */
export const Tolerance = z.discriminatedUnion("kind", [
  /** Equal as JSON. */
  z.strictObject({ kind: z.literal("equal") }),
  /** Numbers: within `abs`, or within `pct` percent of the expected value (the larger allowance). */
  z.strictObject({
    kind: z.literal("number"),
    abs: DecimalString.optional(),
    pct: DecimalString.optional(),
  }),
  /** Money (a decimal string or number): within `abs`, compared with decimal.js (invariant 6). */
  z.strictObject({ kind: z.literal("money"), abs: DecimalString }),
  /** Dates (`YYYY-MM-DD…`): within this many days. */
  z.strictObject({ kind: z.literal("date"), days: z.number().int().min(0).max(366) }),
]);
export type Tolerance = z.infer<typeof Tolerance>;

/** A positive label: the value of a field that counts for precision (e.g. `verdict` = "same"). */
export const LabelField = z.strictObject({
  field: FieldPath,
  positive: z.union([z.string().max(200), z.number(), z.boolean()]),
});
export type LabelField = z.infer<typeof LabelField>;

export const MATCHER_KINDS = ["exact", "subset", "fields", "label"] as const;

/**
 * How a case's output is compared with what it got:
 * - `exact`: equal as JSON (no fields more or fewer), with `tolerances` where named;
 * - `subset`: every expected field is there and equal (with `tolerances`); more fields are fine;
 * - `fields`: only the fields `tolerances` names, each within its tolerance;
 * - `label`: only the label field.
 * `label`, on any kind, also counts the case for precision on that field.
 */
export const Matcher = z
  .strictObject({
    kind: z.enum(MATCHER_KINDS).default("subset"),
    tolerances: z.record(FieldPath, Tolerance).default({}),
    label: LabelField.optional(),
  })
  .refine((m) => m.kind !== "label" || m.label !== undefined, {
    message: "a label matcher names its label field",
    path: ["label"],
  })
  .refine((m) => m.kind !== "fields" || Object.keys(m.tolerances).length > 0, {
    message: "a fields matcher names at least one field",
    path: ["tolerances"],
  })
  .refine((m) => Object.keys(m.tolerances).length <= 100, {
    message: "at most 100 fields",
    path: ["tolerances"],
  });
export type Matcher = z.infer<typeof Matcher>;
export type MatcherInput = z.input<typeof Matcher>;

/**
 * What one read tool answers in a case: for `tool`, when the call's input holds every field of
 * `input` (absent: any input), `output`. The first fixture that matches answers; a call no fixture
 * answers is refused, and every write is refused whatever the fixtures say.
 */
// DECISION: a fixture's input matches as a subset (the fields it names must be equal), so a case
// needn't spell out every optional field a model might send; the first matching fixture wins.
export const Fixture = z.strictObject({
  tool: ToolId,
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.unknown(),
});
export type Fixture = z.infer<typeof Fixture>;

export const Fixtures = z.array(Fixture).max(200);

/** A template case's input: the workflow to run and its trigger payload. */
export const TemplateCaseInput = z.strictObject({
  workflow: Slug,
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type TemplateCaseInput = z.infer<typeof TemplateCaseInput>;

/**
 * A template case's expected output: named step outputs, by step id. The matcher compares these
 * steps only (its paths start with the step id).
 */
export const TemplateCaseExpected = z.record(z.string().min(1).max(100), z.unknown());

const MAX_JSON_CHARS = 200_000;
const boundedJson = (what: string) =>
  z.unknown().refine((v) => JSON.stringify(v ?? null).length <= MAX_JSON_CHARS, {
    message: `${what} is too large`,
  });

/** What the operator writes for a case (the API body; the target is checked by the route). */
export const TestCaseFields = z.strictObject({
  name: z.string().trim().min(1).max(200),
  input: boundedJson("the input"),
  fixtures: Fixtures.default([]),
  expected: boundedJson("the expected output"),
  matcher: Matcher.prefault({}),
  required: z.boolean().default(true),
});
export type TestCaseFields = z.infer<typeof TestCaseFields>;

/** Checks a case's input and expected output against its target kind; problems as sentences. */
export function testCaseProblems(
  kind: TestTargetKind,
  fields: Pick<TestCaseFields, "input" | "expected" | "matcher">,
): string[] {
  const problems: string[] = [];
  if (kind === "template") {
    const input = TemplateCaseInput.safeParse(fields.input);
    if (!input.success) problems.push("a template case's input is {workflow, payload}");
    const expected = TemplateCaseExpected.safeParse(fields.expected);
    if (!expected.success || Object.keys(expected.data).length === 0) {
      problems.push("a template case expects the outputs of one or more steps, by step id");
    }
  }
  return problems;
}
