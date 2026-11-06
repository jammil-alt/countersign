import { z } from "zod";
import { JsonSchema } from "./common";

/** A sense type (ARCHITECTURE §8): its payload schema and a sample for the builder's trigger picker. */
export const EventTypeSpec = z
  .object({
    type: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "dotted, e.g. document.received"),
    description: z.string(),
    subjectType: z.string().optional(),
    payload: JsonSchema,
    sample: z.unknown(),
  })
  .meta({ id: "EventTypeSpec" });
export type EventTypeSpec = z.infer<typeof EventTypeSpec>;

/** Platform event types (ARCHITECTURE §8); payload schemas live with their emitters. */
export const PLATFORM_EVENT_TYPES = [
  "transaction.created",
  "transaction.updated",
  "document.received",
  "document.extracted",
  "document.extraction_failed",
  "inbox.resolved",
  "external_action.done",
  "external_action.failed",
  "alert.raised",
  "schedule.tick",
  // The supervisor (docs/plan.md §1.28): payloads in ../supervisor/health.ts.
  "run.failed",
  "connection.needs_attention",
  "health.checked",
  // v0.12 W1-F: accounts receivable (ARCHITECTURE §6.2); payloads in packages/senses/src/platform.ts.
  "receivable.created",
  "receivable.updated",
  "receivable.paid",
] as const;
export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];
