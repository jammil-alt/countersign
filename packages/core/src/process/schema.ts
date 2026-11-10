// R1 (docs/plan.md §1.86, §9): the process schema, workflow `schemaVersion: 4`.
// Six kinds of work (read, skill, write, person, conversation, notify) plus logic (if, for_each,
// wait, stop, process), and checks on any step (confer, approval, notify) with conditions and one
// deadline shape. Stored v3 workflows keep parsing as `Workflow`; `fromWorkflowV3` reads them as
// this shape (invariant 3: nothing stored is rewritten).

import { z } from "zod";
import { Duration } from "../duration";
import { StepReview } from "../oversight/decision";
import { NodeId, SkillRef, Slug, TemplateObject, TemplateString, ToolId } from "../schemas/common";
import { ApprovalRequirement } from "../schemas/permissions";
import { Rules } from "../schemas/rules";
import { ModelChoice } from "../schemas/skill";
import {
  AutomationRef,
  ClientVisibility,
  PersonChoice,
  Trigger,
  WorkflowHandoff,
} from "../schemas/workflow";
import { SkillCustomization } from "./customize";

// ── Deadlines ────────────────────────────────────────────────────────────────────────────────

/** Whose clock a deadline runs on: real time, or the business hours of the person asked. */
export const DEADLINE_HOURS = ["clock", "business"] as const;

/** Who is asked, or told: a role (`client_admin`, `lead`, `operator`), a user id or a contact id. */
export const Who = z.string().min(1).max(200);
export type Who = z.infer<typeof Who>;

export type DeadlineThen =
  | "stop"
  | "proceed"
  | "skip"
  | { escalate: { to: Who; deadline: Deadline } };

export interface Deadline {
  after: string;
  hours: "clock" | "business";
  remind?: string[] | undefined;
  ifNoAnswer: DeadlineThen;
  /** Told when the deadline passes, whatever `ifNoAnswer` does. */
  tell?: Who[] | undefined;
}

/**
 * What happens when nobody answers in time. `stop` is the default everywhere (owner, 2026-11-10).
 * `proceed` on a write's approval is loosening: validation holds it to invariant 8.
 */
export const DeadlineThen: z.ZodType<DeadlineThen> = z.lazy(() =>
  z.union([
    z.enum(["stop", "proceed", "skip"]),
    z.strictObject({ escalate: z.strictObject({ to: Who, deadline: Deadline }) }),
  ]),
) as z.ZodType<DeadlineThen>;

export const Deadline: z.ZodType<Deadline> = z.lazy(() =>
  z.strictObject({
    after: Duration,
    hours: z.enum(DEADLINE_HOURS).default("clock"),
    remind: z.array(Duration).max(5).optional(),
    ifNoAnswer: DeadlineThen.default("stop"),
    tell: z.array(Who).max(10).optional(),
  }),
) as z.ZodType<Deadline>;

// ── Checks ───────────────────────────────────────────────────────────────────────────────────

/** Conditions are plain rules over the run (never a model): absent means always. */
export const Conditions = Rules;

export const CONFER_VERDICTS = ["agree", "disagree", "unsure", "no_answer"] as const;
export const ConferVerdict = z.enum(CONFER_VERDICTS);
export type ConferVerdict = z.infer<typeof ConferVerdict>;

/** One reviewer in a confer: a second model, or a person from the client's People list. */
export const Conferee = z.union([
  z.strictObject({
    ai: z.strictObject({
      focus: TemplateString,
      /** Default: a model other than the step's. */
      model: ModelChoice.optional(),
    }),
    when: Conditions.optional(),
    deadline: Deadline.optional(),
  }),
  z.strictObject({
    person: Who,
    /** What the person is shown; default the step's output. */
    show: TemplateObject.optional(),
    when: Conditions.optional(),
    deadline: Deadline,
  }),
]);
export type Conferee = z.infer<typeof Conferee>;

/**
 * Confer: advice on a step's result, from an AI, a person, or AI then person (each reviewer's own
 * `when` can test the verdicts before it). It never changes the output and never approves a write.
 */
export const ConferCheck = z.strictObject({
  when: Conditions.optional(),
  with: z.array(Conferee).min(1).max(3),
});
export type ConferCheck = z.infer<typeof ConferCheck>;

export const APPROVAL_MODES = ["in_turn", "any", "all"] as const;

/**
 * One approver and how long they have; away people are skipped at once. `who` absent: the default
 * approver (the step's, then the agent's, then the client's; docs/plan.md §1.20).
 */
