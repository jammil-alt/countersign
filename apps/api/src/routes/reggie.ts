// Reggie's routes (docs/plan.md §1.101): the operator's conversations, a turn, and confirming or
// cancelling a proposed change. Turns and decisions are slow routes (mountLong): the model and the
// back-office routes Reggie runs each open their own short transactions.

import { type RouteSpec, routes } from "@countersign/core";
import type { LlmTransport } from "@countersign/llm";
import type { Hono } from "hono";
import { clientModels } from "../compliance/models";
import { type AppEnv, ensureClient, type HandlerCtx, mount, mountLong, txOnly } from "../http";
import {
  cancelAction,
  confirmAction,
  conversationOut,
  listConversations,
  ownConversation,
  runTurn,
  startConversation,
} from "../reggie/reggie";

/**
 * Reggie's model transport, held to the HIPAA mode (§1.35) of every client the operator serves
 * and the conversation's own client. The model runs outside any transaction, so the database
 * reads it.
 */
// DECISION: every client served, even in a conversation about one client, and whatever client
// the request names (`?client=`, `x-countersign-client`): Reggie's tools read any client the
// operator serves, so any of them may reach the model in a turn's tool results.
function transport(
  ctx: Pick<HandlerCtx<RouteSpec>, "services" | "session">,
  conversationClient: string | null,
): LlmTransport {
  return clientModels(ctx.services, {
    clients: [...ctx.session.servedTenantIds, conversationClient],
    read: ctx.services.db,
  });
}

export function reggieRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsReggieConversations, async (ctx) => ({
    items: await listConversations(ctx.tx, ctx.session.user.id),
  }));

  mount(app, routes.opsReggieConversationStart, async (ctx) => {
    const clientId = ctx.body.clientId ?? null;
    if (clientId) ensureClient(ctx, clientId);
    const row = await startConversation(ctx.tx, ctx.session.user.id, clientId);
    return conversationOut(ctx.tx, row);
  });

  mount(app, routes.opsReggieConversation, async (ctx) =>
    conversationOut(ctx.tx, await ownConversation(ctx.tx, ctx.session.user.id, ctx.params.id)),
  );

  mountLong(app, routes.opsReggieTurn, async (ctx) => {
    const inTx = txOnly(ctx.inTx);
    const conversation = await inTx((tx) =>
      ownConversation(tx, ctx.session.user.id, ctx.params.id),
    );
    await runTurn(
      {
        app,
        c: ctx.c,
        session: ctx.session,
        transport: transport(ctx, conversation.clientId),
        inTx,
        now: () => new Date(),
      },
      ctx.params.id,
      ctx.body.text,
    );
    return inTx(async (tx) =>
      conversationOut(tx, await ownConversation(tx, ctx.session.user.id, ctx.params.id)),
    );
  });

  mountLong(app, routes.opsReggieActionConfirm, async (ctx) => ({
    action: await confirmAction(
      { app, c: ctx.c, session: ctx.session, inTx: txOnly(ctx.inTx), now: () => new Date() },
      ctx.params.id,
    ),
  }));

  mountLong(app, routes.opsReggieActionCancel, async (ctx) => ({
    action: await cancelAction(
      { app, c: ctx.c, session: ctx.session, inTx: txOnly(ctx.inTx), now: () => new Date() },
      ctx.params.id,
    ),
  }));
}
