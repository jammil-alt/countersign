// The agent manual (docs/builder-plan.md §5, B3): one structured document per agent, kept in its
// version as `definition.manual`, so it is versioned with the agent (invariant 3), travels with a
// template and its copies, and merges like the rest of the bundle. What the Builder writes is
// what it does (from the brief), its decisions (§4), its decision points and its known risks.
// "How it works" is never stored: code reads it from the process's steps (names and kinds in
// plain words), never from prompts. What the agent learned is never in it either: it is read live,
// per client (invariant 1), and only joins the view.
//
// The view (`manualView`) is made by code for both the back office and the portal: never the
// bundle, instructions, prompts or cost (invariant 11).

import { z } from "zod";
import {
  type Brief,
  DECISION_KIND_WORDS,
  DECISION_STATUS_WORDS,
  DECISIONS_MAX,
  Decision,
  DecisionKind,
  DecisionRisk,
  DecisionStatus,
} from "../build/build";
import type { Step as ProcessStep } from "../process/schema";
import { walkSteps } from "../process/walk";
import type { Step as WorkflowStep } from "../schemas/workflow";
import { walkSteps as walkV3Steps } from "../workflow/walk";

export const MANUAL_WHAT_MAX = 2000;
export const MANUAL_RISKS_MAX = 40;
export const MANUAL_POINTS_MAX = 40;

/** A known risk: a put-off gap item (§1.153), handed to a person until it shows up in runs. */
export const ManualKnownRisk = z.object({
  id: z.string().min(1).max(100),
  what: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(2000).default(""),
  /** How often runs hit it, once that is counted (§1.153: not counted yet). */
  hits: z.number().int().min(0).optional(),
});
export type ManualKnownRisk = z.infer<typeof ManualKnownRisk>;

/** Where a person decides: a person step or a write's approval, or a decision point not on one. */
export const ManualDecisionPoint = z.object({
  /** The step it is, or the step the decision shapes; null when it names none. */
  stepId: z.string().min(1).max(100).nullable(),
  what: z.string().max(300),
  /** Who decides, as the process names them (a role, a user id); null when it doesn't say. */
  who: z.string().max(200).nullable(),
  /** "2 days", "2 days in business hours"; null when it has no deadline. */
  byWhen: z.string().max(200).nullable(),
  /** The decision row it comes from, if one. */
  decisionId: z.string().max(60).nullable().default(null),
});
export type ManualDecisionPoint = z.infer<typeof ManualDecisionPoint>;

/**
 * `definition.manual`. Optional on the definition with no default, so bundles without it parse and
 * hash as they were.
 */
export const AgentManual = z
  .object({
    whatItDoes: z.string().trim().max(MANUAL_WHAT_MAX).default(""),
    decisions: z.array(Decision).max(DECISIONS_MAX).default([]),
    /** Derived from the process when the manual is written (`decisionPointsOf`). */
    decisionPoints: z.array(ManualDecisionPoint).max(MANUAL_POINTS_MAX).default([]),
    knownRisks: z.array(ManualKnownRisk).max(MANUAL_RISKS_MAX).default([]),
  })
  .meta({ id: "AgentManual" });
export type AgentManual = z.infer<typeof AgentManual>;
export type AgentManualInput = z.input<typeof AgentManual>;

// ── How it works: the steps in words, by code ──────────────────────────────────────────────────

/** What the manual reads of a bundle: its workflows, v3 or v4. */
export interface ManualWorkflows {
  workflows: readonly {
    slug: string;
    name: string;
    enabled?: boolean | undefined;
    workflow: { schemaVersion: number; steps: readonly unknown[] };
  }[];
}

export interface HowLine {
  workflow: string;
  stepId: string;
  /** How many `if`, `for_each` and `repeat` steps enclose it. */
  depth: number;
  kind: string;
  /** The step's own name, as the operator wrote it. */
  name: string;
  /** What kind of step it is, in plain words: "Updates your tools, after a person approves". */
  words: string;
}

