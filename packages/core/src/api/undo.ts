// R5 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Undo"): the Undo a late no is offered, in the
// route contract. The person who said no or a client admin (in the portal), or the client's lead
// (in the back office), presses it on the item; apps/api's undo/routes.ts mounts these specs and
// runs the undo as a write of its own through the external-action path.
//
// Not the Desk's undo (`/api/inbox/:id/undo`, inside the window before a write runs): this one
// takes back a write that already ran.

import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const IdParams = z.object({ id: z.string().refine((v) => isUuid(v), "not an id") });

/** What pressing Undo came to: done, failed at the tool, or refused with its reason. */
export const UndoChangeResult = z.object({
  itemId: z.string(),
  undo: z.discriminatedUnion("status", [
    z.object({ status: z.literal("done"), undoActionId: z.string() }),
    z.object({ status: z.literal("failed"), undoActionId: z.string(), reason: z.string() }),
    z.object({ status: z.literal("refused"), code: z.string(), reason: z.string() }),
  ]),
});
export type UndoChangeResult = z.infer<typeof UndoChangeResult>;

// DECISION (web, wave 3b): the undo specs moved from apps/api (and the web's mirror of them) into
// core's contract, as both said they would, so the API client and the contract tests read one copy.
export const undoRoutes = {
  portalUndoChange: defineRoute({
    method: "POST",
    path: "/api/inbox/:id/undo-change",
    auth: "session",
    roles: ["client_admin", "client_user"] as const,
    summary:
      "Take back a change that went ahead before a no: whoever said no, or a client admin, from the item",
    params: IdParams,
    response: UndoChangeResult,
  }),
  opsUndoChange: defineRoute({
    method: "POST",
    path: "/api/ops/inbox/:id/undo-change",
    auth: "session",
    roles: ["operator"] as const,
    summary:
      "Take back a change that went ahead before a late no: the client's lead, from its item",
    params: IdParams,
    response: UndoChangeResult,
  }),
} as const;
