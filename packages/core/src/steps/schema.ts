// The step model (docs/step-model-plan.md §4, §5, §9, §13a): workflow `schemaVersion: 5`. Eight step
// kinds (do, loop, fork, for_each, repeat, wait, handoff, end), stored as they are, with declared
// workflow outputs that every End delivers. A Do step is one piece of work: who does it (`doneBy`)
// and what it uses (`uses`) pick the engine that runs it (§4, "How a Do step runs").
//
// DECISION (build item 2): a module of its own while the v4 process schema (`../process`) is still
// read by the executor, the builder and the seeds; once they read this, v3 and v4 go (§12, R2, R3).
// The pieces that don't change (triggers, rules, deadlines, checks, collect items, rule rows, the
// translation's mapping) are imported from where they live today, not copied.

import { z } from "zod";
import { Duration } from "../duration";
import { StepReview } from "../oversight/decision";
import { COLLECT_ITEMS_MAX, CollectItem } from "../process/collect";
import { ReshapeMapping } from "../process/reshape";
import { Checks, CollectEscalation, Deadline, NotifyCheck, OnError, Who } from "../process/schema";
import { NodeId, SkillRef, Slug, TemplateObject, TemplateString, ToolId } from "../schemas/common";
import { ApprovalRequirement } from "../schemas/permissions";
import { Rules } from "../schemas/rules";
import { ModelChoice, SkillRule } from "../schemas/skill";
import {
  AutomationRef,
  ClientVisibility,
  PersonChoice,
  StepPurpose,
  Trigger,
} from "../schemas/workflow";

// ── Fields ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The types a field can have (§13a): plain values, a list of items (each with the fields in `of`),
 * a group of fields (one item), or a link to a record.
 */
export const FIELD_TYPES = [
  "text",
  "number",
  "money",
  "date",
  "yes_no",
  "list",
  "group",
  "record",
] as const;
export const FieldType = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof FieldType>;

export interface Field {
  name: string;
  type: FieldType;
  required: boolean;
  /** One line on what it means. */
  about?: string | undefined;
  /** A list's items' fields, or a group's (`type: list`, `group`). */
  of?: Field[] | undefined;
  /** The kind of record a `record` field links to (`vendor`, `document`). */
  record?: string | undefined;
}

export const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const Field: z.ZodType<Field> = z.lazy(() =>
  z
    .strictObject({
      name: z.string().regex(FIELD_NAME, "letters, digits and _, starting with a letter"),
      type: FieldType,
      required: z.boolean().default(false),
      about: z.string().max(200).optional(),
      of: z.array(Field).max(100).optional(),
      record: z.string().min(1).max(60).optional(),
    })
    .refine((f) => (f.type === "list" || f.type === "group") === (f.of !== undefined), {
      message: "a list or a group names its fields, and only they do",
      path: ["of"],
    })
    .refine((f) => (f.type === "record") === (f.record !== undefined), {
      message: "a record field names the kind of record, and only a record field does",
      path: ["record"],
    }),
) as unknown as z.ZodType<Field>;

export const Fields = z.array(Field).max(100);

// ── What every step has ────────────────────────────────────────────────────────────────────────

const base = {
  id: NodeId,
  /** The step's goal, which is its name (empty in a draft; publishing needs it). */
  name: z.string().trim().max(200),
  purpose: StepPurpose.optional(),
  client: ClientVisibility.optional(),
  review: StepReview.optional(),
  onError: OnError.optional(),
  checks: Checks.optional(),
};

// ── Do ─────────────────────────────────────────────────────────────────────────────────────────

/** Who does a Do step (§5): rules (code), AI (one answer), a person, or an outside contact. */
export const DONE_BY = ["rules", "ai", "person", "contact"] as const;
export const DoneBy = z.enum(DONE_BY);
export type DoneBy = z.infer<typeof DoneBy>;

/** The match types (§7). */
export const MATCH_TYPES = ["exact", "semantic", "hybrid"] as const;
export const MatchType = z.enum(MATCH_TYPES);

