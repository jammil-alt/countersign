// The intake's guide (docs/cases-plan.md §4.2 step 3, §4.5; docs/plan.md §1.125): one section for
// the general questions, one per area, one per agent template, each a list of fields. Shared
// questions are asked once (merged), and each field is filled from the client file's `theirs`
// facts: known (not asked), to confirm ("We think: …", Yes or Change), to ask, or later. Both ways
// through (the cards and Sloan) read and write the same guide; the plain form always works.
//
// The schemas and the small helpers here are the contract every onboarding stream shares. The
// guide's building and merging (`buildGuide`, `mergeFields`, `guideTotals`, `guideProgress`) are
// stream INTAKE's: stubs until it lands.

import { z } from "zod";
import { isUuid } from "../ids";
import { MoneySchema } from "../money";
import { FactSection } from "./facts";
import { type Covers, IntakeArea } from "./starts";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date such as 2026-12-24");

export const GUIDE_VERSION = 1 as const;

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────

export const GUIDE_SECTION_KINDS = ["general", "area", "agent"] as const;
export const GuideSectionKind = z.enum(GUIDE_SECTION_KINDS);
export type GuideSectionKind = z.infer<typeof GuideSectionKind>;

/** A section's key: `general`, `area:<area>` or `agent:<template id>`. */
export const GuideSectionKey = z
  .string()
  .regex(
    /^(general|area:[a-z_]+|agent:[0-9a-f-]{36})$/,
    "general, area:<area> or agent:<template id>",
  );
export type GuideSectionKey = z.infer<typeof GuideSectionKey>;

export const GENERAL_SECTION_KEY = "general";
export const areaSectionKey = (area: IntakeArea): GuideSectionKey => `area:${area}`;
export const agentSectionKey = (templateId: string): GuideSectionKey => `agent:${templateId}`;

/** The section keys a covers asks for, in the guide's order: general, areas, agents. */
export function sectionKeysOf(covers: Covers): GuideSectionKey[] {
  return [
    ...(covers.general ? [GENERAL_SECTION_KEY] : []),
    ...covers.areas.map(areaSectionKey),
    ...covers.templateIds.map(agentSectionKey),
  ];
}

// ── Fields ───────────────────────────────────────────────────────────────────────────────────────

export const GUIDE_FIELD_KINDS = [
  "text",
  "long_text",
  "number",
  "money",
  "date",
  "choice",
  "choices",
  "yes_no",
  "files",
  "tool",
] as const;
export const GuideFieldKind = z.enum(GUIDE_FIELD_KINDS);
export type GuideFieldKind = z.infer<typeof GuideFieldKind>;

/**
 * A field's state in a guide: `known` (a confirmed fact: not asked), `to_confirm` (a `theirs`
 * fact we think is right: "We think …", Yes or Change), `to_ask`, or `later` (the operator's "ask
 * later": becomes an open item once the scope is signed).
 */
export const GUIDE_FIELD_STATES = ["known", "to_confirm", "to_ask", "later"] as const;
export const GuideFieldState = z.enum(GUIDE_FIELD_STATES);
export type GuideFieldState = z.infer<typeof GuideFieldState>;

/** Who wrote a question: core (general and generic areas), a pack, a template's form, the operator. */
export const GUIDE_FIELD_ORIGINS = ["core", "pack", "template", "operator"] as const;
export const GuideFieldOrigin = z.enum(GUIDE_FIELD_ORIGINS);
export type GuideFieldOrigin = z.infer<typeof GuideFieldOrigin>;

/** A field's key: stable across versions of the guide, e.g. `general.approver`. */
export const GuideFieldKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.:-]{0,99}$/, "a field key such as general.approver");
export type GuideFieldKey = z.infer<typeof GuideFieldKey>;

export const GUIDE_LABEL_MAX = 300;
export const GUIDE_HINT_MAX = 300;
export const GUIDE_CHOICES_MAX = 30;

/** An answer's value, by the field's kind. Text is the client's words: data, never instructions. */
export function fieldValueSchema(kind: GuideFieldKind) {
  switch (kind) {
    case "text":
      return z.string().trim().min(1).max(500);
    case "long_text":
      return z.string().trim().min(1).max(4000);
    case "number":
      return z.number().finite();
    case "money":
      return MoneySchema;
    case "date":
      return Day;
    case "choice":
      return z.string().trim().min(1).max(200);
    case "choices":
      return z.array(z.string().trim().min(1).max(200)).min(1).max(GUIDE_CHOICES_MAX);
    case "yes_no":
      return z.boolean();
    case "files":
      return z.object({ documentIds: z.array(Id).min(1).max(20) });
    case "tool":
      return z.object({ connectionId: Id });
  }
}

