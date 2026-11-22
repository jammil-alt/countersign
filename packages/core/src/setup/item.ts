// The setup checklist (docs/builder-plan.md §6): what a client copy of a template needs from the
// client before each go-live stage. The items travel in the agent's version (`definition.setup`),
// made by code from the build's client intake form, its `client_setup` decisions and the draft's
// writes; each client's progress on them is operational (`agent.stage_state.setup`), never in a
// version. Kept apart from the checklist's logic so the agent schema can import it without a cycle.

import { z } from "zod";
import { DecimalString } from "../money";

/** connect a tool, answer a question, send a file, confirm a decision point. */
export const SETUP_ITEM_KINDS = ["connect", "answer", "file", "confirm"] as const;
export const SetupItemKind = z.enum(SETUP_ITEM_KINDS);
export type SetupItemKind = z.infer<typeof SetupItemKind>;

/** The stage an item holds: setup and trial hold the trial's start; live holds sign-off and live. */
export const SETUP_GUARDS = ["setup", "trial", "live"] as const;
export const SetupGuard = z.enum(SETUP_GUARDS);
export type SetupGuard = z.infer<typeof SetupGuard>;

/** The parameter types an answer can set (buckets are set in the builder, never by an answer). */
export const SETUP_SETTING_TYPES = ["number", "text", "date", "money"] as const;
export const SetupSettingType = z.enum(SETUP_SETTING_TYPES);
export type SetupSettingType = z.infer<typeof SetupSettingType>;

export const SetupItemId = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/);

/**
 * Which skill parameter an answer sets: the agent's value for the skill (`definition.skills[]`),
 * or one step's (`customize.parameters`) when the starting value was set on that step.
 */
export const SetupSetting = z.object({
  /** The skill as the agent lists it (`definition.skills[].skill`), by id. */
  skill: z.string().min(1).max(200),
  parameter: z.string().min(1).max(100),
  type: SetupSettingType,
  /** The step whose own value it sets, when the starting value is on the step. */
  stepId: z.string().min(1).max(100).optional(),
});
export type SetupSetting = z.infer<typeof SetupSetting>;

/** A date as a limit: `2026-12-24`. */
export const SetupDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "not a date");

/**
 * What an answer may be: a number between `min` and `max`, a date between `earliest` and `latest`
 * (G11), or one of `options`.
 */
export const SetupBounds = z.object({
  min: DecimalString.optional(),
  max: DecimalString.optional(),
  earliest: SetupDate.optional(),
  latest: SetupDate.optional(),
  options: z.array(z.string().trim().min(1).max(200)).min(1).max(50).optional(),
});
export type SetupBounds = z.infer<typeof SetupBounds>;

export const SETUP_ITEMS_MAX = 60;

/** One item of the checklist, as the agent's version carries it. */
export const SetupItem = z.object({
  id: SetupItemId,
  label: z.string().trim().min(1).max(300),
  kind: SetupItemKind,
  hint: z.string().trim().max(500).default(""),
  guards: SetupGuard,
  /** A connect item's connector (a manifest id): done when the client has it connected and bound. */
  connector: z.string().min(1).max(64).optional(),
  /** The parameter an answer sets, by code, as a new version (§10.15 "client settings"). */
  setting: SetupSetting.optional(),
  bounds: SetupBounds.optional(),
  /** The starting value the build chose, shown as a suggestion. */
  suggested: z.string().trim().max(300).optional(),
  /** Where it came from: the intake form, a decision, or the draft's writes. */
  source: z.enum(["form", "decision", "write"]).optional(),
});
export type SetupItem = z.infer<typeof SetupItem>;

/** `definition.setup`: absent on bundles made before the checklist (they parse and hash as they were). */
export const SetupChecklist = z.array(SetupItem).max(SETUP_ITEMS_MAX);
export type SetupChecklist = z.infer<typeof SetupChecklist>;

/** One item's progress on a client copy (`agent.stage_state.setup[itemId]`). */
export const SetupProgress = z.object({
  done: z.boolean(),
  /** The user who did it (null for the platform: a connect item done by its connection). */
  by: z.string().nullable(),
  /** Their name as it was then, for "who did what". */
  byName: z.string().max(200).nullable().default(null),
  /** Which side: the client's team, or us. */
  side: z.enum(["client", "operator"]).nullable().default(null),
  at: z.string().min(1),
  /** The answer, or a confirm's note, in the person's words. */
  value: z.string().max(2000).optional(),
  /** A file item's documents. */
  files: z.array(z.string().min(1).max(64)).max(20).optional(),
  /** The version the answer's setting was written into. */
  versionId: z.string().optional(),
});
export type SetupProgress = z.infer<typeof SetupProgress>;
