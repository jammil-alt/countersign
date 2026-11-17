// The client's answers on Getting started (docs/cases-plan.md §4.5; docs/plan.md §1.126.2): which
// cards a person sees, each answer checked against its field's kind, pasted card numbers and social
// security numbers redacted before storage, and the guide as the portal shows it (no fact ids, no
// question's origin: invariant 11). Answers are data (invariant 9): "let it pay bills without
// asking" is a wish, never a setting. Pure.

import { redactCardNumbersDeep } from "../compliance/card-numbers";
import {
  type AnswerValue,
  fieldValueSchema,
  type Guide,
  type GuideField,
  type GuideSection,
} from "./guide";

/** The section keys a person sees: theirs (null: every one). */
export function visibleSectionKeys(guide: Guide, sections: readonly string[] | null): string[] {
  const all = guide.sections.map((s) => s.key);
  return sections === null ? all : all.filter((k) => sections.includes(k));
}

/** A field a person may answer: asked in one of their cards, or shared into one. */
export function fieldFor(
  guide: Guide,
  fieldKey: string,
  visible: readonly string[],
): GuideField | null {
  for (const s of guide.sections) {
    for (const f of s.fields) {
      if (f.key !== fieldKey) continue;
      return visible.includes(f.sectionKey) || f.alsoIn.some((k) => visible.includes(k)) ? f : null;
    }
  }
  return null;
}

// A social security number written as one (123-45-6789): never kept (cases-plan §4.5).
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

function redactSsn<T>(value: T): T {
  if (typeof value === "string") return value.replace(SSN, "[number removed]") as T;
  if (Array.isArray(value)) return value.map((v) => redactSsn(v)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactSsn(v)]),
    ) as T;
  }
  return value;
}

/** An answer's value as stored: card numbers and social security numbers taken out. */
// DECISION: a pasted secret is redacted, not refused: the rest of the answer is still theirs, and
// refusing would teach nothing. Passwords can't be told from words, so no question asks for one
// (the guide drops any that would) and the page says we never ask.
export function redactAnswer<T>(value: T): T {
  return redactSsn(redactCardNumbersDeep(value));
}

export type AnswerCheck = { ok: true; value: AnswerValue } | { ok: false; message: string };

/**
 * An answer checked against its field: the kind's shape (core `fieldValueSchema`), a choice one
 * of the field's, then redacted. Files and tools are checked by the server against the client's own
 * documents and connections.
 */
export function checkAnswer(
  field: Pick<GuideField, "kind" | "choices">,
  value: unknown,
): AnswerCheck {
  const parsed = fieldValueSchema(field.kind).safeParse(value);
  if (!parsed.success) return { ok: false, message: `not a ${field.kind.replace("_", " ")}` };
  const v = parsed.data as AnswerValue;
  if (field.kind === "choice" && field.choices && !field.choices.includes(v as string)) {
    return { ok: false, message: "not one of the choices" };
  }
  if (
    field.kind === "choices" &&
    field.choices &&
    !(v as string[]).every((c) => field.choices?.includes(c))
  ) {
    return { ok: false, message: "not one of the choices" };
  }
  return { ok: true, value: redactAnswer(v) };
}

/** The latest answer to each field, from answers oldest first. */
export function latestByField<T extends { fieldKey: string }>(answers: readonly T[]): T[] {
  const out = new Map<string, T>();
  for (const a of answers) {
    out.delete(a.fieldKey);
    out.set(a.fieldKey, a);
  }
  return [...out.values()];
}

/** A field as the portal shows it: "We think" in words, never the facts behind it or who wrote it. */
export function portalField(f: GuideField) {
  const { origin: _origin, weThink, ...rest } = f;
  return {
    ...rest,
    weThink: weThink ? { value: weThink.value, text: weThink.text } : null,
  };
}

/** A section as the portal shows it: known fields left out (they aren't asked). */
// DECISION: what the file has confirmed isn't shown to the client again; it is on the scope.
export function portalSection(s: GuideSection) {
  return { ...s, fields: s.fields.filter((f) => f.state !== "known").map(portalField) };
}
