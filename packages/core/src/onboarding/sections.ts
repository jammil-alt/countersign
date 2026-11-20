// Where the guide's questions come from (docs/cases-plan.md §4.2 step 2; docs/plan.md §1.149.2):
// core's general section (ours, fixed), core's generic section for an area without a pack, a
// pack's own area section (declared as data in its manifest: `PackManifest.intakeSection`) and a
// template's client intake form (§1.108's fit-gap `setup`), read into a section here. Pure.
//
// The words are English as written here; the portal shows core's own questions in the person's
// language by key (apps/web's catalog, `intake.q.*`). A pack's and a template's questions show as
// written.

import type { SetupField } from "../build/build";
import type { OwnerArea } from "../owners/areas";
import {
  type GuideFieldSourceInput,
  GuideSectionSource,
  type GuideSectionSourceInput,
} from "./guide";
import type { IntakeArea } from "./starts";

/** The general section: the business, in a few plain questions (ours, fixed). */
// DECISION: six questions, so the card stays at "about five": what they do, who does what, who
// approves, their tools, what hurts and what they'd hand off first, and the limits. Volumes and
// how work flows are each area's (its own card asks them).
export const GENERAL_SECTION: GuideSectionSource = GuideSectionSource.parse({
  kind: "general",
  title: "The business",
  intro: "A few questions about your business, so every agent starts from how you work.",
  fields: [
    {
      key: "general.what",
      label: "What does your business do, and where?",
      kind: "long_text",
      fileSection: "business",
    },
    {
      key: "general.team",
      label: "Who does what? For example, who keeps the books and who buys.",
      kind: "long_text",
      fileSection: "people",
    },
    {
      key: "general.approver",
      label: "Who approves payments and changes?",
      kind: "text",
      hint: "A name and their role is enough.",
      fileSection: "people",
      requiredToStart: true,
    },
    {
      key: "general.systems",
      label: "Which tools do you use day to day?",
      kind: "text",
      hint: "For example QuickBooks, Gmail, a supplier portal, spreadsheets.",
      fileSection: "systems",
    },
    {
      key: "general.first",
      label: "What takes too much time today, and what would you hand off first?",
      kind: "long_text",
      fileSection: "pains",
    },
    {
      key: "general.limits",
      label: "Is there anything an agent should never do?",
      kind: "long_text",
      hint: "For example, never pay a bill over $5,000 without you.",
      fileSection: "limits",
    },
  ],
} satisfies GuideSectionSourceInput);

/** An area's name on its card. */
export const INTAKE_AREA_TITLES: Record<IntakeArea, string> = {
  purchasing: "Purchasing",
  sales: "Sales",
  receivables: "Getting paid",
  bookkeeping: "Bookkeeping",
  marketing: "Marketing",
};

/** The generic questions' keys, without the area (`area.<area>.<suffix>`). */
export const GENERIC_AREA_SUFFIXES = ["today", "who", "tools", "volume", "wrong"] as const;

/**
 * Core's questions for an area without a pack of its own (Receivables today; cases-plan
 * §8 q11): how it works today, who does it, the tools, how much, what goes wrong.
 */
export function genericAreaSection(area: IntakeArea): GuideSectionSource {
  const k = (suffix: (typeof GENERIC_AREA_SUFFIXES)[number]) => `area.${area}.${suffix}`;
  return GuideSectionSource.parse({
    kind: "area",
    area,
    title: INTAKE_AREA_TITLES[area],
    intro: "How this part of your business works today.",
    fields: [
      {
        key: k("today"),
        label: "How does it work today, from start to finish?",
        kind: "long_text",
        fileSection: "processes",
      },
      { key: k("who"), label: "Who does it today?", kind: "text", fileSection: "people" },
      {
        key: k("tools"),
        label: "Which tools do you use for it?",
        kind: "text",
        fileSection: "systems",
      },
      {
        key: k("volume"),
        label: "About how much of it is there in a month?",
        kind: "text",
        hint: "A rough number is fine, for example 300 invoices.",
        fileSection: "volumes",
      },
      {
        key: k("wrong"),
        label: "What goes wrong, or takes longer than it should?",
        kind: "long_text",
        fileSection: "pains",
      },
    ],
  } satisfies GuideSectionSourceInput);
}