/** A Match's settings (§7). Percentages are whole numbers, 0 to 100. */
export const MatchSettings = z.strictObject({
  /** The match profile: what kind of record it is matched to (`vendors`, `vendor-items`). */
  to: Slug,
  type: MatchType,
  /** The profile's keys, in the order tried; absent: the profile's own order. */
  keys: z.array(z.string().min(1).max(60)).max(10).optional(),
  /** At or above it a semantic match is accepted (an exact match is always 100). */
  confidenceThreshold: z.number().int().min(1).max(100).default(90),
  /** Between this and the threshold, each line gets a second opinion; absent: none. */
  secondOpinion: z
    .strictObject({
      from: z.number().int().min(1).max(100).default(70),
      by: z.enum(["ai", "person", "ai_then_person"]).default("ai_then_person"),
    })
    .optional(),
  belowFloor: z.enum(["person", "no_match", "new"]).default("person"),
  /** If the best candidate scores under this, the model is skipped. */
  searchFloor: z.number().int().min(1).max(100).optional(),
  shortlist: z
    .strictObject({
      // DECISION (owner, 2026-11-25, on stream K's measurement): 10. A shortlist of 10 matched as
      // well as 20 on both profiles for less; we can go back to 20 if a client's records need it.
      model: z.number().int().min(1).max(50).default(10),
      person: z.number().int().min(1).max(10).default(5),
    })
    .prefault({}),
  noMatch: z.enum(["not_found", "new", "person"]).default("not_found"),
});
export type MatchSettings = z.infer<typeof MatchSettings>;

/** What a Do step uses (§5): an action, a skill, an automation, a Match, Collect reports, or a gap. */
export const Uses = z.discriminatedUnion("type", [
  /** A connector's or an area's action, by its id (`qbo.bill.create`, `accounting.create_bill`). */
  z.strictObject({ type: z.literal("action"), action: ToolId }),
  z.strictObject({ type: z.literal("skill"), skill: SkillRef }),
  z.strictObject({ type: z.literal("automation"), automation: AutomationRef }),
  z.strictObject({ type: z.literal("match"), match: MatchSettings }),
  z.strictObject({ type: z.literal("collect") }),
  /** Tell the client's team or ours (inbox, email, text), without waiting (today's `notify`). */
  z.strictObject({ type: z.literal("tell") }),
  /** Not built yet (today's `missing` step): it never runs and blocks publishing. */
  z.strictObject({
    type: z.literal("missing"),
    need: z.string().trim().max(300),
    fill: z.enum(["skill", "tool", "connector"]).optional(),
  }),
]);
export type Uses = z.infer<typeof Uses>;

/** Rules' instructions: rule rows and the values they use. */
export const RulesInstructions = z.strictObject({
  rows: z.array(SkillRule).max(500).optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});

/** AI's instructions: what to do, in prose, and optionally the model (shown under More). */
export const AiInstructions = z.strictObject({
  text: z.string().max(8000).optional(),
  model: ModelChoice.optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});

/** A person's instructions: who, to approve or to answer, and what they see. */
export const PersonInstructions = z.strictObject({
  mode: z.enum(["approve", "ask"]),
  who: Who,
  question: TemplateString,
  show: TemplateObject.default({}),
  choices: z.array(PersonChoice).min(1).max(6).optional(),
  deadline: Deadline,
  channel: z.enum(["inbox", "email"]).default("inbox"),
  onReject: z.enum(["stop", "continue"]).default("stop"),
});

/** Collect reports: several people, each sending a report, followed up. */
export const CollectInstructions = z.strictObject({
  items: z.array(CollectItem).min(1).max(COLLECT_ITEMS_MAX),
  escalate: CollectEscalation.optional(),
  ifMissing: z.enum(["stop", "proceed"]).default("stop"),
});

/** An outside contact's instructions: a back-and-forth until the goal is met. */
export const ContactInstructions = z.strictObject({
  with: TemplateString,
  channel: z.enum(["email", "sms", "whatsapp", "call"]),
  goal: TemplateString,
  mayShare: z.array(z.string().min(1)).max(20).default([]),
  maxTurns: z.number().int().min(1).max(20).default(4),
  messages: z
    .strictObject({
      first: ApprovalRequirement.default("required"),
      later: z.enum(["required", "within_goal"]).default("required"),
    })
    .prefault({}),
  deadline: Deadline,
});