function approvalOn(step: {
  checks?: { approval?: { required?: string | undefined } | undefined } | undefined;
}): boolean {
  // Invariant 8: a write's approval is on unless the operator set it to not_required.
  return step.checks?.approval?.required !== "not_required";
}

/** A v4 step's kind in plain words. */
export function processStepWords(step: ProcessStep): string {
  switch (step.kind) {
    case "read":
      return "Reads from your tools";
    case "skill":
      return "Works it out";
    case "write":
      return approvalOn(step)
        ? "Updates your tools, after a person approves"
        : "Updates your tools";
    case "person":
      return step.mode === "approve" ? "A person approves" : "A person answers";
    case "conversation":
      return `Talks with someone by ${step.channel === "call" ? "phone" : step.channel === "sms" ? "text" : step.channel}`;
    case "notify":
      return "Tells your team";
    case "if":
      return "Chooses a path";
    case "for_each":
      return "Does the steps below for each item";
    case "repeat":
      return "Repeats the steps below until they are done";
    case "wait":
      return `Waits ${step.for}`;
    case "stop":
      return "Stops here";
    case "process":
      return "Runs a shared process";
    case "handoff":
      return "Hands over to another agent";
    case "missing":
      return "Not built yet: a person does this part";
  }
}

/** A stored v3 step's kind in plain words. */
function workflowStepWords(step: WorkflowStep): string {
  switch (step.kind) {
    case "skill":
      return "Works it out";
    case "action":
      return "Uses one of your tools";
    case "person":
      return step.mode === "approve" ? "A person approves" : "A person answers";
    case "wait":
      return `Waits ${step.for}`;
    case "notify":
      return "Tells your team";
    case "stop":
      return "Stops here";
    case "fork":
      return "Chooses a path";
    case "for_each":
      return "Does the steps below for each item";
    case "use_automation":
      return "Runs a shared process";
    default:
      return "A step";
  }
}

/**
 * The agent's steps in run order, each with its name and kind in words: what "How it works" shows.
 * Made by code from the process, never from prompts or instructions. Switched-off workflows are
 * left out.
 */
export function howItWorks(bundle: ManualWorkflows): HowLine[] {
  const out: HowLine[] = [];
  for (const w of bundle.workflows) {
    if (w.enabled === false) continue;
    if (w.workflow.schemaVersion === 4) {
      walkSteps({ steps: w.workflow.steps as ProcessStep[] }, ({ step, depth }) => {
        out.push({
          workflow: w.name,
          stepId: step.id,
          depth,
          kind: step.kind,
          name: step.name,
          words: processStepWords(step),
        });
      });
    } else {
      walkV3Steps({ steps: w.workflow.steps as WorkflowStep[] }, ({ step, loops, forks }) => {
        out.push({
          workflow: w.name,
          stepId: step.id,
          depth: loops.length + forks.length,
          kind: step.kind,
          name: step.name,
          words: workflowStepWords(step),
        });
      });
    }
  }
  return out;
}

/** A step's name by id, across the bundle's workflows. */
export function stepNames(bundle: ManualWorkflows): Map<string, string> {
  return new Map(howItWorks(bundle).map((l) => [l.stepId, l.name]));
}

// ── Decision points ─────────────────────────────────────────────────────────────────────────────

function deadlineWords(d: { after: string; hours?: string } | undefined): string | null {
  if (!d) return null;
  return d.hours === "business" ? `${d.after} in business hours` : d.after;
}

/**
 * Where a person decides, by code: each person step (who decides, by when), each write that waits
 * for an approval, and each `decision_point` decision that names no such step.
 */
