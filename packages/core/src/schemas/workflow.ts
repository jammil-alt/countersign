import { z } from "zod";
import { Duration } from "../duration";
import { LocalizedString, localizedText } from "../i18n/locale";
// v0.12 W2-E: who may start a message trigger.
import { PeopleFilter } from "../triggers/people";
import { Approval } from "./approval";
import {
  JsonSchema,
  NodeId,
  SkillRef,
  Slug,
  TemplateObject,
  TemplateString,
  ToolId,
} from "./common";
import { Rules } from "./rules";
import { ModelChoice } from "./skill";

/** Where a step shows in the client's run timeline (ARCHITECTURE §10.6). */
export const ClientVisibility = z.object({
  visible: z.boolean(),
  label: z.string().optional(),
});

const base = {
  id: NodeId,
  name: z.string(),
  client: ClientVisibility.optional(),
};

export const SkillStep = z.object({
  ...base,
  kind: z.literal("skill"),
  skill: SkillRef,
  /** Another agent of the same client (by slug) to run the skill; default the owner. */
  agent: Slug.optional(),
  input: TemplateObject.default({}),
  settings: z.record(z.string(), z.unknown()).optional(),
  /** Only when the skill's tools can write to a client tool (validation checks). */
  approval: Approval.optional(),
  // v0.13 W2-H: the model this step runs on, over the skill's (task) or the agent's (agent).
  /** Overrides the model of a `task` or `agent` skill; not allowed on a `tool` skill (§10.11). */
  model: ModelChoice.optional(),
});

export const ActionStep = z.object({
  ...base,
  kind: z.literal("action"),
  tool: ToolId,
  input: TemplateObject.default({}),
  approval: Approval.prefault({}),
});

// v0.12 W1-D: quick answers (ARCHITECTURE §11.1).
/** One quick answer to a person step's question: shown as a button with its label. */
export const PersonChoice = z.strictObject({
  value: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/, "letters, digits, - and _"),
  label: LocalizedString,
});
export type PersonChoice = z.infer<typeof PersonChoice>;

export const PersonStep = z.object({
  ...base,
  kind: z.literal("person"),
  mode: z.enum(["approve", "ask"]),
  /**
   * A role or a user id; v0.12 W1-C: or `lead`, a lead check: the client's lead, else the operator
   * role (ARCHITECTURE §11.2).
   */
  assignee: z.string().min(1),
  title: TemplateString,
  payload: TemplateObject.default({}),
  timeout: Duration,
  remindEvery: Duration.optional(),
  channel: z.enum(["inbox", "email"]).default("inbox"),
  onReject: z.enum(["stop", "continue"]).default("stop"),
  onTimeout: z.enum(["stop", "continue", "notify_operator"]),
  // v0.12 W1-D: only on `ask`; the answer is one `value`, and a fork can branch on
  // `steps.<id>.output.answer`.
  choices: z.array(PersonChoice).min(1).max(6).optional(),
});

export const WaitStep = z.object({ ...base, kind: z.literal("wait"), for: Duration });

export const NotifyStep = z.object({
  ...base,
  kind: z.literal("notify"),
  channel: z.enum(["thread", "email", "digest"]),
  to: TemplateString.optional(),
  message: TemplateString,
  /**
   * The record ids the notice rests on (CLAUDE.md invariant 10): each entry an id, or a reference
   * to one or to a list of them (`{{steps.match.output.sources}}`). Optional.
   */
  // DECISION: a notice cites its records with an optional list on the notify step, resolved to
  // ids and stored as the message's `sources`, rather than a new step kind (docs/plan.md §1.30).
  sources: z.array(TemplateString).max(50).optional(),
});

export const StopStep = z.object({
  ...base,
  kind: z.literal("stop"),
  status: z.enum(["succeeded", "failed", "cancelled"]),
});

export const ForkPath = z.object({
  id: NodeId,
  name: z.string(),
  when: Rules,
  get steps() {
    return z.array(Step);
  },
});

export const ForkOtherwise = z.object({
  id: NodeId,
  get steps() {
    return z.array(Step);
  },
});

