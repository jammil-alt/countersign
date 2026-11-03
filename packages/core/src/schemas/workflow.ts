import { z } from "zod";
import { Duration } from "../duration";
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
});

export const ActionStep = z.object({
  ...base,
  kind: z.literal("action"),
  tool: ToolId,
  input: TemplateObject.default({}),
  approval: Approval.prefault({}),
});

export const PersonStep = z.object({
  ...base,
  kind: z.literal("person"),
  mode: z.enum(["approve", "ask"]),
  /** A role or a user id. */
  assignee: z.string().min(1),
  title: TemplateString,
  payload: TemplateObject.default({}),
  timeout: Duration,
  remindEvery: Duration.optional(),
  channel: z.enum(["inbox", "email"]).default("inbox"),
  onReject: z.enum(["stop", "continue"]).default("stop"),
  onTimeout: z.enum(["stop", "continue", "notify_operator"]),
});

export const WaitStep = z.object({ ...base, kind: z.literal("wait"), for: Duration });

export const NotifyStep = z.object({
  ...base,
  kind: z.literal("notify"),
  channel: z.enum(["thread", "email", "digest"]),
  to: TemplateString.optional(),
  message: TemplateString,
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

export type SkillStep = z.infer<typeof SkillStep>;
export type ActionStep = z.infer<typeof ActionStep>;
export type PersonStep = z.infer<typeof PersonStep>;
export type WaitStep = z.infer<typeof WaitStep>;
export type NotifyStep = z.infer<typeof NotifyStep>;
export type StopStep = z.infer<typeof StopStep>;
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
  | StopStep;
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
  ])
  .meta({ id: "Step" }) as unknown as z.ZodType<Step>;

export const TriggerOn = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: z.string().min(1), filter: Rules.optional() }),
  z.object({
    type: z.literal("schedule"),
    cron: z.string().min(1),
    /** IANA zone; default the client's timezone. */
    tz: z.string().optional(),
  }),
  z.object({ type: z.literal("manual"), input: JsonSchema }),
  z.object({ type: z.literal("command"), command: z.string().min(1) }),
]);
export type TriggerOn = z.infer<typeof TriggerOn>;

export const Trigger = z.object({ id: NodeId, on: TriggerOn });
export type Trigger = z.infer<typeof Trigger>;

/** ARCHITECTURE §10.1: one trigger, then a structured list of steps. */
export const Workflow = z
  .object({
    schemaVersion: z.literal(3),
    trigger: Trigger,
    steps: z.array(Step),
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
    step.kind === "notify"
  );
}

export function clientLabel(step: Step): string {
  return step.client?.label ?? step.name;
}