// DECISION: a write's approval counts as a decision point beside the person steps: it is where a
// person decides in every run, and the client sees who signs.
export function decisionPointsOf(
  bundle: ManualWorkflows,
  decisions: readonly Pick<Decision, "id" | "what" | "kind" | "stepId">[] = [],
): ManualDecisionPoint[] {
  const out: ManualDecisionPoint[] = [];
  const points = decisions.filter((d) => d.kind === "decision_point");
  const pointOn = (stepId: string) => points.find((d) => d.stepId === stepId)?.id ?? null;
  const covered = new Set<string>();
  for (const w of bundle.workflows) {
    if (w.enabled === false) continue;
    if (w.workflow.schemaVersion === 4) {
      walkSteps({ steps: w.workflow.steps as ProcessStep[] }, ({ step }) => {
        if (step.kind === "person") {
          covered.add(step.id);
          out.push({
            stepId: step.id,
            what: step.name,
            who: step.assignee,
            byWhen: deadlineWords(step.deadline),
            decisionId: pointOn(step.id),
          });
        } else if (step.kind === "write" && approvalOn(step)) {
          covered.add(step.id);
          const first = step.checks?.approval?.approvers?.[0];
          out.push({
            stepId: step.id,
            what: `Approve: ${step.name}`,
            who: first?.who ?? null,
            byWhen: deadlineWords(first?.deadline),
            decisionId: pointOn(step.id),
          });
        }
      });
    } else {
      walkV3Steps({ steps: w.workflow.steps as WorkflowStep[] }, ({ step }) => {
        if (step.kind !== "person") return;
        covered.add(step.id);
        out.push({
          stepId: step.id,
          what: step.name,
          who: step.assignee,
          byWhen: step.timeout,
          decisionId: pointOn(step.id),
        });
      });
    }
  }
  for (const d of points) {
    if (d.stepId && covered.has(d.stepId)) continue;
    out.push({ stepId: d.stepId ?? null, what: d.what, who: null, byWhen: null, decisionId: d.id });
  }
  return out.slice(0, MANUAL_POINTS_MAX);
}

// ── Writing it ──────────────────────────────────────────────────────────────────────────────────

/** "What it does", from the brief: its goal, then what done well means. */
export function whatItDoesFrom(brief: Brief): string {
  const goal = brief.goal?.text.trim() ?? "";
  const measure = brief.measure?.text.trim() ?? "";
  const parts = [goal ? goal.replace(/([^.!?])$/, "$1.") : ""];
  if (measure) parts.push(`Done well means: ${measure.replace(/([^.!?])$/, "$1.")}`);
  const text = parts.filter(Boolean).join(" ");
  return text.length > MANUAL_WHAT_MAX ? `${text.slice(0, MANUAL_WHAT_MAX - 1)}…` : text;
}

/**
 * The manual a build writes into its draft: what it does from the brief, the build's decisions
 * (their risk worked out by code), the decision points from the draft's process, and the known
 * risks (its put-off gap items). An empty brief keeps the "what it does" already written.
 */
export function fillManual(input: {
  brief: Brief;
  decisions: readonly Decision[];
  knownRisks: readonly { id: string; what: string; detail?: string | undefined }[];
  bundle: ManualWorkflows;
  before?: AgentManual | undefined;
}): AgentManual {
  const what = whatItDoesFrom(input.brief) || input.before?.whatItDoes || "";
  const decisions = input.decisions.slice(0, DECISIONS_MAX).map((d) => Decision.parse(d));
  return AgentManual.parse({
    whatItDoes: what,
    decisions,
    decisionPoints: decisionPointsOf(input.bundle, decisions),
    knownRisks: input.knownRisks.slice(0, MANUAL_RISKS_MAX).map((r) => ({
      id: r.id,
      what: r.what.slice(0, 300),
      detail: (r.detail ?? "").slice(0, 2000),
    })),
  });
}