/** Any field's value, as stored (`intake_answer.value`) and returned. */
export const AnswerValue = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(200)).max(GUIDE_CHOICES_MAX),
  MoneySchema,
  z.object({ documentIds: z.array(z.string()).max(20) }),
  z.object({ connectionId: z.string() }),
]);
export type AnswerValue = z.infer<typeof AnswerValue>;

/**
 * A question as a source declares it: core's general and generic area sections, a pack's area
 * section (its manifest, as data), a template's client intake form (read into this shape).
 */
export const GuideFieldSource = z.strictObject({
  key: GuideFieldKey,
  label: z.string().trim().min(1).max(GUIDE_LABEL_MAX),
  kind: GuideFieldKind,
  choices: z.array(z.string().trim().min(1).max(200)).max(GUIDE_CHOICES_MAX).optional(),
  hint: z.string().trim().max(GUIDE_HINT_MAX).default(""),
  /** The build can't start without it. */
  requiredToStart: z.boolean().default(false),
  /** Where a confirmed answer is filed in the client file; omitted: not filed. */
  fileSection: FactSection.optional(),
  /** Kind `tool`: the connector to connect (e.g. `qbo`). */
  connector: z.string().trim().min(1).max(60).optional(),
  /**
   * Fields with the same share key are one question ("who approves"), asked once in the first
   * section that has it.
   */
  shareKey: GuideFieldKey.optional(),
});
export type GuideFieldSource = z.infer<typeof GuideFieldSource>;
export type GuideFieldSourceInput = z.input<typeof GuideFieldSource>;

/** A section as a source declares it. A pack's manifest carries one for its area (`kind: area`). */
export const GuideSectionSource = z.strictObject({
  kind: GuideSectionKind,
  area: IntakeArea.optional(),
  templateId: Id.optional(),
  title: z.string().trim().min(1).max(120),
  /** One sentence: what this part is about, or for an agent what it would do for them. */
  intro: z.string().trim().max(400).default(""),
  fields: z.array(GuideFieldSource).max(60),
});
export type GuideSectionSource = z.infer<typeof GuideSectionSource>;
export type GuideSectionSourceInput = z.input<typeof GuideSectionSource>;

/** What we think the answer is, from the file: the value and the facts behind it. */
export const WeThink = z.object({
  value: AnswerValue,
  /** In words, as the card shows it: "Bills come to ap@acme.com". */
  text: z.string().max(2000),
  factIds: z.array(z.string()).max(20),
});
export type WeThink = z.infer<typeof WeThink>;

export const GuideField = z.object({
  key: GuideFieldKey,
  /** The section it is asked in. */
  sectionKey: GuideSectionKey,
  /** The other sections that need it (merged: asked once). */
  alsoIn: z.array(GuideSectionKey),
  label: z.string().max(GUIDE_LABEL_MAX),
  kind: GuideFieldKind,
  choices: z.array(z.string()).max(GUIDE_CHOICES_MAX).optional(),
  hint: z.string().max(GUIDE_HINT_MAX),
  requiredToStart: z.boolean(),
  state: GuideFieldState,
  /** `known` and `to_confirm`: what the file says. */
  weThink: WeThink.nullable(),
  fileSection: FactSection.nullable(),
  connector: z.string().nullable(),
  origin: GuideFieldOrigin,
});
export type GuideField = z.infer<typeof GuideField>;

export const GuideSection = z.object({
  key: GuideSectionKey,
  kind: GuideSectionKind,
  area: IntakeArea.nullable(),
  templateId: z.string().nullable(),
  title: z.string(),
  intro: z.string(),
  fields: z.array(GuideField),
});
export type GuideSection = z.infer<typeof GuideSection>;

/** What the operator sees before sending: "6 to confirm, 8 questions, 1 tool, about 15 minutes". */
export const GuideTotals = z.object({
  known: z.number().int().min(0),
  toConfirm: z.number().int().min(0),
  toAsk: z.number().int().min(0),
  later: z.number().int().min(0),
  tools: z.number().int().min(0),
  minutes: z.number().int().min(0),
});
export type GuideTotals = z.infer<typeof GuideTotals>;