export const Approver = z.strictObject({ who: Who.optional(), deadline: Deadline.optional() });

/**
 * Approval: permission from the client's team or the lead. `required` keeps the v3 meaning
 * (invariant 8: on unless the operator switches it off where the connection allows `auto`);
 * `when` limits it to some runs, which on a write is loosening too.
 */
export const ApprovalCheck = z.strictObject({
  required: ApprovalRequirement.default("required"),
  when: Conditions.optional(),
  mode: z.enum(APPROVAL_MODES).default("in_turn"),
  /** Absent: the step's, then the agent's, then the client's approver (docs/plan.md §1.20). */
  approvers: z.array(Approver).max(5).optional(),
  /** After the last approver's deadline. */
  ifNoAnswer: DeadlineThen.default("stop"),
  onReject: z.enum(["stop", "continue"]).default("stop"),
});
export type ApprovalCheck = z.infer<typeof ApprovalCheck>;

/** To the client's team or ours only; a message to anyone else is a write. */
export const NotifyCheck = z.strictObject({
  when: Conditions.optional(),
  to: z.array(Who).min(1).max(10),
  channel: z.enum(["inbox", "email", "sms"]).default("inbox"),
  message: TemplateString,
  /** Urgent: sent at once whatever the hours, by SMS too, and needs a "Seen" in time. */
  urgent: z
    .strictObject({
      when: Conditions.optional(),
      ackWithin: Duration,
      ifNoAnswer: DeadlineThen.default("stop"),
    })
    .optional(),
  sources: z.array(TemplateString).max(50).optional(),
});
export type NotifyCheck = z.infer<typeof NotifyCheck>;

/** Run in this order: confer, then approval, then the step's write, then notify. */
export const Checks = z.strictObject({
  confer: ConferCheck.optional(),
  approval: ApprovalCheck.optional(),
  notify: z.array(NotifyCheck).max(5).optional(),
});
export type Checks = z.infer<typeof Checks>;

// ── Steps ────────────────────────────────────────────────────────────────────────────────────

/**
 * Wave 5 (docs/plan.md §1.86 "Forks"): what a failing step does. `fail` (absent means it) ends the
 * run, as always; `continue` records the step's outcome `failed` (and `steps.<id>.error`) and the
 * run goes on, so a later `if` can route on it. It never loosens an approval (invariant 8).
 */
export const ON_ERROR = ["fail", "continue"] as const;
export const OnError = z.enum(ON_ERROR);
export type OnError = z.infer<typeof OnError>;

const base = {
  id: NodeId,
  name: z.string(),
  client: ClientVisibility.optional(),
  checks: Checks.optional(),
  /** The owner's review of this step: `off`, `always`, or (absent) the owner decides. */
  review: StepReview.optional(),
  // DECISION (wave 5): `onError` is optional with no default, so a parsed or converted step that
  // never said it keeps its stored shape (no new field in diffs and merges); absent means `fail`.
  onError: OnError.optional(),
};

export const ReadStep = z.object({
  ...base,
  kind: z.literal("read"),
  tool: ToolId,
  input: TemplateObject.default({}),
});

export const SkillStep = z.object({
  ...base,
  kind: z.literal("skill"),
  skill: SkillRef,
  /** Another agent of the same client (by slug) to run the skill; default the owner. */
  agent: Slug.optional(),
  input: TemplateObject.default({}),
  settings: z.record(z.string(), z.unknown()).optional(),
  model: ModelChoice.optional(),
  /**
   * R2: the Library skill as this step customizes it (`applyCustomization`): settings, added
   * instructions, rule rows, a task's model, kept output fields; never its method or types.
   */
  customize: SkillCustomization.optional(),
});

/** A write: to a client's tool (external, approval on by default) or a platform record. */
export const WriteStep = z.object({
  ...base,
  kind: z.literal("write"),
  tool: ToolId,
  input: TemplateObject.default({}),
});

export const PersonStep = z.object({
  ...base,
  kind: z.literal("person"),
  mode: z.enum(["approve", "ask"]),
  assignee: Who,
  title: TemplateString,
  payload: TemplateObject.default({}),
  deadline: Deadline,
  channel: z.enum(["inbox", "email"]).default("inbox"),
  onReject: z.enum(["stop", "continue"]).default("stop"),
  choices: z.array(PersonChoice).min(1).max(6).optional(),
});

