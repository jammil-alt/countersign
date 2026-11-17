// What an intake covers, and the saved starts Sign up now and Invite offer (docs/cases-plan.md
// §4.2 step 2, §4.3; docs/plan.md §1.126). A start is operator-only (`sales_start`): its name, what
// it covers, the lead's note and how the client starts.

import { z } from "zod";
import { isUuid } from "../ids";
import { OWNER_AREAS, type OwnerArea } from "../owners/areas";

const Id = z.string().refine((v) => isUuid(v), "not an id");

/**
 * The areas an intake can cover: every business area but `general` (which is the general section).
 * An area with a pack asks its pack's questions; one without (Sales, Receivables today) asks
 * core's generic area questions.
 */
// DECISION (cases-plan §8 q11, the design): areas without a pack are offered, with generic questions.
export const INTAKE_AREAS = OWNER_AREAS.filter(
  (a): a is Exclude<OwnerArea, "general"> => a !== "general",
);
export const IntakeArea = z.enum(
  INTAKE_AREAS as [Exclude<OwnerArea, "general">, ...Exclude<OwnerArea, "general">[]],
);
export type IntakeArea = z.infer<typeof IntakeArea>;

/** At most this many agent templates in one intake. */
export const COVERS_TEMPLATES_MAX = 10;

/**
 * What an intake covers: the general section, some areas, some agent templates. All empty is
 * "Just the account": no intake, the welcome email only.
 */
export const Covers = z.strictObject({
  general: z.boolean(),
  areas: z
    .array(IntakeArea)
    .max(INTAKE_AREAS.length)
    .refine((a) => new Set(a).size === a.length, "an area is named twice"),
  templateIds: z
    .array(Id)
    .max(COVERS_TEMPLATES_MAX)
    .refine((a) => new Set(a).size === a.length, "a template is named twice"),
});
export type Covers = z.infer<typeof Covers>;

export const EMPTY_COVERS: Covers = { general: false, areas: [], templateIds: [] };

/** Whether a covers asks anything at all (else: "Just the account", no intake). */
export const coversAnything = (c: Covers): boolean =>
  c.general || c.areas.length > 0 || c.templateIds.length > 0;

/**
 * How the client starts: get to the point (the cards) or talk it through with Sloan. Either can
 * switch to the other at any time; both write the same intake.
 */
// DECISION (cases-plan §8 q12, the design): get to the point is the default.
export const START_MODES = ["point", "talk"] as const;
export const StartMode = z.enum(START_MODES);
export type StartMode = z.infer<typeof StartMode>;
export const DEFAULT_START_MODE: StartMode = "point";

export const START_NAME_MAX = 80;
export const LEAD_NOTE_MAX = 2000;

export const SalesStartView = z.object({
  id: z.string(),
  name: z.string(),
  covers: Covers,
  /** The lead's note, as written for the start; the lead's name is filled in when sent. */
  note: z.string(),
  startMode: StartMode,
  /** Made by Mezonas (General only, one per area, one per template, Just the account). */
  seeded: z.boolean(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SalesStartView = z.infer<typeof SalesStartView>;

export const NewSalesStart = z.strictObject({
  name: z.string().trim().min(1).max(START_NAME_MAX),
  covers: Covers,
  note: z.string().trim().max(LEAD_NOTE_MAX).default(""),
  startMode: StartMode.default(DEFAULT_START_MODE),
});
export type NewSalesStart = z.infer<typeof NewSalesStart>;

export const UpdateSalesStart = z.strictObject({
  name: z.string().trim().min(1).max(START_NAME_MAX).optional(),
  covers: Covers.optional(),
  note: z.string().trim().max(LEAD_NOTE_MAX).optional(),
  startMode: StartMode.optional(),
  /** Archived starts aren't offered; nothing is deleted. */
  archived: z.boolean().optional(),
});
export type UpdateSalesStart = z.infer<typeof UpdateSalesStart>;
