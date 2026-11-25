import { z } from "zod";
import { LocalizedString, localizedText } from "../i18n/locale";
// v0.12 W2-E: who may start a message trigger.
import { PeopleFilter } from "../triggers/people";
import { WebhookDataSchema } from "../triggers/sample";
import { JsonSchema, NodeId, Slug, TemplateObject, TemplateString } from "./common";
import { Rules } from "./rules";

/** Where a step shows in the client's run timeline (ARCHITECTURE §10.6). */
export const ClientVisibility = z.object({
  visible: z.boolean(),
  label: z.string().optional(),
});

/** The most a step's purpose may say: one sentence (docs/sop-plan.md §3). */
export const STEP_PURPOSE_MAX = 200;

/**
 * Why a step is there, in one sentence the client reads in the agent's SOP ("Looks the vendor up
 * in QuickBooks so the bill goes to the right vendor"). Written when the step is built and edited
 * by the operator, like its name; versioned and merged with the step. Optional with no default, so
 * stored bundles parse and hash as they were (docs/sop-plan.md §3, owner 2026-11-21).
 */
export const StepPurpose = z.string().trim().min(1).max(STEP_PURPOSE_MAX);

export const PersonChoice = z.strictObject({
  value: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/, "letters, digits, - and _"),
  label: LocalizedString,
});
export type PersonChoice = z.infer<typeof PersonChoice>;

// v0.12 W2-B: automations (ARCHITECTURE §10.7; docs/plan.md §1.45).
/** An automation pinned to one version: `<slug>@<version>`. */
export const AutomationRef = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*@[1-9]\d{0,8}$/,
    "an automation slug and its version, e.g. follow-up@2",
  );

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
  /**
   * §1.164: the shape of the delivery's data (`{{trigger.data.…}}`), inferred from a sample the
   * operator pasted: field names and types only, never the sample's values. Absent: any path reads.
   */
  dataSchema: WebhookDataSchema.optional(),
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

/**
 * Collect reports (owner, 2026-11-24): "a trigger where any report starts the process and all the
 * other reports start listening… once we receive all of them we kick off the process". The first
 * report emailed to a collect step's address (the agent's own with `+<step id>`) starts a run;
 * that step, the process's first, takes it and listens for the others, each on its own rules.
 * Only a v4 process takes one (validation), once, naming its first step.
 */
export const ReportTriggerOn = z.object({
  type: z.literal("report"),
  /** The collect step it starts: the process's first step. */
  step: NodeId,
});

export const TriggerOn = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: z.string().min(1), filter: Rules.optional() }),
  z.object({
    type: z.literal("schedule"),
    cron: z.string().min(1),
    /** IANA zone; default the client's timezone. */
    tz: z.string().optional(),
    // v0.12 W2-E: skip US federal holidays (observed) and the client's own dates, in its zone.
    skipHolidays: z.boolean().optional(),
    // DECISION (owner, 2026-11-21: "every other Monday"; docs/plan.md §1.177): cron cannot say
    // "every other week", so the trigger says it beside its cron: of the cron's ticks, only those
    // in every `weeks`th week run, in whole weeks counted from `from` (a date in the trigger's
    // zone; the builder writes the Sunday that starts the first week). Optional, so stored
    // versions parse and hash as before.
    every: z
      .object({
        weeks: z.number().int().min(2).max(8),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date such as 2026-11-22"),
      })
      .optional(),
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
  // Collect reports (owner, 2026-11-24)
  ReportTriggerOn,
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