export const ForkStep = z.object({
  ...base,
  kind: z.literal("fork"),
  get paths() {
    return z.array(ForkPath);
  },
  get otherwise() {
    return ForkOtherwise;
  },
});

export const ForEachStep = z.object({
  ...base,
  kind: z.literal("for_each"),
  /** A template that resolves to an array. */
  over: TemplateString,
  concurrency: z.number().int().min(1).max(50).default(10),
  get steps() {
    return z.array(Step);
  },
});

// v0.12 W2-B: automations (ARCHITECTURE §10.7; docs/plan.md §1.45).
/** An automation pinned to one version: `<slug>@<version>`. */
export const AutomationRef = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*@[1-9]\d{0,8}$/,
    "an automation slug and its version, e.g. follow-up@2",
  );

/**
 * A reusable chain of steps used as one step. Its input is checked against the automation's input
 * schema; its output is the automation's `output`. `approvals` (client agents only, set by the
 * operator) overrides an inner write step's approval, by the inner step's id.
 */
export const UseAutomationStep = z.object({
  ...base,
  kind: z.literal("use_automation"),
  automation: AutomationRef,
  input: TemplateObject.default({}),
  approvals: z.record(NodeId, Approval).optional(),
});

export type SkillStep = z.infer<typeof SkillStep>;
export type ActionStep = z.infer<typeof ActionStep>;
export type PersonStep = z.infer<typeof PersonStep>;
export type WaitStep = z.infer<typeof WaitStep>;
export type NotifyStep = z.infer<typeof NotifyStep>;
export type StopStep = z.infer<typeof StopStep>;
// v0.12 W2-B
export type UseAutomationStep = z.infer<typeof UseAutomationStep>;
export interface ForkPath {
  id: string;
  name: string;
  when: Rules;
  steps: Step[];
}
export interface ForkOtherwise {
  id: string;
  steps: Step[];
}
export interface ForkStep {
  id: string;
  name: string;
  client?: z.infer<typeof ClientVisibility> | undefined;
  kind: "fork";
  paths: ForkPath[];
  otherwise: ForkOtherwise;
}
export interface ForEachStep {
  id: string;
  name: string;
  client?: z.infer<typeof ClientVisibility> | undefined;
  kind: "for_each";
  over: string;
  concurrency: number;
  steps: Step[];
}
export type Step =
  | SkillStep
  | ActionStep
  | PersonStep
  | ForkStep
  | ForEachStep
  | WaitStep
  | NotifyStep
  | StopStep
  // v0.12 W2-B
  | UseAutomationStep;
export type StepKind = Step["kind"];
export const STEP_KINDS = [
  "skill",
  "action",
  "person",
  "fork",
  "for_each",
  "wait",
  "notify",
  "stop",
  // v0.12 W2-B
  "use_automation",
] as const satisfies readonly StepKind[];

// The annotation breaks the type cycle between Step and the container steps' getters.
export const Step: z.ZodType<Step> = z
  .discriminatedUnion("kind", [
    SkillStep,
    ActionStep,
    PersonStep,
    ForkStep,
    ForEachStep,
    WaitStep,
    NotifyStep,
    StopStep,
    // v0.12 W2-B
    UseAutomationStep,
  ])
  .meta({ id: "Step" }) as unknown as z.ZodType<Step>;

// v0.12 W2-E: triggers, six kinds (ARCHITECTURE §10.1, §10.8; docs/plan.md §1.48). Each new kind is
// a new union member and every new field is optional, so stored versions parse and hash as before.
export const RATE_LIMIT_WINDOWS = ["minute", "hour", "day"] as const;
/** Deliveries over `max` in the window start no run (a webhook trigger's guard). */
export const TriggerRateLimit = z.strictObject({
  max: z.number().int().min(1).max(10_000),
  per: z.enum(RATE_LIMIT_WINDOWS),
});
export type TriggerRateLimit = z.infer<typeof TriggerRateLimit>;

export const MESSAGE_CHANNELS = ["email", "sms", "whatsapp", "command", "sloan"] as const;
export const MessageChannel = z.enum(MESSAGE_CHANNELS);
export type MessageChannel = z.infer<typeof MessageChannel>;

