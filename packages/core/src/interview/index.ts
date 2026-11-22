// The process interview (docs/plan.md §1.217, the owner's build plan 8): a link an operator sends
// one of a client's contacts about one process. The interviewer asks one question at a time,
// takes estimates as estimates and never fills a gap itself; the person may add sample files.
// Finished, it gives a current-state map of the process, the questions still open and the words
// a Builder draft is made from. Everything the person wrote is data, never instructions
// (invariant 9): each step of the map names the answers it came from, and a step no answer
// describes is taken off the map and asked as an open question instead (`groundOutputs`).

import { z } from "zod";
import { ReuseCandidate } from "../build/code-requests";
import { asksForSecret } from "../forms";
import type { GuideSectionSource } from "../onboarding/guide";

// Kept in step with the database's `INTERVIEW_STATUSES` (packages/db).
export const INTERVIEW_STATUSES = ["open", "finished", "closed"] as const;
export const InterviewStatus = z.enum(INTERVIEW_STATUSES);
export type InterviewStatus = z.infer<typeof InterviewStatus>;

// DECISION: at most 30 answers. A process told step by step takes 10 to 20; past 30 the interview
// ends with what it has (the rest go on the open questions). It also caps the model calls one
// public link can cause.
export const INTERVIEW_MAX_ANSWERS = 30;
/** The longest answer, in characters. */
export const INTERVIEW_ANSWER_MAX = 4000;
/** The longest question the interviewer may ask, in characters. */
export const INTERVIEW_QUESTION_MAX = 400;
/** The most sample files one interview takes. */
export const INTERVIEW_MAX_FILES = 10;
// DECISION: a link works for 14 days, long enough for a busy person to come back to it.
export const INTERVIEW_LINK_DAYS = 14;

export const InterviewAgentTurn = z.object({
  role: z.literal("agent"),
  text: z.string().min(1).max(INTERVIEW_QUESTION_MAX),
  at: z.string(),
});
export const InterviewContactTurn = z.object({
  role: z.literal("contact"),
  /** What the person wrote: data, never instructions. Empty when they skipped the question. */
  text: z.string().max(INTERVIEW_ANSWER_MAX),
  at: z.string(),
  /** The person said it is an estimate. */
  estimate: z.boolean().default(false),
  /** "I don't know": no answer, and the question goes on the open list. */
  skipped: z.boolean().default(false),
});
export const InterviewTurn = z.discriminatedUnion("role", [
  InterviewAgentTurn,
  InterviewContactTurn,
]);
export type InterviewTurn = z.infer<typeof InterviewTurn>;
export type InterviewContactTurn = z.infer<typeof InterviewContactTurn>;

/** A sample file the person added: one of the client's documents. */
export const InterviewFile = z.object({
  documentId: z.string(),
  filename: z.string(),
  at: z.string(),
});
export type InterviewFile = z.infer<typeof InterviewFile>;

const Line = (max: number) => z.string().trim().min(1).max(max);

/** One step of the process as it is done today. */
export const ProcessStep = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
    .describe("A short id of your own: lower case letters, digits, - and _"),
  name: Line(200).describe("What happens, in a few words, as the person said it"),
  who: Line(200).nullable().describe("Who does it, if they said; else null"),
  tool: Line(200).nullable().describe("The tool or file it is done in, if they said; else null"),
  detail: Line(600).nullable().describe("How it is done, in their words, if they said; else null"),
  volume: Line(200)
    .nullable()
    .describe("How much or how long, with the numbers they gave; else null"),
  estimate: z.boolean().default(false).describe("The numbers are the person's estimate"),
  from: z
    .array(z.number().int().min(0))
    .min(1)
    .max(20)
    .describe("The numbers of the answers this step comes from: every step has at least one"),
});
export type ProcessStep = z.infer<typeof ProcessStep>;

export const ProcessMap = z.object({
  process: Line(200),
  trigger: Line(400).nullable().describe("What starts it, if they said; else null"),
  steps: z.array(ProcessStep).max(30),
  outcome: Line(400).nullable().describe("What it ends with, if they said; else null"),
});
export type ProcessMap = z.infer<typeof ProcessMap>;

/** Something the interview didn't settle: asked later, never guessed. */
export const InterviewOpenQuestion = z.object({
  question: Line(400),
  why: Line(400).describe("Why it matters, in one short sentence"),
  stepId: z.string().max(40).nullable().default(null),
});
export type InterviewOpenQuestion = z.infer<typeof InterviewOpenQuestion>;

/** What a finished interview gives: the map, what is still open, and the words to draft from. */
export const InterviewOutputs = z.object({
  map: ProcessMap,
  openQuestions: z.array(InterviewOpenQuestion).max(40),
  /** The process as numbered steps, for the Builder's draft (§1.165's description). */
  description: z.string().max(4000),
  /** Steps the model put on the map that no answer described, taken off by code. */
  ungrounded: z.number().int().min(0).default(0),
});
export type InterviewOutputs = z.infer<typeof InterviewOutputs>;

