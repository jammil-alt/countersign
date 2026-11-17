// The intake's guide (docs/cases-plan.md §4.2 step 3, §4.5; docs/plan.md §1.126): one section for
// the general questions, one per area, one per agent template, each a list of fields. Shared
// questions are asked once (merged), and each field is filled from the client file's `theirs`
// facts: known (not asked), to confirm ("We think: …", Yes or Change), to ask, or later. Both ways
// through (the cards and Sloan) read and write the same guide; the plain form always works.
//
// The schemas and the small helpers here are the contract every onboarding stream shares; the
// building, merging, counting and progress below are pure (stream INTAKE, docs/plan.md §1.126.2).

import { z } from "zod";
import { asksForSecret } from "../forms";
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
  /** The operator's edits (Invite's step 3), as sent or parsed. */
  edits?: GuideEditsInput;
}

// ── Building the guide (stream INTAKE, docs/plan.md §1.126.2) ───────────────────────────────────

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

/** The key a source's field is asked under: its share key, so a shared question is one field. */
const askedKey = (f: GuideFieldSource): string => f.shareKey ?? f.key;

/**
 * Who wrote a question, from its key: core's are `general.*`, `area.*` (the generic area
 * questions) and `tool.*`; an agent section's others are its template's; an area's others its
 * pack's.
 */
// DECISION: the origin is read from the key, so a source needs no field for it: core's keys have
// their own prefixes, which packs and templates don't use.
function originOf(key: string, kind: GuideSectionKind): GuideFieldOrigin {
  if (/^(general|area|tool)\./.test(key)) return "core";
  return kind === "agent" ? "template" : "pack";
}

function sectionKeyOf(src: GuideSectionSource): GuideSectionKey | null {
  if (src.kind === "general") return GENERAL_SECTION_KEY;
  if (src.kind === "area") return src.area ? areaSectionKey(src.area) : null;
  return src.templateId ? agentSectionKey(src.templateId) : null;
}

function sectionOf(src: GuideSectionSource): GuideSection | null {
  const key = sectionKeyOf(src);
  if (!key) return null;
  const seen = new Set<string>();
  const fields: GuideField[] = [];
  for (const f of src.fields) {
    const k = askedKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    // A question that asks for a secret is never put in a guide (cases-plan §4.5).
    if (asksForSecret(f.label, f.hint)) continue;
    fields.push({
      key: k,
      sectionKey: key,
      alsoIn: [],
      label: f.label,
      kind: f.kind,
      ...(f.choices ? { choices: [...f.choices] } : {}),
      hint: f.hint,
      requiredToStart: f.requiredToStart,
      state: "to_ask",
      weThink: null,
      fileSection: f.fileSection ?? null,
      connector: f.connector ?? null,
      origin: originOf(k, src.kind),
    });
  }
  return {
    key,
    kind: src.kind,
    area: src.kind === "area" ? (src.area ?? null) : null,
    templateId: src.kind === "agent" ? (src.templateId ?? null) : null,
    title: src.title,
    intro: src.intro,
    fields,
  };
}

const STATE_RANK: Record<GuideFieldState, number> = {
  known: 0,
  to_confirm: 1,
  to_ask: 2,
  later: 3,
};
const SURENESS_RANK = { confirmed: 0, seen: 1, heard: 2 } as const;

/**
 * Merges fields asked in more than one section (the same `shareKey`, or the same key): kept in the
 * first section that asks it, the rest named in `alsoIn`; required if any asker requires it.
 */
