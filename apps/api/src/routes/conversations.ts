// v0.14 capture: WhatsApp conversations and their capture (ARCHITECTURE §6.12, §14; docs/plan.md
// §1.55). The operator sets everything for the clients it serves, with a reason; the client admin
// turns keeping messages and downloading attachments on or off. Either may "download now" one
// message's attachments when the setting allows them. Every change is a `conversation_change` row
// (the default's a `tenant_change` row). Client users have no access.

import { mediaSidOf, TWILIO_MESSAGE_ENTITY } from "@countersign/connectors";
import {
  type ConversationCapture,
  type ConversationView,
  captureAllows,
  type PortalConversationView,
  type RouteSpec,
  routes,
} from "@countersign/core";
import { contact, rawRecord, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type ConversationRow,
  clientDefaultCapture,
  conversationChanges,
  conversationMessages,
  conversationViews,
  getConversation,
  mediaOutcomes,
  setConversationCapture,
  setDefaultCapture,
  storedCaptureOf,
  storedMediaOf,
} from "../conversations/capture";
import { retryable } from "../conversations/media";
import { captureDepsFor, captureJobsFor } from "../conversations/start";
import { type AppEnv, ensureClient, type HandlerCtx, HttpError, mount, notFound } from "../http";

function portalView(v: ConversationView): PortalConversationView {
  const { agentName: _agentName, capture, ...rest } = v;
  return {
    ...rest,
    capture: {
      archive: capture.archive,
      attachments: capture.attachments,
      maxBytes: capture.maxBytes,
    },
  };
}

async function oneView(tx: Tx, tenantId: string, id: string): Promise<ConversationView> {
  const [v] = await conversationViews(tx, tenantId, id);
  if (!v) throw notFound("conversation");
  return v;
}

/** The message is this conversation's: named by its capture facts, or (older) by its sender. */
async function messageOf(tx: Tx, tenantId: string, conv: ConversationRow, rawRecordId: string) {
  const [raw] = await tx
    .select()
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.id, rawRecordId),
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, conv.connectionId),
        eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
      ),
    );
  if (!raw) throw notFound("message");
  const stored = storedCaptureOf(raw.payload);
  if (stored) {
    if (stored.conversationId !== conv.id) throw notFound("message");
    return raw;
  }
  // DECISION (plan §1.55): a message from before v0.14 is the conversation's when it came in on
  // WhatsApp from the conversation's contact.
  const p = raw.payload as { direction?: unknown; channel?: unknown; from?: unknown };
  const [c] = conv.contactId
    ? await tx
        .select({ whatsapp: contact.whatsapp })
        .from(contact)
        .where(and(eq(contact.id, conv.contactId), eq(contact.tenantId, tenantId)))
    : [];
  if (p.direction !== "in" || p.channel !== "whatsapp" || !c?.whatsapp || p.from !== c.whatsapp) {
    throw notFound("message");
  }
  return raw;
}

/** "Download now": starts the job for the attachments the setting allows now. */
async function downloadNow(
  ctx: Pick<HandlerCtx<RouteSpec>, "tx" | "services" | "defer">,
  tenantId: string,
  conversationId: string,
  rawRecordId: string,
) {
  const conv = await getConversation(ctx.tx, tenantId, conversationId);
  const raw = await messageOf(ctx.tx, tenantId, conv, rawRecordId);
  const media = storedMediaOf(raw.payload, mediaSidOf);
  const capture = conv.capture as ConversationCapture;
  const outcomes = await mediaOutcomes(ctx.tx, tenantId, conv.connectionId, [raw.externalId]);
  const started: number[] = [];
  const done: number[] = [];
  for (const m of media) {
    const o = outcomes.get(`${raw.externalId}:${m.index}`)?.outcome;
    if (o && !retryable(o)) done.push(m.index);
    else if (captureAllows(capture, m.contentType)) started.push(m.index);
  }
  if (started.length === 0 && done.length === 0) {
    throw new HttpError(
      409,
      "capture_off",
      "this conversation doesn't download these attachments; turn it on first",
    );
  }
  if (started.length > 0) {
    const { services } = ctx;
    ctx.defer(async () => {
      const deps = captureDepsFor({
        db: services.db,
        env: services.env,
        deps: services.deps,
        platform: services.platform,
      });
      await captureJobsFor(services.env, deps).start({
        tenantId,
        connectionId: conv.connectionId,
        rawRecordId: raw.id,
        messageSid: raw.externalId,
        indexes: started,
        reason: "download_now",
        conversationId: conv.id,
      });
    });
  }
  return { started, done };
}

