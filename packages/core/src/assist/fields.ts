// Draft (docs/plan.md §1.166): the back office's long text fields that can be drafted from the
// operator's notes. One descriptor per field id: what the field is called, what it is for and what
// good looks like, its format, its most characters, who reads it (the client's language when a
// client does) and which records the server may load as context for it. The API's system prompt is
// made from these alone; the operator's notes, the field's text and the records go in as data.

import { BRIEF_FIELDS, BRIEF_HINTS, BRIEF_LABELS, type BriefFieldKey } from "../build/build";
import { sliceWhole } from "../text";

/**
 * What the server may load for a field, by the ids the request names:
 * - `build`: the build's title and kind (`buildId`);
 * - `brief`: the build's brief, its other fields;
 * - `ref`: the one thing on the build `ref` names (an issue, a decision, a fit-gap row, an intake
 *   form field);
 * - `deal`: the deal's title, company, stage, description and next step (`dealId`);
 * - `file`: the client file's name, website and current facts (`fileId`).
 * The client's name and language (`clientId`, or the client the build, deal or file is about) are
 * read for every field.
 */
export const ASSIST_SOURCES = ["build", "brief", "ref", "deal", "file"] as const;
export type AssistSource = (typeof ASSIST_SOURCES)[number];

/** How the text is laid out. */
export const ASSIST_SHAPES = ["sentence", "paragraph", "list", "message"] as const;
export type AssistShape = (typeof ASSIST_SHAPES)[number];

export const ASSIST_SHAPE_RULES: Record<AssistShape, string> = {
  sentence: "One sentence, two at most. No list, no heading.",
  paragraph: "One short paragraph of short sentences. No list, no heading.",
  list: 'One item per line, each line starting with "- ". No heading, no closing summary.',
  message: "Short paragraphs with a blank line between them. No subject line, no heading.",
};

/** The brand's voice (CLAUDE.md "UI and copy"), for every field. */
export const ASSIST_VOICE_RULES: readonly string[] = [
  "Plain words and short sentences, in sentence case.",
  'Say "we" for Mezonas and "you" for the client.',
  "Lead with the result, and with its number when there is one.",
  'No exclamation marks, emoji, hype, filler or "AI-powered".',
  "Keep every fact, number, name and tool from the notes; add none that the notes and the records don't give. Leave out what isn't known rather than guess.",
];

/** Who reads the field: a client's text is written in the client's language. */
export type AssistAudience = "operator" | "client";

/** The id a field can't be drafted without. */
export type AssistNeed = "buildId" | "dealId" | "fileId";

export interface AssistField {
  label: string;
  /** What the field is for and what good looks like. */
  purpose: string;
  shape: AssistShape;
  /** Its own rules, beside the shape's and the voice's. */
  rules: readonly string[];
  /** The most characters a draft may have: the field's own cap, or less. */
  maxLength: number;
  audience: AssistAudience;
  uses: readonly AssistSource[];
  needs: AssistNeed | null;
}

/** What good looks like for each brief field, beside its hint (core's `BRIEF_HINTS`). */
const BRIEF_GOOD: Record<
  BriefFieldKey,
  { good: string; shape: AssistShape; maxLength: number; rules?: string[] }
> = {
  goal: {
    good: 'The result for the client and who it is for, so anyone can tell what the agent is for, e.g. "Match each supplier invoice to its purchase order and flag the ones that differ, so AP pays only what was ordered."',
    shape: "sentence",
    maxLength: 300,
  },
  measure: {
    good: "One to three checks we can count: a time, a share or an error rate, with its number when the notes give one.",
    shape: "list",
    maxLength: 400,
  },
  trigger: {
    good: "The event that starts it (an email arrives, a schedule, someone asks) and how often it happens.",
    shape: "paragraph",
    maxLength: 300,
  },
  dataIn: {
    good: "One line per thing it reads: what it is and where it comes from (the tool, the inbox, the person).",
    shape: "list",
    maxLength: 600,
  },
  dataOut: {
    good: "One line per thing it writes or sends: what it is, where it goes (the tool and the record) and who gets it.",
    shape: "list",
    maxLength: 600,
  },
  people: {
    good: "Who approves, who is told and who handles the exceptions: the role first, the name only when the notes give it.",
    shape: "list",
    maxLength: 500,
  },
  rules: {
    good: "Each rule with its number or condition: tolerances, limits, and the cases that go to a person.",
    shape: "list",
    maxLength: 800,
  },
  volume: {
    good: "How many (per day, week or month) and how fast each must be done.",
    shape: "paragraph",
    maxLength: 300,
  },
  outOfScope: {
    good: "What the agent won't do, one line each, so the build doesn't grow.",
    shape: "list",
    maxLength: 600,
  },
};

const briefField = (key: BriefFieldKey): AssistField => {
  const g = BRIEF_GOOD[key];
  return {
    label: `${BRIEF_LABELS[key]} (the brief)`,
    purpose: `A field of a new agent's brief, which the Builder builds from. ${BRIEF_HINTS[key]} Good: ${g.good}`,
    shape: g.shape,
    rules: [
      "Write about the work, not about the brief or the notes.",
      "Only this field's part: leave what belongs in the brief's other fields to them.",
      ...(g.rules ?? []),
    ],
    maxLength: g.maxLength,
    audience: "operator",
    uses: ["build", "brief"],
    needs: "buildId",
  };
};