export function mergeFields(sections: readonly GuideSection[]): GuideSection[] {
  const first = new Map<string, GuideField>();
  const out = sections.map((s) => ({ ...s, fields: [] as GuideField[] }));
  sections.forEach((s, i) => {
    for (const f of s.fields) {
      const kept = first.get(f.key);
      if (!kept) {
        const copy: GuideField = { ...f, alsoIn: [...f.alsoIn] };
        first.set(f.key, copy);
        out[i]?.fields.push(copy);
        continue;
      }
      for (const k of [s.key, ...f.alsoIn]) {
        if (k !== kept.sectionKey && !kept.alsoIn.includes(k)) kept.alsoIn.push(k);
      }
      kept.requiredToStart ||= f.requiredToStart;
      kept.fileSection ??= f.fileSection;
      kept.connector ??= f.connector;
      // What the file knows best wins: known, then to confirm, then the rest.
      if (STATE_RANK[f.state] < STATE_RANK[kept.state]) {
        kept.state = f.state;
        kept.weThink = f.weThink;
      }
    }
  });
  return out;
}

/**
 * A fact's words as a field's value, when they read as one: text as it is, a number, yes or no, a
 * date, one or more of the choices. Null when they don't (the field is then asked).
 */
export function valueFromText(
  field: Pick<GuideField, "kind" | "choices">,
  text: string,
): AnswerValue | null {
  const t = text.trim();
  if (!t) return null;
  switch (field.kind) {
    case "text":
      return t.length <= 500 ? t : null;
    case "long_text":
      return t.slice(0, 4000);
    case "number": {
      if (!/^-?[\d,\s]+(\.\d+)?$/.test(t)) return null;
      const n = Number(t.replace(/[,\s]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "yes_no":
      return /^(yes|y|true)$/i.test(t) ? true : /^(no|n|false)$/i.test(t) ? false : null;
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
    case "choice":
      return field.choices?.find((c) => c.toLowerCase() === t.toLowerCase()) ?? null;
    case "choices": {
      const picked = t.split(/[,;]/).map((p) => p.trim().toLowerCase());
      const out = picked.map((p) => field.choices?.find((c) => c.toLowerCase() === p));
      return out.every((c): c is string => c !== undefined) ? out : null;
    }
    default:
      // Money, files and tools are never read from words: they are asked (or connected).
      return null;
  }
}

/** What the card calls a fact's line when the fact answers no question of its own. */
const FACT_LINE_LABELS: Record<FactSection, string> = {
  business: "The business",
  people: "People",
  systems: "Tools you use",
  volumes: "How much",
  processes: "How it works today",
  pains: "What could be better",
  limits: "Limits",
  notes: "Other",
};

/** 64 bits of a string's hash (cyrb53's mixing, two 32-bit halves), as 16 hex digits. */
function hash64(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(h2)}${hex(h1)}`;
}

/**
 * The field key of a fact's own "We think" line: `fact.` and a hash of the fact's id, the same for
 * the same fact every time the guide is built.
 */
// DECISION (review): the key never carries the fact's id. The portal shows field keys and the
// client's answers store them, and `client_fact` is the operator's (a UUID v7 also says when our
// note was written); which fact a line came from stays in `weThink.factIds`, which the portal strips.
export function factFieldKey(factId: string): string | null {
  const id = factId.trim().toLowerCase();
  return id ? `fact.${hash64(id)}` : null;
}

/**
 * Fills fields from the file's `theirs` facts: a fact naming a field (an earlier intake's answer)
 * fills it, confirmed → known, heard or seen → to confirm; the surest wins. A fact that names no
 * field is a "We think" line of its own, on the card its section belongs with.
 */
// DECISION: a fact typed into the file by hand names no question, and nothing reads its words to
// guess one (no model in the guide). It is its own line to confirm ("We think: bills come to
// ap@acme.com", Yes or Change) on the general card, else the first card that files into its
// section, else the first card; a confirmed one is known and not asked.
function fillFromFacts(sections: GuideSection[], facts: readonly GuideFact[]): void {
  const fields = new Map<string, GuideField>();
  for (const s of sections) for (const f of s.fields) fields.set(f.key, f);
  const best = new Map<string, GuideFact>();
  const loose: GuideFact[] = [];
  for (const fact of facts) {
    const field = fact.fieldKey ? fields.get(fact.fieldKey) : undefined;
    if (!field) {
      loose.push(fact);
      continue;
    }
    const was = best.get(field.key);
    // Equally sure: the later fact (input order) wins.
    if (!was || SURENESS_RANK[fact.sureness] <= SURENESS_RANK[was.sureness]) {
      best.set(field.key, fact);
    }
  }
  for (const [key, fact] of best) {
    const field = fields.get(key);
    if (!field) continue;
    const value = valueFromText(field, fact.text);
    if (value === null) continue;
    field.state = fact.sureness === "confirmed" ? "known" : "to_confirm";
    field.weThink = { value, text: fact.text, factIds: [fact.id] };
  }
  for (const fact of loose) {
    const key = factFieldKey(fact.id);
    if (!key || fields.has(key)) continue;
    const home =
      sections.find((s) => s.key === GENERAL_SECTION_KEY) ??
      sections.find((s) => s.fields.some((f) => f.fileSection === fact.section)) ??
      sections[0];
    if (!home) return;
    const field: GuideField = {
      key,
      sectionKey: home.key,
      alsoIn: [],
      label: FACT_LINE_LABELS[fact.section],
      kind: "long_text",
      hint: "",
      requiredToStart: false,
      state: fact.sureness === "confirmed" ? "known" : "to_confirm",
      weThink: { value: fact.text.slice(0, 4000), text: fact.text, factIds: [fact.id] },
      fileSection: fact.section,
      connector: null,
      origin: "operator",
    };
    home.fields.push(field);
    fields.set(key, field);
  }
}

/** Dashes off both ends without a regular expression (CodeQL: no backtracking on long runs). */
function trimDashes(v: string): string {
  let start = 0;
  let end = v.length;
  while (start < end && v[start] === "-") start++;
  while (end > start && v[end - 1] === "-") end--;
  return v.slice(start, end);
}

const slug = (text: string): string =>
  trimDashes(text.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 60) || "question";

/** The operator's edits that would ask for a secret (refused: cases-plan §4.5). */
export function guideEditProblems(edits: GuideEditsInput | undefined): string[] {
  if (!edits) return [];
  const out: string[] = [];
  for (const r of edits.reword ?? []) {
    if (asksForSecret(r.label, r.hint)) out.push(`${r.key}: a question never asks for a secret`);
  }
  for (const a of edits.add ?? []) {
    if (asksForSecret(a.label, a.hint)) {
      out.push(`"${a.label}": a question never asks for a secret`);
    }
  }
  return out;
}

function applyEdits(sections: GuideSection[], edits: GuideEdits): void {
  const drop = new Set(edits.drop);
  const later = new Set(edits.later);
  const reword = new Map(edits.reword.map((r) => [r.key, r]));
  const keys = new Set<string>();
  for (const s of sections) {
    s.fields = s.fields.filter((f) => !drop.has(f.key));
    for (const f of s.fields) {
      keys.add(f.key);
      const r = reword.get(f.key);
      if (r && !asksForSecret(r.label, r.hint)) {
        f.label = r.label;
        if (r.hint !== undefined) f.hint = r.hint;
      }
      if (later.has(f.key) && f.state !== "known") f.state = "later";
    }
  }
  for (const a of edits.add) {
    const s = sections.find((x) => x.key === a.sectionKey);
    if (!s || asksForSecret(a.label, a.hint)) continue;
    let key = `ask.${slug(a.label)}`;
    for (let n = 2; keys.has(key); n++) key = `ask.${slug(a.label).slice(0, 55)}-${n}`;
    keys.add(key);
    s.fields.push({
      key,
      sectionKey: s.key,
      alsoIn: [],
      label: a.label,
      kind: a.kind,
      ...(a.choices ? { choices: [...a.choices] } : {}),
      hint: a.hint,
      requiredToStart: a.requiredToStart,
      state: "to_ask",
      weThink: null,
      fileSection: null,
      connector: null,
      origin: "operator",
    });
  }
}

/**
 * The guide for an intake: sections in covers' order, shared fields merged (`mergeFields`), each
 * field's state from the facts, the operator's edits applied, the totals counted. A covered
 * section without a source is left out; a question asking for a secret is never in it.
 */
export function buildGuide(input: BuildGuideInput): Guide {
  const wanted = sectionKeysOf(input.covers);
  const sources = [
    ...(input.covers.general && input.general ? [input.general] : []),
    ...input.areas,
    ...input.agents,
  ];
  const byKey = new Map<string, GuideSection>();
  for (const src of sources) {
    const s = sectionOf(GuideSectionSource.parse(src));
    if (s && wanted.includes(s.key) && !byKey.has(s.key)) byKey.set(s.key, s);
  }
  const ordered = wanted.flatMap((k) => {
    const s = byKey.get(k);
    return s ? [s] : [];
  });
  const sections = mergeFields(ordered);
  fillFromFacts(sections, input.facts);
  applyEdits(sections, GuideEdits.parse(input.edits ?? {}));
  return { version: GUIDE_VERSION, sections, totals: guideTotals(sections) };
}

/**
 * An open intake's guide with a later Invite's cards added (cases-plan §3.2: one intake per
 * client). `built` is the guide for every card the intake will have, built afresh; the cards the
 * open guide already has are kept as they are (their keys, wording and the operator's earlier
 * edits, so its answers still fit), and only the new cards are taken from `built`. A question a
 * new card shares with a kept one stays asked once, where it was, and names the new card too.
 */
export function addToGuide(open: Guide, built: Guide): { guide: Guide; added: GuideSection[] } {
  const have = new Set(open.sections.map((s) => s.key));
  const kept = open.sections.map((s) => ({
    ...s,
    fields: s.fields.map((f) => ({ ...f, alsoIn: [...f.alsoIn] })),
  }));
  const keptFields = new Map<string, GuideField>();
  for (const s of kept) for (const f of s.fields) keptFields.set(f.key, f);
  const named = (field: GuideField, keys: readonly string[]) => {
    for (const k of keys) {
      if (k !== field.sectionKey && !field.alsoIn.includes(k)) field.alsoIn.push(k);
    }
  };
  const added: GuideSection[] = [];
  for (const s of built.sections) {
    if (have.has(s.key)) {
      // A kept card's question that a new card shares: the new card is named on it.
      for (const f of s.fields) {
        const k = keptFields.get(f.key);
        if (k)
          named(
            k,
            f.alsoIn.filter((x) => !have.has(x)),
          );
      }
      continue;
    }
    const fields: GuideField[] = [];
    for (const f of s.fields) {
      const k = keptFields.get(f.key);
      if (k) {
        named(k, [s.key, ...f.alsoIn]);
        k.requiredToStart ||= f.requiredToStart;
        continue;
      }
      fields.push({ ...f, alsoIn: f.alsoIn.filter((x) => x !== f.sectionKey) });
    }
    added.push({ ...s, fields });
  }
  const sections = [...kept, ...added];
  return {
    guide: { version: GUIDE_VERSION, sections, totals: guideTotals(sections) },
    added,
  };
}

/** Minutes each kind of question takes, for the estimate. */
// DECISION: half a minute to confirm a line, a minute a question (two for long answers and files),
// three to connect a tool; the total is rounded up to five minutes ("about 15 minutes"), and
// nothing to do is zero.
const MINUTES = { confirm: 0.5, question: 1, long: 2, tool: 3 } as const;

/** The totals the operator sees, minutes included. */
export function guideTotals(sections: readonly GuideSection[]): GuideTotals {
  const totals = { known: 0, toConfirm: 0, toAsk: 0, later: 0, tools: 0, minutes: 0 };
  let minutes = 0;
  for (const s of sections) {
    for (const f of s.fields) {
      if (f.state === "known") totals.known++;
      else if (f.state === "later") totals.later++;
      else if (f.kind === "tool") {
        totals.tools++;
        minutes += MINUTES.tool;
      } else if (f.state === "to_confirm") {
        totals.toConfirm++;
        minutes += MINUTES.confirm;
      } else {
        totals.toAsk++;
        minutes += f.kind === "long_text" || f.kind === "files" ? MINUTES.long : MINUTES.question;
      }
    }
  }
  totals.minutes = minutes > 0 ? Math.ceil(minutes / 5) * 5 : 0;
  return totals;
}

/** Answer states that answer a field (a "We think" line confirmed or changed counts). */
export const ANSWERED_STATES: readonly string[] = ["answered", "confirmed", "corrected"];
/** Answer states that leave a field open without blocking: not sure, and later. */
export const OPEN_ITEM_STATES: readonly string[] = ["not_sure", "later"];

export interface ProgressExtras {
  /** The people on the intake: who has a card they were asked for (an admin has them all). */
  people?: readonly { name: string; sections: readonly string[] | null; isAdmin: boolean }[];
  /** One question asked of someone ("Ask someone else"): the field and who has it. */
  asked?: readonly { fieldKey: string; name: string }[];
  /** A card's Start with this or Not now, by section key. */
  decisions?: Readonly<Record<string, "start" | "not_now">>;
}

/** The fields a section asks now: its own, neither known nor saved for later. */
export function askedFields(section: Pick<GuideSection, "fields">): GuideField[] {
  return section.fields.filter((f) => f.state === "to_ask" || f.state === "to_confirm");
}

/** The fields a card needs answered: asked in it, or asked elsewhere and shared into it. */
export function cardFields(guide: Pick<Guide, "sections">, sectionKey: string): GuideField[] {
  return guide.sections.flatMap((s) =>
    askedFields(s).filter((f) => f.sectionKey === sectionKey || f.alsoIn.includes(sectionKey)),
  );
}

/** Answered of asked across the whole guide, each question once. */
export function guideAnswered(
  guide: Pick<Guide, "sections">,
  answers: readonly { fieldKey: string; state: string }[],
): { answered: number; total: number } {
  const latest = new Map<string, string>();
  for (const a of answers) latest.set(a.fieldKey, a.state);
  const fields = guide.sections.flatMap(askedFields);
  return {
    answered: fields.filter((f) => ANSWERED_STATES.includes(latest.get(f.key) ?? "")).length,
    total: fields.length,
  };
}

/**
 * Progress per section from the guide and the answers (the latest to each field counts: given
 * oldest first, the last one wins). A shared question counts on each card that needs it (the
 * Requirements panel's "7 of 12" is everything its agent needs), though it is asked once.
 */
export function guideProgress(
  guide: Guide,
  answers: readonly { fieldKey: string; state: string }[],
  extras: ProgressExtras = {},
): SectionProgress[] {
  const latest = new Map<string, string>();
  for (const a of answers) latest.set(a.fieldKey, a.state);
  const askedOf = new Map((extras.asked ?? []).map((a) => [a.fieldKey, a.name]));
  const isAnswered = (key: string) => ANSWERED_STATES.includes(latest.get(key) ?? "");
  return guide.sections.map((s) => {
    const fields = cardFields(guide, s.key);
    const someone = extras.people?.find(
      (p) => !p.isAdmin && p.sections !== null && p.sections.includes(s.key),
    );
    return {
      sectionKey: s.key,
      answered: fields.filter((f) => isAnswered(f.key)).length,
      total: fields.length,
      notSure: fields.filter((f) => OPEN_ITEM_STATES.includes(latest.get(f.key) ?? "")).length,
      missing: fields
        .filter((f) => f.requiredToStart && !isAnswered(f.key))
        .map((f) => ({
          fieldKey: f.key,
          label: f.label,
          who: askedOf.get(f.key) ?? someone?.name ?? null,
        })),
      decision: extras.decisions?.[s.key] ?? null,
    };
  });
}

/** A card is done once each question is answered or marked not sure (an open item, not a blocker). */
export const sectionDone = (p: Pick<SectionProgress, "answered" | "notSure" | "total">): boolean =>
  p.answered + p.notSure >= p.total;