export function conversationRouteHandlers(app: Hono<AppEnv>): void {
  // ── Back office ──
  mount(app, routes.opsConversations, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return {
      items: await conversationViews(ctx.tx, ctx.params.id),
      default: await clientDefaultCapture(ctx.tx, ctx.params.id),
    };
  });
  mount(app, routes.opsCaptureDefault, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { capture: await clientDefaultCapture(ctx.tx, ctx.params.id) };
  });
  mount(app, routes.opsSetCaptureDefault, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const capture = await setDefaultCapture(ctx.tx, {
      tenantId: ctx.params.id,
      capture: ctx.body.capture,
      actorId: ctx.session.user.id,
      reason: ctx.body.reason,
    });
    return { capture };
  });
  mount(app, routes.opsSetCapture, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const row = await setConversationCapture(ctx.tx, {
      tenantId: ctx.params.id,
      conversationId: ctx.params.conversationId,
      next: ctx.body.capture,
      expectedUpdatedAt: ctx.body.updatedAt,
      actorId: ctx.session.user.id,
      side: "operator",
      reason: ctx.body.reason,
    });
    return { conversation: await oneView(ctx.tx, ctx.params.id, row.id) };
  });
  mount(app, routes.opsConversationChanges, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    await getConversation(ctx.tx, ctx.params.id, ctx.params.conversationId);
    return {
      items: await conversationChanges(ctx.tx, ctx.params.id, ctx.params.conversationId, "ops"),
    };
  });
  mount(app, routes.opsConversationMessages, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const conv = await getConversation(ctx.tx, ctx.params.id, ctx.params.conversationId);
    return { items: await conversationMessages(ctx.tx, ctx.params.id, conv, mediaSidOf) };
  });
  mount(app, routes.opsDownloadNow, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return downloadNow(ctx, ctx.params.id, ctx.params.conversationId, ctx.params.rawRecordId);
  });

  // ── Portal (client admin) ──
  mount(app, routes.portalConversations, async (ctx) => ({
    items: (await conversationViews(ctx.tx, ctx.tenantIds[0] as string)).map(portalView),
  }));
  mount(app, routes.portalSetCapture, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const conv = await getConversation(ctx.tx, tenantId, ctx.params.id);
    const current = conv.capture as ConversationCapture;
    // The client admin changes the two switches; the limit and the agent stay as the operator set.
    const next: ConversationCapture = {
      ...current,
      ...(ctx.body.archive === undefined ? {} : { archive: ctx.body.archive }),
      ...(ctx.body.attachments === undefined ? {} : { attachments: ctx.body.attachments }),
    };
    const row = await setConversationCapture(ctx.tx, {
      tenantId,
      conversationId: conv.id,
      next,
      expectedUpdatedAt: ctx.body.updatedAt,
      actorId: ctx.session.user.id,
      side: "client",
    });
    return { conversation: portalView(await oneView(ctx.tx, tenantId, row.id)) };
  });
  mount(app, routes.portalConversationChanges, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    await getConversation(ctx.tx, tenantId, ctx.params.id);
    return { items: await conversationChanges(ctx.tx, tenantId, ctx.params.id, "portal") };
  });
  mount(app, routes.portalConversationMessages, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const conv = await getConversation(ctx.tx, tenantId, ctx.params.id);
    return { items: await conversationMessages(ctx.tx, tenantId, conv, mediaSidOf) };
  });
  mount(app, routes.portalDownloadNow, async (ctx) =>
    downloadNow(ctx, ctx.tenantIds[0] as string, ctx.params.id, ctx.params.rawRecordId),
  );
}
