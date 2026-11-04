import { z } from "zod";
import { localizedText } from "../i18n/locale";

/** A JSON Schema document (draft 2020-12), as produced by z.toJSONSchema or the operator's field editor. */
export const JsonSchema = z
  .record(z.string(), z.unknown())
  .meta({ id: "JsonSchema", description: "A JSON Schema object" });
export type JsonSchema = z.infer<typeof JsonSchema>;

export const Slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and dashes");

/**
 * Ids of steps, fork paths and triggers. Generated once (uuid v7 by the builder), copied on fork and
 * never regenerated: merges line items up by them (CLAUDE.md invariant 3). Any non-empty token is
 * accepted so hand-written seed bundles can use readable ids.
 */
export const NodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "letters, digits, - and _");

/** A string that may contain `{{...}}` references (ARCHITECTURE §10.1). */
export const TemplateString = z.string().meta({ description: "Text with {{...}} references" });

/**
 * A client-facing template (skill and tool `summary`): one string (English), or a version per
 * language with English required (docs/plan.md §1.18). The string form stays valid, so stored
 * versions parse unchanged (invariant 3).
 */
export const LocalizedTemplate = localizedText(TemplateString).meta({
  description: "Text with {{...}} references, as one string or a version per language",
});

/** A JSON value whose strings may contain `{{...}}` references; the shape of a step's input. */
export const TemplateObject = z.record(z.string(), z.unknown());

/** Tool ids `<source>.<entity>.<verb>` or platform `<area>.<name>` (ARCHITECTURE §6.1, §9.4). */
export const ToolId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/, "dotted lowercase, e.g. qbo.bill.query");

/** Skill ids: `docs.extract`, `materials.match-lines`, `custom:<slug>`. */
export const SkillId = z
  .string()
  .regex(
    /^(custom:[a-z0-9]+(?:-[a-z0-9]+)*|[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+)$/,
    "e.g. docs.extract or custom:<slug>",
  );

/** A skill reference in a bundle: the id, optionally pinned `@<version>`. */
export const SkillRef = z
  .string()
  .regex(
    /^(custom:[a-z0-9]+(?:-[a-z0-9]+)*|[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+)(@\d+)?$/,
    "a skill id, optionally @<version>",
  );

export function parseSkillRef(ref: string): { id: string; version: number | null } {
  const at = ref.lastIndexOf("@");
  if (at === -1) return { id: ref, version: null };
  return { id: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}