/** A two-way exchange with a contact until a goal is met (docs/plan.md §1.86). */
export const ConversationStep = z.object({
  ...base,
  kind: z.literal("conversation"),
  with: TemplateString,
  channel: z.enum(["email", "sms", "whatsapp", "call"]),
  goal: TemplateString,
  mayShare: z.array(z.string().min(1)).max(20).default([]),
  /** What it must find out: field name to record type, `?` for optional. */
  find: z.record(z.string(), z.string()).default({}),
  maxTurns: z.number().int().min(1).max(20).default(4),
  messages: z
    .strictObject({
      first: ApprovalRequirement.default("required"),
      later: z.enum(["required", "within_goal"]).default("required"),
    })
    .prefault({}),
  deadline: Deadline,
});

/** A note to the client's team or ours, standing on its own (a summary at the end of a run). */
export const NotifyStep = z.object({
  ...base,
  kind: z.literal("notify"),
  notify: NotifyCheck,
});

export const WaitStep = z.object({ ...base, kind: z.literal("wait"), for: Duration });

export const StopStep = z.object({
  ...base,
  kind: z.literal("stop"),
  status: z.enum(["succeeded", "failed", "cancelled"]),
});

/** A reusable process used as one step (today's automation), pinned to a version. */
export const SubProcessStep = z.object({
  ...base,
  kind: z.literal("process"),
  process: AutomationRef,
  input: TemplateObject.default({}),
  /** By inner step id: the operator's approval overrides for this client (as `use_automation`). */
  approvals: z.record(NodeId, ApprovalCheck).optional(),
});

export type ReadStep = z.infer<typeof ReadStep>;
export type SkillStep = z.infer<typeof SkillStep>;
export type WriteStep = z.infer<typeof WriteStep>;
export type PersonStep = z.infer<typeof PersonStep>;
export type ConversationStep = z.infer<typeof ConversationStep>;
export type NotifyStep = z.infer<typeof NotifyStep>;
export type WaitStep = z.infer<typeof WaitStep>;
export type StopStep = z.infer<typeof StopStep>;
export type SubProcessStep = z.infer<typeof SubProcessStep>;

type Base = z.infer<z.ZodObject<typeof base>>;

export interface IfPath {
  id: string;
  name: string;
  when: Rules;
  steps: Step[];
}
export interface IfStep extends Base {
  kind: "if";
  paths: IfPath[];
  otherwise: { id: string; steps: Step[] };
}
export interface ForEachStep extends Base {
  kind: "for_each";
  over: string;
  concurrency: number;
  steps: Step[];
}

export type Step =
  | ReadStep
  | SkillStep
  | WriteStep
  | PersonStep
  | ConversationStep
  | NotifyStep
  | IfStep
  | ForEachStep
  | WaitStep
  | StopStep
  | SubProcessStep;
export type StepKind = Step["kind"];

export const STEP_KINDS = [
  "read",
  "skill",
  "write",
  "person",
  "conversation",
  "notify",
  "if",
  "for_each",
  "wait",
  "stop",
  "process",
] as const satisfies readonly StepKind[];

export const IfStep = z.object({
  ...base,
  kind: z.literal("if"),
  get paths() {
    return z
      .array(z.object({ id: NodeId, name: z.string(), when: Rules, steps: z.array(Step) }))
      .min(1);
  },
  get otherwise() {
    return z.object({ id: NodeId, steps: z.array(Step) });
  },
});

export const ForEachStep = z.object({
  ...base,
  kind: z.literal("for_each"),
  over: TemplateString,
  concurrency: z.number().int().min(1).max(50).default(10),
  get steps() {
    return z.array(Step).min(1);
  },
});

export const Step: z.ZodType<Step> = z
  .discriminatedUnion("kind", [
    ReadStep,
    SkillStep,
    WriteStep,
    PersonStep,
    ConversationStep,
    NotifyStep,
    IfStep,
    ForEachStep,
    WaitStep,
    StopStep,
    SubProcessStep,
  ])
  .meta({ id: "ProcessStep" }) as unknown as z.ZodType<Step>;

// ── Process ──────────────────────────────────────────────────────────────────────────────────

/** A process: one or more triggers, then steps top to bottom. */
export const Process = z
  .object({
    schemaVersion: z.literal(4),
    triggers: z.array(Trigger).min(1).max(10),
    steps: z.array(Step),
    handoff: WorkflowHandoff.optional(),
  })
  .meta({ id: "Process" });
export type Process = z.infer<typeof Process>;
