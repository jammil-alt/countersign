import { defineRoute, isUuid, routes } from "@countersign/core";
import { z } from "zod";

/** The API's route contract (packages/core): the same specs apps/api mounts. */
export const apiRoutes = routes;
export type ApiRoutes = typeof apiRoutes;

export type { AgentSummary, VersionDetail, VersionSummary } from "@countersign/core";

// ── R5 undo (docs/plan.md §1.86; ARCHITECTURE §10.14 "Undo") ────────────────────────────────────

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

/**
 * The Undo a late no is offered (apps/api/src/undo/routes.ts `undoRoutes`): the portal's for the
 * person who said no or a client admin, the back office's for the client's lead.
 */
// DECISION: the specs are mirrored here, as the API client's header allows, until apps/api moves
// them into core's route contract (its own DECISION); apps/api's copy is the one mounted. Paths,
// methods and the response shape are the same, so moving them changes no call here.
export const undoChangeRoutes = {
  portalUndoChange: defineRoute({
    method: "POST",
    path: "/api/inbox/:id/undo-change",
    auth: "session",
    roles: ["client_admin", "client_user"] as const,
    summary: "Take back a change that went ahead before a no",
    params: IdParams,
    response: UndoChangeResult,
  }),
  opsUndoChange: defineRoute({
    method: "POST",
    path: "/api/ops/inbox/:id/undo-change",
    auth: "session",
    roles: ["operator"] as const,
    summary: "Take back a change that went ahead before a late no: the client's lead",
    params: IdParams,
    response: UndoChangeResult,
  }),
} as const;
