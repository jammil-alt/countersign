// R5 (docs/plan.md §1.86; ARCHITECTURE §10.14 "Undo"): what an inbox item says about an answer that
// came after its run went ahead (`payload.lateAnswer`), and the undo a late no is offered
// (`payload.undo`). apps/api writes both on the item (apps/api/src/undo/offer.ts); the cards read
// them here. Parsed, never trusted: a payload that doesn't match shows nothing of either.
import { isPlainObject } from "@countersign/core";
import { z } from "zod";

// DECISION: the shapes are mirrored from apps/api/src/undo/offer.ts (the web imports only core);
// they move to core with the undo routes.
export const LateAnswerNote = z.object({
  at: z.string(),
  by: z.string(),
  approved: z.boolean(),
  actionId: z.string().nullable(),
  actionStatus: z.string().nullable(),
});
export type LateAnswerNote = z.infer<typeof LateAnswerNote>;

export const UndoOffer = z.object({
  actionId: z.string(),
  tool: z.string(),
  text: z.string(),
  for: z.array(z.string()),
  lead: z.boolean(),
  status: z.enum(["offered", "done", "failed"]),
  undoActionId: z.string().optional(),
  by: z.string().optional(),
  at: z.string().optional(),
  reason: z.string().optional(),
});
export type UndoOffer = z.infer<typeof UndoOffer>;

/** The payload keys this reads: plumbing for the cards' fact lists. */
export const LATE_KEYS = ["lateAnswer", "undo", "sourceItemId"] as const;

export function lateAnswerOf(payload: unknown): LateAnswerNote | null {
  if (!isPlainObject(payload)) return null;
  const r = LateAnswerNote.safeParse(payload.lateAnswer);
  return r.success ? r.data : null;
}

export function undoOfferOf(payload: unknown): UndoOffer | null {
  if (!isPlainObject(payload)) return null;
  const r = UndoOffer.safeParse(payload.undo);
  return r.success ? r.data : null;
}

/**
 * What the card says about a late answer:
 * - `yes`: a yes after we went ahead, nothing to do;
 * - `offer` / `done` / `failed`: a late no to a write that can be taken back, and where the undo is;
 * - `none`: a late no to a write that went through and can't be taken back (a sent message);
 * - `nothing`: a late no where the write never went through.
 */
export type LateState = "yes" | "offer" | "done" | "failed" | "none" | "nothing";

export function lateState(late: LateAnswerNote, offer: UndoOffer | null): LateState {
  if (late.approved) return "yes";
  if (offer) return offer.status === "offered" ? "offer" : offer.status;
  return late.actionStatus === "done" ? "none" : "nothing";
}