/** The reuse check over the map: for each step, the catalog's parts that may already do it. */
export const InterviewReuse = z.object({
  ranAt: z.string(),
  steps: z.array(
    z.object({
      stepId: z.string(),
      candidates: z.array(ReuseCandidate).max(5),
    }),
  ),
});
export type InterviewReuse = z.infer<typeof InterviewReuse>;

/** What the signed link carries: the client, the interview and its expiry. */
export const InterviewLinkToken = z.object({
  t: z.uuid(),
  i: z.uuid(),
  /** Seconds since the epoch. */
  e: z.number().int(),
});
export type InterviewLinkToken = z.infer<typeof InterviewLinkToken>;

/** The web app's page for a token. */
export function interviewPagePath(token: string): string {
  return `/i/${token}`;
}

// DECISION: what the interview covers is the intake's own questions for the process's area
// (§1.149.2: the pack's area section, else core's generic one); with no area, the generic
// questions in the same words. The interviewer asks them its own way, one at a time.
export const DEFAULT_INTERVIEW_TOPICS = [
  "How does it work today, from start to finish?",
  "Who does it today?",
  "Which tools do you use for it?",
  "About how much of it is there in a month?",
  "What goes wrong, or takes longer than it should?",
] as const;

/** The topics an interview covers: an area section's questions, else the generic ones. */
export function interviewTopics(section: GuideSectionSource | null): string[] {
  const labels = section?.fields.filter((f) => f.kind !== "tool").map((f) => f.label) ?? [];
  return labels.length > 0 ? labels.slice(0, 12) : [...DEFAULT_INTERVIEW_TOPICS];
}

// DECISION: one question at a time is held by code: the interviewer's text is cut after its first
// question mark. A question that asks for a secret (forms' rule) is never put to the person.
/** The interviewer's question as the person sees it, or null when it can't be asked. */
export function oneQuestion(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const mark = t.indexOf("?");
  const q = (mark >= 0 ? t.slice(0, mark + 1) : t).slice(0, INTERVIEW_QUESTION_MAX).trim();
  if (!q || asksForSecret(q)) return null;
  return q;
}

/** How many answers the person has given (skipped questions count: they were asked). */
export function answersGiven(turns: readonly InterviewTurn[]): number {
  return turns.filter((t) => t.role === "contact").length;
}

/**
 * The model's outputs held to what the person said. A step must name at least one answer that
 * exists and wasn't skipped; one that names none is taken off the map and asked as an open
 * question. A step is an estimate when any answer it comes from was; the model's own word on that
 * is not taken. Skipped questions are open questions too.
 */
export function groundOutputs(
  outputs: InterviewOutputs,
  turns: readonly InterviewTurn[],
): InterviewOutputs {
  const answered = (i: number) => {
    const t = turns[i];
    return t?.role === "contact" && !t.skipped && t.text.trim().length > 0 ? t : null;
  };
  const steps: ProcessStep[] = [];
  const open: InterviewOpenQuestion[] = [...outputs.openQuestions];
  const ids = new Set<string>();
  let ungrounded = 0;
  for (const step of outputs.map.steps) {
    const from = [...new Set(step.from)].filter((i) => answered(i) !== null);
    if (from.length === 0 || ids.has(step.id)) {
      ungrounded += 1;
      open.push({
        question: `How is “${step.name}” done today?`.slice(0, 400),
        why: "No answer described this step, so it isn't on the map yet.",
        stepId: null,
      });
      continue;
    }
    ids.add(step.id);
    const estimate = from.some((i) => answered(i)?.estimate === true);
    steps.push({ ...step, from, estimate });
  }
  // A question the person couldn't answer stays open, in the interviewer's words.
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t?.role !== "contact" || !t.skipped) continue;
    const asked = turns[i - 1];
    if (asked?.role !== "agent") continue;
    if (open.some((q) => q.question === asked.text)) continue;
    open.push({ question: asked.text, why: "They didn't know when asked.", stepId: null });
  }
  return {
    ...outputs,
    map: { ...outputs.map, steps },
    // A question about a step that is no longer on the map is about the process as a whole.
    openQuestions: open
      .map((q) => (q.stepId !== null && !ids.has(q.stepId) ? { ...q, stepId: null } : q))
      .slice(0, 40),
    ungrounded: outputs.ungrounded + ungrounded,
  };
}

/** The map as numbered steps, the words a Builder draft is made from (§1.165). */
export function mapDescription(map: ProcessMap): string {
  const lines = [
    `${map.process}, as it is done today.`,
    ...(map.trigger ? [`It starts when ${lowerFirst(map.trigger)}`] : []),
    ...map.steps.map((s, i) => {
      const parts = [s.name];
      if (s.who) parts.push(`(${s.who})`);
      if (s.tool) parts.push(`in ${s.tool}`);
      return `${i + 1}. ${parts.join(" ")}${s.detail ? `: ${s.detail}` : ""}`;
    }),
    ...(map.outcome ? [`It ends with ${lowerFirst(map.outcome)}`] : []),
  ];
  return lines.join("\n").slice(0, 4000);
}

function lowerFirst(text: string): string {
  return text ? text[0]?.toLowerCase() + text.slice(1) : text;
}
