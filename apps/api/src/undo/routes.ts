// R5 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Undo"): the Undo a late no is offered. The
// person who said no (in the portal) or the client's lead (in the back office) presses it on the
// item; their press approves the undo, which packages/agents runs as a write of its own through
// the external-action path (`undoAction`: re-reads the record, `processes.canUndo` against the
// saved before and after states, its own key, never a delete, never for a test run). A refusal
// comes back with its plain reason and leaves the offer open; nothing is ever applied by itself.
//
// Not the Desk's undo (`/api/inbox/:id/undo`, inside the window before a write runs): this one
// takes back a write that already ran.

import { type Approver, undoAction } from "@countersign/agents";
import { defineRoute, isUuid } from "@countersign/core";
import { inboxItem, type Tx } from "@countersign/db";
import { leadOf } from "@countersign/threads";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { auditInTx } from "../audit";
import { type AppEnv, HttpError, mount, notFound, type Services } from "../http";
import { withCanSign } from "../inbox";
import { operatorApprovers } from "../routes/ops-clients";
import { portalInboxFilter } from "../routes/portal";
import { forClient, runDepsFromEnv, runtimeFor } from "../runs/execute";
import { type UndoOffer, undoOfferOf } from "./offer";

const IdParams = z.object({ id: z.string().refine((v) => isUuid(v), "not an id") });

export const UndoChangeResult = z.object({
  itemId: z.string(),
  undo: z.discriminatedUnion("status", [
    z.object({ status: z.literal("done"), undoActionId: z.string() }),
    z.object({ status: z.literal("failed"), undoActionId: z.string(), reason: z.string() }),
    z.object({ status: z.literal("refused"), code: z.string(), reason: z.string() }),
  ]),
});
export type UndoChangeResult = z.infer<typeof UndoChangeResult>;

// DECISION: the specs live here until they move into core's route contract (packages/core/src/api,
// with `routes`), so the web client and the contract tests see them; undo.test.ts runs the
// contract's checks on them meanwhile.
export const undoRoutes = {
  portalUndoChange: defineRoute({
    method: "POST",
    path: "/api/inbox/:id/undo-change",
    auth: "session",
    roles: ["client_admin", "client_user"] as const,
    summary:
      "Take back a change that went ahead before your no: offered on the item to whoever said no",
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

const PORTAL_FAILED = "we couldn't put the change back; your Mezonas lead will look at it";

/**
 * Who may press: the person who said no, if they still sign for the client, or the client's lead
 * as it is now (an operator); in the Sandbox, the operator.
 */
async function mayPress(tx: Tx, tenantId: string, offer: UndoOffer, by: Approver) {
  if (by.canSign === false) return false;
  if (by.role === "operator" && by.sandbox === true) return true;
  if (offer.for.includes(by.userId)) return true;
  return offer.lead && by.role === "operator" && (await leadOf(tx, tenantId))?.userId === by.userId;
}

async function pressUndo(
  ctx: { tx: Tx; services: Services },
  item: typeof inboxItem.$inferSelect,
  who: Approver,
  side: "portal" | "ops",
): Promise<UndoChangeResult> {
  const { tx, services } = ctx;
  const tenantId = item.tenantId;
  const offer = undoOfferOf(item.payload);
  if (!offer) throw new HttpError(409, "no_undo", "there's no undo offered on this item");
  const by = await withCanSign(tx, tenantId, who);
  if (!(await mayPress(tx, tenantId, offer, by))) {
    throw new HttpError(
      403,
      "not_yours",
      "only the person who said no, or the lead, can undo this",
    );
  }
  const runtime = runtimeFor(
    forClient(
      runDepsFromEnv(services.env, {
        db: services.db,
        platform: services.platform,
        instances: services.instances,
      }),
      tenantId,
    ),
  );
  const out = await undoAction(runtime, { tenantId, actionId: offer.actionId, by: by.userId });
  const audit = (outcome: "ok" | "refused" | "error", extra: Record<string, string>) =>
    auditInTx(tx, null, {
      tenantId,
      actorKind: "user",
      actorUserId: by.userId,
      actorRole: by.role,
      action: "external_action.undo",
      outcome,
      target: { item: item.id, action: offer.actionId, ...extra },
    });
  if (out.status === "refused") {
    await audit("refused", { code: out.code });
    return { itemId: item.id, undo: { status: "refused", code: out.code, reason: out.reason } };
  }
  // Every item carrying this offer (the person's and the lead's) shows what came of it.
  const patch: Partial<UndoOffer> = {
    status: out.status,
    undoActionId: out.undo.id,
    by: by.userId,
    at: new Date().toISOString(),
    ...(out.status === "failed" ? { reason: out.error } : {}),
  };
  await tx
    .update(inboxItem)
    .set({
      payload: sql`jsonb_set(${inboxItem.payload}, '{undo}', (${inboxItem.payload}->'undo') || ${JSON.stringify(patch)}::jsonb)`,
    })
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        sql`${inboxItem.payload}->'undo'->>'actionId' = ${offer.actionId}`,
      ),
    );
  await audit(out.status === "done" ? "ok" : "error", { undoAction: out.undo.id });
  return {
    itemId: item.id,
    undo:
      out.status === "done"
        ? { status: "done", undoActionId: out.undo.id }
        : {
            status: "failed",
            undoActionId: out.undo.id,
            // The connector's own words stay in the back office (and on the action's row).
            reason: side === "ops" ? out.error : PORTAL_FAILED,
          },
  };
}

export function undoRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, undoRoutes.portalUndoChange, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    // Only an item the portal's inbox shows this person, in their one client (invariant 1).
    const [item] = await ctx.tx
      .select()
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.id, ctx.params.id),
          eq(inboxItem.tenantId, tenantId),
          portalInboxFilter(ctx.role, ctx.session.user.id),
        ),
      );
    if (!item) throw notFound("inbox item");
    const who: Approver = {
      userId: ctx.session.user.id,
      role: ctx.role as Approver["role"],
    };
    return pressUndo(ctx, item, who, "portal");
  });

  mount(app, undoRoutes.opsUndoChange, async (ctx) => {
    // Only an item of a client this operator serves.
    const [item] = await ctx.tx
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.id, ctx.params.id), inArray(inboxItem.tenantId, [...ctx.tenantIds])));
    if (!item) throw notFound("inbox item");
    const who = (await operatorApprovers(ctx.tx, ctx.session.user.id, [item.tenantId]))(
      item.tenantId,
    );
    return pressUndo(ctx, item, who, "ops");
  });
}