export const DoStep = z
  .object({
    ...base,
    kind: z.literal("do"),
    /** Absent only when it uses an automation (its own steps say who does each). */
    doneBy: DoneBy.optional(),
    /** Another agent of the same client (by slug) runs it; absent: this agent (under More). */
    agent: Slug.optional(),
    uses: Uses.optional(),
    /** Each input field's source: the trigger, an earlier step's field, or a fixed value. */
    input: TemplateObject.default({}),
    /** The translation the builder worked out on the incoming side, when the fields differ. */
    translation: ReshapeMapping.optional(),
    rules: RulesInstructions.optional(),
    ai: AiInstructions.optional(),
    person: PersonInstructions.optional(),
    collect: CollectInstructions.optional(),
    contact: ContactInstructions.optional(),
    /** What a Tell says, to whom and how (`uses.type: tell`). */
    tell: NotifyCheck.optional(),
    /** The fields it hands on, when it defines them (rules or AI written in the step). */
    output: Fields.optional(),
  })
  .meta({ id: "DoStep" });
export type DoStep = z.infer<typeof DoStep>;

// ── Loop ───────────────────────────────────────────────────────────────────────────────────────

/** An agent loop (§8): a model works toward a goal with read actions until done or its limit. */
export const LoopStep = z.object({
  ...base,
  kind: z.literal("loop"),
  /** A saved Loop from the library; absent: written in the step. */
  skill: SkillRef.optional(),
  goal: z.string().trim().max(1000),
  input: TemplateObject.default({}),
  translation: ReshapeMapping.optional(),
  output: Fields.default([]),
  /** The Get actions it may call (connectors' and areas'). */
  reads: z.array(ToolId).max(30).default([]),
  instructions: z.string().max(8000).default(""),
  model: ModelChoice.optional(),
  maxTurns: z.number().int().min(1).max(50).default(10),
  atLimit: z.enum(["stop", "hand_back"]).default("stop"),
});
export type LoopStep = z.infer<typeof LoopStep>;

// ── Flow ───────────────────────────────────────────────────────────────────────────────────────

export const WaitStep = z.object({ ...base, kind: z.literal("wait"), for: Duration });
export type WaitStep = z.infer<typeof WaitStep>;

export const HandoffStep = z.object({
  ...base,
  kind: z.literal("handoff"),
  to: z.strictObject({
    agent: z.union([Slug, z.literal(""), z.literal("@self")]),
    step: z.union([NodeId, z.literal("")]),
    workflow: Slug.optional(),
  }),
  input: TemplateObject.default({}),
});
export type HandoffStep = z.infer<typeof HandoffStep>;

/** Where a path finishes (§9): the declared outputs it delivers, or nothing to do and why. */
export const EndStep = z.object({
  ...base,
  kind: z.literal("end"),
  outputs: z.array(NodeId).max(10).default([]),
  nothingToDo: z.string().trim().max(300).optional(),
  /** A path that ends in failure on purpose (today's Stop with `failed`). */
  status: z.enum(["succeeded", "failed", "cancelled"]).default("succeeded"),
});
export type EndStep = z.infer<typeof EndStep>;

export const CHOICE_TEXT_MAX = 300;
export const REPEAT_MAX_TIMES = 10;

type Base = z.infer<z.ZodObject<typeof base>>;
export interface ForkPath {
  id: string;
  name: string;
  when: z.infer<typeof Rules>;
  describe?: string | undefined;
  steps: Step[];
}
export interface ForkStep extends Base {
  kind: "fork";
  paths: ForkPath[];
  otherwise: { id: string; steps: Step[] };
  decide?: "rules" | "agent" | undefined;
  show?: Record<string, unknown> | undefined;
  ifUnsure?: "otherwise" | "ask" | undefined;
}
export interface ForEachStep extends Base {
  kind: "for_each";
  over: string;
  concurrency: number;
  steps: Step[];
}
export type RepeatUntil =
  | { rules: z.infer<typeof Rules> }
  | { agent: { goal: string; show?: Record<string, unknown> | undefined } };
export interface RepeatStep extends Base {
  kind: "repeat";
  steps: Step[];
  until: RepeatUntil;
  maxTimes: number;
  between?: string | undefined;
  onLimit: "stop" | "proceed";
}

export type Step =
  | DoStep
  | LoopStep
  | ForkStep
  | ForEachStep
  | RepeatStep
  | WaitStep
  | HandoffStep
  | EndStep;
export type StepKind = Step["kind"];
export const STEP_KINDS = [
  "do",
  "loop",
  "fork",
  "for_each",
  "repeat",
  "wait",
  "handoff",
  "end",
] as const satisfies readonly StepKind[];