/** The guide as stored on the intake (`intake.guide`) and returned. Only `theirs` facts in it. */
export const Guide = z.object({
  version: z.literal(GUIDE_VERSION),
  sections: z.array(GuideSection),
  totals: GuideTotals,
});
export type Guide = z.infer<typeof Guide>;

/** The operator's changes at Invite's step 3: drop, ask later, reword, add. */
export const GuideEdits = z.strictObject({
  drop: z.array(GuideFieldKey).max(200).default([]),
  later: z.array(GuideFieldKey).max(200).default([]),
  reword: z
    .array(
      z.strictObject({
        key: GuideFieldKey,
        label: z.string().trim().min(1).max(GUIDE_LABEL_MAX),
        hint: z.string().trim().max(GUIDE_HINT_MAX).optional(),
      }),
    )
    .max(200)
    .default([]),
  add: z
    .array(
      z.strictObject({
        sectionKey: GuideSectionKey,
        label: z.string().trim().min(1).max(GUIDE_LABEL_MAX),
        kind: GuideFieldKind,
        choices: z.array(z.string().trim().min(1).max(200)).max(GUIDE_CHOICES_MAX).optional(),
        hint: z.string().trim().max(GUIDE_HINT_MAX).default(""),
        requiredToStart: z.boolean().default(false),
      }),
    )
    .max(40)
    .default([]),
});
export type GuideEdits = z.infer<typeof GuideEdits>;
export type GuideEditsInput = z.input<typeof GuideEdits>;

/** A `theirs` fact as the guide reads it to fill fields (never an `ours` one). */
export interface GuideFact {
  id: string;
  section: FactSection;
  text: string;
  sureness: "heard" | "seen" | "confirmed";
  /** The field it answers, when it came from an earlier intake's answer. */
  fieldKey?: string | null;
}

export interface BuildGuideInput {
  covers: Covers;
  /** Core's general section (when covered). */
  general: GuideSectionSource | null;
  /** One per covered area: the pack's section, else core's generic one for that area. */
  areas: readonly GuideSectionSource[];
  /** One per covered template: its client intake form, read into a section. */
  agents: readonly GuideSectionSource[];
  /** The file's current `theirs` facts. */
  facts: readonly GuideFact[];
  edits?: GuideEdits;
}

const notBuilt = (what: string): never => {
  throw new Error(`${what} is not built yet (stream INTAKE, docs/plan.md §1.125)`);
};

/**
 * The guide for an intake: sections in covers' order, shared fields merged (`mergeFields`), each
 * field's state from the facts, the operator's edits applied, the totals counted.
 */
// Stream INTAKE builds this (cases-plan O2).
export function buildGuide(_input: BuildGuideInput): Guide {
  return notBuilt("buildGuide");
}

/**
 * Merges fields asked in more than one section (the same `shareKey`, or the same key): kept in the
 * first section that asks it, the rest named in `alsoIn`; required if any asker requires it.
 */
// Stream INTAKE builds this (cases-plan O2).
export function mergeFields(_sections: readonly GuideSection[]): GuideSection[] {
  return notBuilt("mergeFields");
}

/** The totals the operator sees, minutes included. */
// Stream INTAKE builds this (cases-plan O2).
export function guideTotals(_sections: readonly GuideSection[]): GuideTotals {
  return notBuilt("guideTotals");
}

/** A section's progress for the client's cards and the build's Requirements panel. */
export const SectionProgress = z.object({
  sectionKey: GuideSectionKey,
  answered: z.number().int().min(0),
  total: z.number().int().min(0),
  notSure: z.number().int().min(0),
  /** Required to start and not answered yet, with who has each when someone was asked. */
  missing: z.array(
    z.object({ fieldKey: GuideFieldKey, label: z.string(), who: z.string().nullable() }),
  ),
  decision: z.enum(["start", "not_now"]).nullable(),
});
export type SectionProgress = z.infer<typeof SectionProgress>;

/** Progress per section from the guide and the latest answer to each field. */
// Stream INTAKE builds this (cases-plan O2/O3).
export function guideProgress(
  _guide: Guide,
  _answers: readonly { fieldKey: string; state: string }[],
): SectionProgress[] {
  return notBuilt("guideProgress");
}