/** The manual a definition holds, read leniently: one that no longer reads is none. */
export function readManual(raw: unknown): AgentManual | null {
  if (raw === undefined || raw === null) return null;
  const parsed = AgentManual.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ── At run time: the decisions nobody has discussed ─────────────────────────────────────────────

/** How many never-discussed decisions a step's notes or an approval card carry at most. */
export const UNDISCUSSED_MAX = 5;

/** The line a step's notes carry with its never-discussed decisions. */
export const UNDISCUSSED_NOTE =
  "These decisions about this step were never discussed with a person. Say in your output when your result rests on one.";

/** One never-discussed decision as a step's notes and an approval card carry it. */
export interface UndiscussedDecision {
  id: string;
  what: string;
}

/**
 * The decisions that shape this step and nobody has discussed yet (status `never_discussed`, on
 * this step), from the agent's manual. Empty when it has none.
 */
export function undiscussedFor(
  definition: { manual?: unknown } | null | undefined,
  stepId: string,
): UndiscussedDecision[] {
  const manual = readManual(definition?.manual);
  if (!manual) return [];
  return manual.decisions
    .filter((d) => d.status === "never_discussed" && d.stepId === stepId)
    .slice(0, UNDISCUSSED_MAX)
    .map((d) => ({ id: d.id, what: d.what }));
}

/** An approval card's payload's never-discussed decisions, read leniently. */
export function readUndiscussed(raw: unknown): UndiscussedDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: UndiscussedDecision[] = [];
  for (const r of raw) {
    if (r && typeof r === "object") {
      const { id, what } = r as { id?: unknown; what?: unknown };
      if (typeof what === "string" && what.trim()) {
        out.push({ id: typeof id === "string" ? id : "", what: what.trim() });
      }
    }
  }
  return out.slice(0, UNDISCUSSED_MAX);
}