export const ForkStep = z.object({
  ...base,
  kind: z.literal("fork"),
  get paths() {
    return z
      .array(
        z.object({
          id: NodeId,
          name: z.string(),
          when: Rules,
          describe: z.string().max(CHOICE_TEXT_MAX).optional(),
          steps: z.array(Step),
        }),
      )
      .min(1);
  },
  get otherwise() {
    return z.object({ id: NodeId, steps: z.array(Step) });
  },
  decide: z.enum(["rules", "agent"]).optional(),
  show: TemplateObject.optional(),
  ifUnsure: z.enum(["otherwise", "ask"]).optional(),
});

export const ForEachStep = z.object({
  ...base,
  kind: z.literal("for_each"),
  over: TemplateString,
  concurrency: z.number().int().min(1).max(50).default(10),
  get steps() {
    return z.array(Step);
  },
});

export const RepeatUntil = z.union([
  z.strictObject({ rules: Rules }),
  z.strictObject({
    agent: z.strictObject({
      goal: z.string().trim().min(1).max(CHOICE_TEXT_MAX),
      show: TemplateObject.optional(),
    }),
  }),
]);

export const RepeatStep = z.object({
  ...base,
  kind: z.literal("repeat"),
  get steps() {
    return z.array(Step);
  },
  until: RepeatUntil,
  maxTimes: z.number().int().min(1).max(REPEAT_MAX_TIMES).default(3),
  between: Duration.optional(),
  onLimit: z.enum(["stop", "proceed"]).default("stop"),
});

// The annotation breaks the type cycle between Step and the container steps' getters.
export const Step: z.ZodType<Step> = z
  .discriminatedUnion("kind", [
    DoStep,
    LoopStep,
    ForkStep,
    ForEachStep,
    RepeatStep,
    WaitStep,
    HandoffStep,
    EndStep,
  ])
  .meta({ id: "Step" }) as unknown as z.ZodType<Step>;

// ── Workflow outputs ───────────────────────────────────────────────────────────────────────────

/** The kinds of workflow output (§9). */
export const OUTPUT_KINDS = ["report", "write", "save", "handoff", "pass_on", "nothing"] as const;
export const OutputKind = z.enum(OUTPUT_KINDS);
export type OutputKind = z.infer<typeof OutputKind>;

/**
 * A declared result of a workflow (§9): what it is, where it goes and how it is delivered. An End
 * that selects it delivers it, with its checks (a write's approver is on by default, invariant 8).
 */
export const WorkflowOutput = z.strictObject({
  id: NodeId,
  name: z.string().trim().max(120),
  about: z.string().max(200).optional(),
  kind: OutputKind,
  fields: Fields.default([]),
  /** report: to whom, how, and what it says. */
  report: z
    .strictObject({
      to: z.array(Who).max(10),
      channel: z.enum(["inbox", "email", "sms"]).default("inbox"),
      message: TemplateString,
      sources: z.array(TemplateString).max(50).optional(),
    })
    .optional(),
  /** write (a connector's action) or save (an area's action): which, with what. */
  action: z.strictObject({ action: ToolId, input: TemplateObject.default({}) }).optional(),
  /** handoff: another agent, or another workflow of this agent, at a step. */
  handoff: z
    .strictObject({
      agent: z.union([Slug, z.literal("@self")]),
      workflow: Slug.optional(),
      step: NodeId,
      input: TemplateObject.default({}),
    })
    .optional(),
  /** pass_on: what other agents' hand-off triggers receive. */
  passOn: z
    .strictObject({
      output: z.union([TemplateString, TemplateObject]),
      sources: z.union([TemplateString, z.array(TemplateString).max(50)]).optional(),
    })
    .optional(),
  /** Only when it applies (an exception report only when there are exceptions). */
  when: Rules.optional(),
  checks: Checks.optional(),
});
export type WorkflowOutput = z.infer<typeof WorkflowOutput>;

// ── The workflow ───────────────────────────────────────────────────────────────────────────────

export const Workflow = z
  .object({
    schemaVersion: z.literal(5),
    triggers: z.array(Trigger).min(1).max(10),
    outputs: z.array(WorkflowOutput).max(20),
    steps: z.array(Step),
  })
  .meta({ id: "Workflow" });
export type Workflow = z.infer<typeof Workflow>;
export type WorkflowInput = z.input<typeof Workflow>;