/** `reply.confirm`: fixed words to the sender, at most a text message long, with no references. */
export const ReplyConfirm = localizedText(z.string().trim().min(1).max(320));

export const WebhookTriggerOn = z.object({
  type: z.literal("webhook"),
  /** One of the client's inbound hooks (ARCHITECTURE §6.6). */
  hookId: z.uuid(),
  /** "Run only if", over the delivery (`{{trigger.data.…}}`). */
  filter: Rules.optional(),
  /** A template over the delivery: the same key twice starts one run. */
  dedupeKey: TemplateString.optional(),
  rateLimit: TriggerRateLimit.optional(),
});

export const MessageTriggerOn = z.object({
  type: z.literal("message"),
  channels: z.array(MessageChannel).min(1).max(MESSAGE_CHANNELS.length),
  from: PeopleFilter,
  reply: z.object({ confirm: ReplyConfirm }).optional(),
});

export const HandoffTriggerOn = z.object({
  type: z.literal("handoff"),
  /** Another agent of the same client (its slug), and optionally one of its workflows. */
  from: z.object({ agent: Slug, workflow: Slug.optional() }),
  filter: Rules.optional(),
});
// ── end v0.12 W2-E ──

export const TriggerOn = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: z.string().min(1), filter: Rules.optional() }),
  z.object({
    type: z.literal("schedule"),
    cron: z.string().min(1),
    /** IANA zone; default the client's timezone. */
    tz: z.string().optional(),
    // v0.12 W2-E: skip US federal holidays (observed) and the client's own dates, in its zone.
    skipHolidays: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("manual"),
    input: JsonSchema,
    // v0.12 W1-A: Run now (ARCHITECTURE §11.5). The client may start this workflow from its
    // service with a form built from `input`; optional, so stored versions parse and hash as before.
    client: z
      .object({ canRun: z.boolean(), label: z.string().trim().min(1).max(80).optional() })
      .optional(),
  }),
  z.object({ type: z.literal("command"), command: z.string().min(1) }),
  // v0.12 W2-E
  WebhookTriggerOn,
  MessageTriggerOn,
  HandoffTriggerOn,
]);
export type TriggerOn = z.infer<typeof TriggerOn>;

export const Trigger = z.object({ id: NodeId, on: TriggerOn });
export type Trigger = z.infer<typeof Trigger>;

// v0.12 W2-E
/** What a successful run passes on: a template over the trigger and step outputs, and its sources. */
export const WorkflowHandoff = z.object({
  output: z.union([TemplateString, TemplateObject]),
  /** Record ids: a reference to a list, or a list of ids and references. */
  sources: z.union([TemplateString, z.array(TemplateString).max(50)]).optional(),
});
export type WorkflowHandoff = z.infer<typeof WorkflowHandoff>;

/** ARCHITECTURE §10.1: one trigger, then a structured list of steps. */
export const Workflow = z
  .object({
    schemaVersion: z.literal(3),
    trigger: Trigger,
    steps: z.array(Step),
    // v0.12 W2-E: other ways to start the same workflow (each with its own id), and what a
    // successful live run passes on to a handoff trigger (ARCHITECTURE §10.8).
    moreTriggers: z.array(Trigger).max(9).optional(),
    handoff: WorkflowHandoff.optional(),
  })
  .meta({ id: "Workflow" });
export type Workflow = z.infer<typeof Workflow>;

/** By default skill, action, person and notify steps show in the client timeline; logic is hidden. */
export function isClientVisible(step: Step): boolean {
  if (step.client) return step.client.visible;
  return (
    step.kind === "skill" ||
    step.kind === "action" ||
    step.kind === "person" ||
    step.kind === "notify" ||
    // v0.12 W2-B: a use step is one piece of work on the timeline; its inner steps are not in the
    // bundle, so they never show there (ARCHITECTURE §10.6, §10.7).
    // DECISION: shown by default, like a skill step.
    step.kind === "use_automation"
  );
}

export function clientLabel(step: Step): string {
  return step.client?.label ?? step.name;
}
