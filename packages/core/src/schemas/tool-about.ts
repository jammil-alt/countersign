// What a tool's output is about (docs/reporting-plan.md §3 R1, docs/plan.md §1.188): which output
// fields name the record it read or saved, its label, its number and its amount. Declared on the
// tool like `amount`; the step log keeps it as the run's subjects (`run_subject`) so runs can be
// found by what they were about. Labels and numbers are data, never instructions (invariant 9).
import { z } from "zod";
import { amountOf, ToolAmount } from "../approvals/rules";
import { redactCardNumbers } from "../compliance/card-numbers";
import { isUuid } from "../ids";
import { isPlainObject } from "../json";
import type { SideEffect } from "./permissions";

/** The kinds of thing a run was about (packages/db RUN_SUBJECT_KINDS, migration 0077). */
export const RunSubjectKind = z.enum([
  "document",
  "vendor",
  "customer",
  "organization",
  "person",
  "transaction",
  "item",
  "message",
  "record",
]);
export type RunSubjectKind = z.infer<typeof RunSubjectKind>;

/** What the run did with it (packages/db RUN_SUBJECT_ROLES). */
export const RunSubjectRole = z.enum(["read", "decided", "changed"]);
export type RunSubjectRole = z.infer<typeof RunSubjectRole>;

/** A dotted path into a tool's output: `request.id`, `lines.0.sku`. */
const OutputPath = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.([A-Za-z_][A-Za-z0-9_]*|\d+))*$/, "a dotted path");

/** One record a tool's output names. */
export const ToolAboutEntry = z
  .strictObject({
    kind: RunSubjectKind,
    /**
     * A list in the output whose items are each one such record (`requests`); the paths below are
     * read inside each item. Absent: they are read from the output itself.
     */
    each: OutputPath.optional(),
    /** Our record's id (a uuid). */
    id: OutputPath.optional(),
    /** The name a person reads: a vendor's name, a request's title. */
    label: OutputPath.optional(),
    /** The record's own number: a PO or invoice number. */
    number: OutputPath.optional(),
    /** Where its money is, read as a write's `amount` is (docs/plan.md §1.20). */
    amount: ToolAmount.optional(),
    /** What the run did with it; else `read` for a tool without side effects, `changed` for one. */
    role: RunSubjectRole.optional(),
  })
  .refine((e) => e.id !== undefined || e.label !== undefined || e.number !== undefined, {
    message: "name the record by its id, its label or its number",
  })
  .meta({ id: "ToolAboutEntry" });
export type ToolAboutEntry = z.infer<typeof ToolAboutEntry>;

/** What a tool's output is about: one entry per kind of record it names. */
export const ToolAbout = z.array(ToolAboutEntry).min(1).max(5).meta({ id: "ToolAbout" });
export type ToolAbout = z.infer<typeof ToolAbout>;

/** One thing a run was about, before it is kept (a `run_subject` row without its keys). */
export interface SubjectFacts {
  kind: RunSubjectKind;
  role: RunSubjectRole;
  recordId: string | null;
  connector: string | null;
  externalId: string | null;
  label: string | null;
  number: string | null;
  amount: { value: string; currency: string } | null;
}

/** The most items of one `each` list kept, so one long output can't flood the table. */
export const MAX_ABOUT_ITEMS = 50;
const MAX_LABEL = 200;
const MAX_NUMBER = 64;

function valueAt(node: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  let at = node;
  for (const key of path.split(".")) {
    if (Array.isArray(at) && /^\d+$/.test(key)) at = at[Number(key)];
    else if (isPlainObject(at)) at = at[key];
    else return undefined;
  }
  return at;
}

/**
 * A label or number as it is kept: plain text on one line, cut to its length, card numbers
 * redacted (invariant 14). Never read as instructions: it is shown and matched, nothing more.
 */
export function subjectText(v: unknown, max = MAX_LABEL): string | null {
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "number" && Number.isFinite(v)) s = String(v);
  else if (isPlainObject(v) && typeof (v.name ?? v.displayName) === "string")
    s = String(v.name ?? v.displayName);
  else return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it drops.
  const flat = redactCardNumbers(s.replace(/[\u0000-\u001f\u007f]+/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "") return null;
  return flat.length > max ? flat.slice(0, max).trimEnd() : flat;
}

/** The role a tool's subjects take when its declaration names none. */
export function defaultAboutRole(sideEffect: SideEffect): RunSubjectRole {
  return sideEffect === "none" ? "read" : "changed";
}

/**
 * The records a tool's output names, by its `about` (none without one). An item that names
 * nothing (no id that is a uuid, no label, no number) is left out.
 */
export function aboutOf(
  spec: { about?: ToolAbout | undefined; sideEffect: SideEffect },
  output: unknown,
): SubjectFacts[] {
  if (!spec.about) return [];
  const out: SubjectFacts[] = [];
  for (const entry of spec.about) {
    const items = entry.each === undefined ? [output] : valueAt(output, entry.each);
    if (!Array.isArray(items)) continue;
    for (const item of items.slice(0, MAX_ABOUT_ITEMS)) {
      const id = valueAt(item, entry.id);
      const facts: SubjectFacts = {
        kind: entry.kind,
        role: entry.role ?? defaultAboutRole(spec.sideEffect),
        recordId: typeof id === "string" && isUuid(id) ? id.toLowerCase() : null,
        connector: null,
        externalId: null,
        label: subjectText(valueAt(item, entry.label)),
        number: subjectText(valueAt(item, entry.number), MAX_NUMBER),
        amount: entry.amount ? amountOf({ amount: entry.amount }, item) : null,
      };
      if (facts.recordId || facts.label || facts.number) out.push(facts);
    }
  }
  return out;
}

/**
 * The kind of a record in a client's tool, from its entity (`bill`, `vendor`, `message`), for a
 * change that declares no `about`. What it can't place is a `record`.
 */
// DECISION: words, not a list per connector, so no connector is special-cased; a tool that wants
// another kind declares `about`.
export function subjectKindOfEntity(entity: string | null | undefined): RunSubjectKind {
  const e = (entity ?? "").toLowerCase();
  if (e === "") return "record";
  if (/vendor(?!_?credit)|supplier/.test(e)) return "vendor";
  if (/customer|client/.test(e)) return "customer";
  if (/contact|person|people|lead|employee|user/.test(e)) return "person";
  if (/organi[sz]ation|company/.test(e)) return "organization";
  if (/message|mail|sms|chat|reply/.test(e)) return "message";
  if (/document|file|attachment|attachable|folder|sheet|workbook/.test(e)) return "document";
  if (/^item|product|catalog|sku/.test(e)) return "item";
  if (
    /bill|invoice|payment|purchase|expense|journal|estimate|order|receipt|credit|deposit|transfer|transaction|charge|refund/.test(
      e,
    )
  ) {
    return "transaction";
  }
  return "record";
}