/** "freight stays out of the catalog": a decision's words as the end of a sentence. */
export function inSentence(what: string): string {
  const t = what.trim().replace(/[.\s]+$/, "");
  // Keep an acronym or a name that starts it ("QBO", "AP Invoice Review").
  if (/^[A-Z][A-Z]/.test(t)) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

// ── The view: client-safe, made by code ─────────────────────────────────────────────────────────

export const ManualDecisionView = z.object({
  id: z.string(),
  what: z.string(),
  why: z.string(),
  value: z.string().nullable(),
  kind: DecisionKind,
  kindWords: z.string(),
  risk: DecisionRisk,
  status: DecisionStatus,
  statusWords: z.string(),
  /** The name of the step it shapes, if one. */
  step: z.string().nullable(),
  /** Who looked at it last: the operator's name in the back office, never in the portal. */
  by: z.string().nullable(),
});
export type ManualDecisionView = z.infer<typeof ManualDecisionView>;

export const ManualView = z
  .object({
    agent: z.object({ id: z.string(), name: z.string() }),
    /** A build has written its manual (else only what code reads from the process shows). */
    written: z.boolean(),
    whatItDoes: z.string(),
    howItWorks: z.array(
      z.object({
        workflow: z.string(),
        stepId: z.string(),
        depth: z.number().int(),
        kind: z.string(),
        name: z.string(),
        words: z.string(),
      }),
    ),
    decisions: z.array(ManualDecisionView),
    decisionPoints: z.array(
      z.object({
        stepId: z.string().nullable(),
        what: z.string(),
        who: z.string().nullable(),
        byWhen: z.string().nullable(),
        notDiscussed: z.boolean(),
      }),
    ),
    knownRisks: z.array(
      z.object({
        id: z.string(),
        what: z.string(),
        detail: z.string(),
        hits: z.number().int().nullable(),
      }),
    ),
    /** What we set up with this client (B4's `definition.setup`); empty when it has none. */
    setup: z.array(z.object({ label: z.string(), answer: z.string().nullable() })),
    /** The agent's memory notes for this client, read live (invariant 1). */
    learned: z.array(z.object({ id: z.string(), note: z.string(), at: z.string() })),
    /** What it reads besides: the charter, policies, the knowledge base, other manuals. */
    reads: z.array(z.string()),
  })
  .meta({ id: "ManualView" });
export type ManualView = z.infer<typeof ManualView>;

const WHO_WORDS: Record<string, string> = {
  client_admin: "Your admin",
  client_user: "Your team",
  lead: "Your Mezonas lead",
  operator: "Mezonas",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who decides, in words: a role's name, "A person you named" for an id, never an id. */
// DECISION: a user or contact id is not looked up here (the view is made by code from the
// version); it reads "A person you named". A template's `{{...}}` reads "The person the run names".
export function whoWords(who: string | null): string | null {
  if (!who) return null;
  const known = WHO_WORDS[who];
  if (known) return known;
  if (who.includes("{{")) return "The person the run names";
  if (UUID.test(who)) return "A person you named";
  const words = who.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/** "What we set up with you": B4's `definition.setup`, read leniently; none when it isn't there. */
// DECISION: B4 owns `definition.setup`; until its shape lands this reads any list of items that
// name a label (`label`, `question` or `title`) and an answer (`answer` or `value`), and shows
// nothing otherwise.
export function readSetupLines(raw: unknown): { label: string; answer: string | null }[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items as unknown[])
      : [];
  const out: { label: string; answer: string | null }[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = [r.label, r.question, r.title].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (!label) continue;
    const a = [r.answer, r.value].find(
      (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    out.push({ label: label.trim(), answer: a === undefined ? null : String(a) });
    if (out.length >= 40) break;
  }
  return out;
}

/** What every agent reads besides its own manual (§8), in words. */
export const MANUAL_READS = [
  "The Mezonas guardrails: the rules every agent follows.",
  "Your charter, once you confirm it.",
  "The policies for what each step does, ours and yours: writing into your tools, money, contacting people.",
  "Your knowledge base: your FAQs, policies and documents.",
  "Other agents' manuals for your business, when it needs them.",
] as const;

/**
 * The manual as a person reads it, made by code. `audience: "client"` leaves out who on our side
 * looked at a decision. Never the bundle, instructions, prompts or cost (invariant 11): only the
 * manual's own rows, the process's step names and kinds, and the agent's notes for this client.
 */
export function manualView(input: {
  agent: { id: string; name: string };
  bundle: ManualWorkflows & { definition: { manual?: unknown; setup?: unknown } };
  learned: readonly { id: string; note: string; at: string }[];
  audience: "client" | "operator";
  /** "What it does" when no manual has been written (the client's service description). */
  fallbackWhat?: string | null | undefined;
}): ManualView {
  const manual = readManual(input.bundle.definition.manual);
  const how = howItWorks(input.bundle);
  const names = new Map(how.map((l) => [l.stepId, l.name]));
  const decisions = manual?.decisions ?? [];
  const notDiscussed = new Set(
    decisions.filter((d) => d.status === "never_discussed").map((d) => d.id),
  );
  // Read from the process as it is now: a step added since the manual was written still shows.
  const points = decisionPointsOf(input.bundle, decisions);
  return {
    agent: input.agent,
    written: manual !== null,
    whatItDoes: manual?.whatItDoes || input.fallbackWhat || "",
    howItWorks: how,
    decisions: decisions.map((d) => ({
      id: d.id,
      what: d.what,
      why: d.why,
      value: d.value ?? null,
      kind: d.kind,
      kindWords: DECISION_KIND_WORDS[d.kind],
      risk: d.risk,
      status: d.status,
      statusWords: DECISION_STATUS_WORDS[d.status],
      step: d.stepId ? (names.get(d.stepId) ?? null) : null,
      by: input.audience === "operator" ? d.by : null,
    })),
    decisionPoints: points.map((p) => ({
      stepId: p.stepId,
      what: p.what,
      who: whoWords(p.who),
      byWhen: p.byWhen,
      notDiscussed: p.decisionId !== null && notDiscussed.has(p.decisionId),
    })),
    knownRisks: (manual?.knownRisks ?? []).map((r) => ({
      id: r.id,
      what: r.what,
      detail: r.detail,
      hits: r.hits ?? null,
    })),
    setup: readSetupLines(input.bundle.definition.setup),
    learned: input.learned.map((n) => ({ id: n.id, note: n.note, at: n.at })),
    reads: [...MANUAL_READS],
  };
}
