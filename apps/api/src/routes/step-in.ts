// P-6: the client runs it, we step in (docs/plan.md §1.68; ARCHITECTURE §4, §10.12, §11). The
// back office steps into any open item of a client it serves, and takes a live conversation over or
// ends it, always with a reason; the portal lets a conversation's approver do the same. Each route
// goes through `mount`, which writes the audit row (the client is in the path, so the row names it).

import type { Approver } from "@countersign/agents";
import { routes } from "@countersign/core";
import type { EventRow } from "@countersign/senses";
import type { Hono } from "hono";
import { controlConversation } from "../converse/control";
import { portalConversation, runConversations } from "../converse/views";
import { type AppEnv, ensureClient, iso, mount, notFound, type Services } from "../http";
import { type RunWake, sendResolution } from "../inbox";
import { dispatchEvents } from "../runs/dispatch";
import { stepIn, steppedInOf, steppingIn } from "../step-in/service";

function afterwards(
  ctx: {
    afterCommit(task: () => Promise<unknown>): void;
    defer(task: () => Promise<unknown>): void;
  },
  services: Services,
  outcome: { resume: RunWake | null; conversation: RunWake | null },
  collect: EventRow[],
) {
  // Wave 2c: the conversation's own event beside the item's, so a v4 conversation step wakes now.
  if (outcome.resume || outcome.conversation) {
    ctx.afterCommit(() => sendResolution(services.instances, outcome));
  }
  if (collect.length > 0) {
    ctx.defer(() => dispatchEvents({ db: services.db, instances: services.instances }, collect));
  }
}

export function stepInRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.opsStepInInbox, async (ctx) => {
    const { tx, params, body, session, services } = ctx;
    // Only the clients this operator serves (404 for any other, as everywhere in the back office).
    ensureClient(ctx, params.id);
    const collect: EventRow[] = [];
    const { item, ...outcome } = await stepIn(tx, {
      tenantId: params.id,
      itemId: params.itemId,
      userId: session.user.id,
      body,
      registry: services.platform.events,
      collect,
      now: new Date(),
    });
    afterwards(ctx, services, outcome, collect);
    return {
      item: {
        id: item.id,
        status: item.status,
        assigneeRole: item.assigneeRole,
        assigneeUserId: item.assigneeUserId,
        resolvedAt: iso(item.resolvedAt),
        deliverAfter: iso(item.deliverAfter),
        steppedIn: steppedInOf(item),
      },
    };
  });

  mount(app, routes.opsConversationControl, async (ctx) => {
    const { tx, params, body, session, services } = ctx;
    ensureClient(ctx, params.id);
    const collect: EventRow[] = [];
    const outcome = await controlConversation(tx, {
      tenantId: params.id,
      runId: params.runId,
      stepRunId: params.stepRunId,
      action: body.action,
      by: steppingIn(session.user.id),
      reason: body.reason,
      registry: services.platform.events,
      collect,
      now: new Date(),
    });
    afterwards(ctx, services, outcome, collect);
    const view = (await runConversations(tx, params.id, params.runId)).get(params.stepRunId);
    if (!view) throw notFound("conversation");
    return { conversation: view };
  });

  mount(app, routes.portalConversationControl, async (ctx) => {
    const { tx, params, body, session, services, role, tenantIds } = ctx;
    const tenantId = tenantIds[0] as string;
    const by: Approver = { userId: session.user.id, role: role as Approver["role"] };
    const collect: EventRow[] = [];
    const outcome = await controlConversation(tx, {
      tenantId,
      runId: params.id,
      stepRunId: params.stepRunId,
      action: body.action,
      by,
      reason: body.reason ?? null,
      registry: services.platform.events,
      collect,
      now: new Date(),
    });
    afterwards(ctx, services, outcome, collect);
    const view = (await runConversations(tx, tenantId, params.id)).get(params.stepRunId);
    if (!view) throw notFound("conversation");
    return { conversation: portalConversation(view) };
  });
}
