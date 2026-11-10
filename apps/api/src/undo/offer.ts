// R5 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Undo"): what an inbox item says about an
// answer that came after its run went ahead, and the undo offered with a late no. Both live in the
// item's payload, so the portal's and the back office's cards show them as they are (no new
// column); the undo route reads the offer back from there.

import { isPlainObject } from "@countersign/core";
import { z } from "zod";

/** Who answered after the run went ahead, and when (the item's `payload.lateAnswer`). */
export const LateAnswerNote = z.object({
  /** ISO time of the answer. */
  at: z.string(),
  by: z.string(),
  approved: z.boolean(),
  /** The write that went ahead, and how it stood when the answer came. */
  actionId: z.string().nullable(),
  actionStatus: z.string().nullable(),
});
export type LateAnswerNote = z.infer<typeof LateAnswerNote>;

/** The undo offered with a late no (the item's `payload.undo`). */
export const UndoOffer = z.object({
  actionId: z.string(),
  tool: z.string(),
  /** The tool's undo in one line (processes.describeUndo). */
  text: z.string(),
  /** Who may press it: the person who said no. */
  for: z.array(z.string()).min(1),
  /**
   * And the client's lead, whoever that is when it is pressed.
   * DECISION: the lead is not named by id here, so a portal card never carries one of our people
   * (invariant 11, P-6), and a new lead inherits the offer.
   */
  lead: z.boolean(),
  status: z.enum(["offered", "done", "failed"]),
  /** Set once pressed: the undo's own action, who pressed and when, and why it failed. */
  undoActionId: z.string().optional(),
  by: z.string().optional(),
  at: z.string().optional(),
  reason: z.string().optional(),
});
export type UndoOffer = z.infer<typeof UndoOffer>;

/** The undo an item's payload offers, or null. */
export function undoOfferOf(payload: unknown): UndoOffer | null {
  if (!isPlainObject(payload)) return null;
  const parsed = UndoOffer.safeParse(payload.undo);
  return parsed.success ? parsed.data : null;
}

/** The title of the lead's item, from the late item's own (an inbox title is at most 200). */
export function lateTitle(title: string): string {
  const text = `Answered after we went ahead: ${title}`;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