/** The shared key of a tool to connect: asked once, whichever cards need it. */
export const toolFieldKey = (connector: string): string =>
  `tool.${connector.toLowerCase().replace(/[^a-z0-9_-]/g, "")}`;

/** A Connect card's field for a tool. */
export function toolField(connector: string, name: string): GuideFieldSourceInput {
  const key = toolFieldKey(connector);
  return {
    key,
    shareKey: key,
    label: `Connect ${name}`,
    kind: "tool",
    connector,
    hint: "You sign in to it yourself, on its own page.",
    fileSection: "systems",
    requiredToStart: true,
  };
}

/** What a template is, as its card shows it. */
export interface TemplateCard {
  id: string;
  /** The template's name ("Vendor contracts and invoice review"). */
  name: string;
  /** What it would do for them, in a sentence (its description). */
  description: string;
  slug: string;
  /** Connectors it needs (its bundle's), with their names. */
  connectors: readonly { id: string; name: string }[];
  /** Its client intake form (§1.108), when its build wrote one. */
  form: readonly Pick<SetupField, "id" | "label" | "kind" | "hint" | "dropped">[];
}

/** Strips `ch` from both ends without a regular expression (CodeQL: no backtracking on long runs). */
function trimChar(v: string, ch: string): string {
  let start = 0;
  let end = v.length;
  while (start < end && v[start] === ch) start++;
  while (end > start && v[end - 1] === ch) end--;
  return v.slice(start, end);
}

const keyPart = (v: string): string =>
  trimChar(v.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"), "-").slice(0, 40) || "x";

/**
 * A template's card: a Connect field per tool it needs (shared with any other card that needs the
 * same tool), then its client intake form's answers and files. A form's "connect" field names a
 * tool in words: it is the Connect card of a connector the template needs when the words name it,
 * else a question about which account.
 */
// DECISION: a template without a form (one built before §1.108, or a pack's) asks only for its
// tools; its card still says what it would do. Fields taken out of the form are not asked.
export function templateSection(t: TemplateCard): GuideSectionSource {
  const base = `agent.${keyPart(t.slug)}`;
  const fields: GuideFieldSourceInput[] = t.connectors.map((c) => toolField(c.id, c.name));
  const named = new Set(t.connectors.map((c) => c.id));
  for (const f of t.form) {
    if (f.dropped) continue;
    const key = `${base}.${keyPart(f.id)}`;
    if (f.kind === "connect") {
      const said = f.label.toLowerCase();
      const tool = t.connectors.find(
        (c) => said.includes(c.name.toLowerCase()) || said.includes(c.id.toLowerCase()),
      );
      if (tool && named.has(tool.id)) continue;
      fields.push({
        key,
        label: f.label,
        kind: "text",
        hint: f.hint || "Tell us which account; you'll connect it yourself.",
        fileSection: "systems",
        requiredToStart: true,
      });
      continue;
    }
    fields.push({
      key,
      label: f.label,
      kind: f.kind === "file" ? "files" : f.label.length > 80 ? "long_text" : "text",
      hint: f.hint,
      requiredToStart: true,
    });
  }
  return GuideSectionSource.parse({
    kind: "agent",
    templateId: t.id,
    title: t.name.slice(0, 120),
    intro: t.description.slice(0, 400),
    fields: fields.slice(0, 60),
  } satisfies GuideSectionSourceInput);
}

/**
 * An area's section: its pack's (the manifest's `intakeSection`), else core's generic one. The
 * platform hands the packs' sections in; nothing here names a pack.
 */
export function areaSection(
  area: IntakeArea,
  packSections: readonly GuideSectionSource[],
): GuideSectionSource {
  return packSections.find((s) => s.kind === "area" && s.area === area) ?? genericAreaSection(area);
}

/** Whether an owner area has a card of its own in an intake (every one but general). */
export const isIntakeArea = (a: OwnerArea): a is IntakeArea => a !== "general";