/** The brief's field ids: `build.brief.<key>`. */
export type BriefAssistFieldId = `build.brief.${BriefFieldKey}`;

const BRIEF_ASSIST = Object.fromEntries(
  BRIEF_FIELDS.map((k) => [`build.brief.${k}`, briefField(k)]),
) as Record<BriefAssistFieldId, AssistField>;

const OTHER_FIELDS = {
  "build.answer": {
    label: "Message to the Builder",
    purpose:
      "The operator's answer to the Builder's question, or what to do about the issue the conversation is on. Good: it answers what was asked, first, with the facts, numbers, names and tools from the notes, so the Builder can act on it without asking again.",
    shape: "message",
    rules: ["Write as the operator talking to the Builder, in the first person."],
    maxLength: 2000,
    audience: "operator",
    uses: ["build", "brief", "ref"],
    needs: "buildId",
  },
  "build.fit.reason": {
    label: "Why the verdict should change",
    purpose:
      "On a fit-gap row, why the Builder's verdict for this step is wrong. For more work: what is missing, or what makes this case harder. For less work: the part that already does it, or what the client really does at this step. Good: a reason the Builder can check, in two to four sentences.",
    shape: "paragraph",
    rules: ["At least 20 characters.", "Name the step's facts, not the verdict's words."],
    maxLength: 1000,
    audience: "operator",
    uses: ["build", "brief", "ref"],
    needs: "buildId",
  },
  "build.setup.hint": {
    label: "Why, or an example",
    purpose:
      "Shown to each client beside one question of the agent's intake form: why we need the answer, or an example answer. Good: one short sentence a client understands without knowing the agent.",
    shape: "sentence",
    rules: ['Speak to the client as "you".', "Don't repeat the question."],
    maxLength: 300,
    audience: "client",
    uses: ["build", "ref"],
    needs: "buildId",
  },
  "deal.description": {
    label: "What we know (a new deal)",
    purpose:
      "What we know about a prospect: the business, its size and volumes, the tools it uses, the work it wants done, and where the lead came from.",
    shape: "paragraph",
    rules: [],
    maxLength: 2000,
    audience: "operator",
    uses: [],
    needs: null,
  },
  "deal.note": {
    label: "Internal note (a deal)",
    purpose:
      "A note on a deal only the back office sees: what happened, what we learned, and the next step with its date when there is one.",
    shape: "paragraph",
    rules: [],
    maxLength: 4000,
    audience: "operator",
    uses: ["deal"],
    needs: "dealId",
  },
  "deal.email": {
    label: "Email (a deal)",
    purpose:
      "An email to the deal's person, sent from the operator via Mezonas. Good: a greeting by first name when known, the point in the first sentence, one clear next step or question, and a short close.",
    shape: "message",
    rules: [
      "No subject line and no signature: the operator's name is added when it is sent.",
      "Never promise a price, a date or a feature the notes don't give.",
    ],
    maxLength: 4000,
    audience: "client",
    uses: ["deal"],
    needs: "dealId",
  },
  "deal.call": {
    label: "Call notes (a deal)",
    purpose:
      "What was said on a call about a deal: who was on it, what they told us, what we agreed, and the next step.",
    shape: "list",
    rules: [],
    maxLength: 4000,
    audience: "operator",
    uses: ["deal"],
    needs: "dealId",
  },
  "deal.meeting": {
    label: "Meeting notes (a deal)",
    purpose:
      "What was said in a meeting about a deal: who was there, what they told us, what we agreed, and the next step.",
    shape: "list",
    rules: [],
    maxLength: 4000,
    audience: "operator",
    uses: ["deal"],
    needs: "dealId",
  },
  "clientFile.fact": {
    label: "The fact (a client file)",
    purpose:
      "One fact about a company in its client file, as a plain statement someone could check: what is true, with the numbers and names from the notes. One fact, not a summary.",
    shape: "sentence",
    rules: ['State it as true now, without "they said" or "we heard".'],
    maxLength: 500,
    audience: "operator",
    uses: ["file"],
    needs: "fileId",
  },
} as const satisfies Record<string, AssistField>;

/** Every field that can be drafted, by id. */
export const ASSIST_FIELDS: Record<AssistFieldId, AssistField> = {
  ...BRIEF_ASSIST,
  ...OTHER_FIELDS,
};

export type AssistFieldId = BriefAssistFieldId | keyof typeof OTHER_FIELDS;

export const ASSIST_FIELD_IDS = Object.keys(ASSIST_FIELDS) as [AssistFieldId, ...AssistFieldId[]];

export function isAssistField(id: string): id is AssistFieldId {
  return Object.hasOwn(ASSIST_FIELDS, id);
}

/**
 * The draft at most `max` characters: whole when it fits, else cut at its last sentence or line
 * end in the second half, else at a space, else on a whole character.
 */
// DECISION: cut, never refuse: the operator reads the draft before it is used, and a slightly
// shorter one is more use than an error.
export function fitToLength(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = sliceWhole(t, max);
  let end = -1;
  for (const m of cut.matchAll(/[.?…](?=\s|$)|\n/g)) {
    const at = m[0] === "\n" ? m.index : m.index + m[0].length;
    if (at >= max / 2) end = at;
  }
  if (end > 0) return cut.slice(0, end).trimEnd();
  const space = cut.lastIndexOf(" ");
  return (space >= max / 2 ? cut.slice(0, space) : cut).trimEnd();
}
