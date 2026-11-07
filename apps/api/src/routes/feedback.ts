// The Feedback button (docs/plan.md §1.10): the back office always sends feedback; a client's portal
// only when the operator has switched it on for that client (`tenant.settings.feedback`, changed
// with a reason in tenant_change). The comment is saved first, the screenshot uploaded after, so a
// failed upload loses only the picture. Only operators read feedback and its screenshots.
//
// Privacy: a screenshot can show a client's data. It goes to Mezonas' own object storage under the
// client's key and nowhere else: never to Sentry (nothing here captures the body), never to a model.

import { SIGNED_URL_TTL_SECONDS } from "@countersign/connectors";
import {
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_SCREENSHOT_TYPE,
  type FeedbackItem,
  type FeedbackSubmission,
  routes,
} from "@countersign/core";
import { appUser, feedback, type Tx, tenant, tenantChange } from "@countersign/db";
import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AppContext,
  type AppEnv,
  ensureClient,
  HttpError,
  mount,
  notFound,
  type Services,
} from "../http";
import { signerFor } from "../storage";

type FeedbackRow = typeof feedback.$inferSelect;

/** The per-client switch: off unless the operator turned it on. */
export function feedbackEnabled(settings: Record<string, unknown>): boolean {
  return settings.feedback === true;
}

/**
 * Where a screenshot lives: under its client, or the operator's own prefix for back-office
 * feedback. Ids are uuids the database made, never taken from the request.
 */
// DECISION: one object per feedback item, keyed by its id (not content-addressed): a screenshot
// belongs to exactly one item and is written once.
export function screenshotKey(row: Pick<FeedbackRow, "id" | "tenantId">): string {
  return row.tenantId
    ? `tenants/${row.tenantId.toLowerCase()}/feedback/${row.id}.jpg`
    : `operator/feedback/${row.id}.jpg`;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function insertFeedback(
  tx: Tx,
  input: FeedbackSubmission & { tenantId: string | null; userId: string },
) {
  const [row] = await tx
    .insert(feedback)
    .values({
      tenantId: input.tenantId,
      surface: input.tenantId ? "portal" : "ops",
      userId: input.userId,
      comment: input.comment,
      path: input.path,
      viewport: input.viewport,
      pin: input.pin,
      target: input.target?.trim() || null,
    })
    .returning({ id: feedback.id });
  if (!row) throw new Error("feedback insert returned nothing");
  return { id: row.id };
}

/** Reads the JPEG body, refusing anything else or anything too big. */
async function readScreenshot(c: AppContext): Promise<Uint8Array> {
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== FEEDBACK_SCREENSHOT_TYPE) {
    throw new HttpError(422, "not_jpeg", "send the screenshot as image/jpeg");
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > FEEDBACK_SCREENSHOT_MAX_BYTES) {
    throw new HttpError(422, "too_large", "the screenshot is too large");
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) throw new HttpError(422, "empty", "the screenshot is empty");
  if (bytes.length > FEEDBACK_SCREENSHOT_MAX_BYTES) {
    throw new HttpError(422, "too_large", "the screenshot is too large");
  }
  if (!isJpeg(bytes)) throw new HttpError(422, "not_jpeg", "that is not a JPEG");
  return bytes;
}

/** Stores the screenshot of feedback the sender just sent, once. */
async function attachScreenshot(
  tx: Tx,
  services: Services,
  row: FeedbackRow,
  userId: string,
  bytes: Uint8Array,
) {
  // DECISION: only the sender attaches the picture, and only once: the upload follows the POST
  // that made the item, it never replaces a picture.
  if (row.userId !== userId) throw notFound("feedback");
  if (row.screenshotKey) throw new HttpError(409, "already_attached", "that has a screenshot");
  const key = screenshotKey(row);
  await services.deps
    .objects(services.env)
    .put(key, bytes, { contentType: FEEDBACK_SCREENSHOT_TYPE, onlyIfAbsent: true });
  await tx
    .update(feedback)
    .set({ screenshotKey: key, screenshotBytes: bytes.length })
    .where(eq(feedback.id, row.id));
  return { ok: true as const, bytes: bytes.length };
}

/** Back-office rows and the served clients' rows (RLS holds this too; queries say it as well). */
function inOperatorScope(tenantIds: readonly string[]): SQL {
  return tenantIds.length > 0
    ? (or(isNull(feedback.tenantId), inArray(feedback.tenantId, [...tenantIds])) as SQL)
    : isNull(feedback.tenantId);
}

async function opsRow(tx: Tx, tenantIds: readonly string[], id: string): Promise<FeedbackRow> {
  const [row] = await tx
    .select()
    .from(feedback)
    .where(and(eq(feedback.id, id), inOperatorScope(tenantIds)));
  if (!row) throw notFound("feedback");
  return row;
}

async function toItems(tx: Tx, rows: FeedbackRow[]): Promise<FeedbackItem[]> {
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.userId, r.resolvedBy]).filter((v): v is string => !!v)),
  ];
  const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((v): v is string => !!v))];
  const users =
    userIds.length > 0
      ? await tx
          .select({ id: appUser.id, email: appUser.email, name: appUser.name })
          .from(appUser)
          .where(inArray(appUser.id, userIds))
      : [];
  const clients =
    tenantIds.length > 0
      ? await tx
          .select({ id: tenant.id, name: tenant.name })
          .from(tenant)
          .where(inArray(tenant.id, tenantIds))
      : [];
  const person = (id: string | null) => {
    if (!id) return null;
    return users.find((u) => u.id === id) ?? { id, email: "", name: null };
  };
  return rows.map((r) => ({
    id: r.id,
    surface: r.surface,
    client: r.tenantId
      ? (clients.find((c) => c.id === r.tenantId) ?? { id: r.tenantId, name: "" })
      : null,
    from: person(r.userId) ?? { id: r.userId, email: "", name: null },
    comment: r.comment,
    path: r.path,
    viewport: r.viewport,
    pin: r.pin ?? null,
    target: r.target,
    hasScreenshot: r.screenshotKey !== null,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedBy: person(r.resolvedBy),
    resolutionNote: r.resolutionNote,
  }));
}

async function oneItem(tx: Tx, row: FeedbackRow): Promise<FeedbackItem> {
  const [item] = await toItems(tx, [row]);
  if (!item) throw new Error("no item");
  return item;
}

/** One feedback item in the operator's scope, and its screenshot's key (null without one). */
export async function opsFeedbackItem(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
): Promise<{ item: FeedbackItem; screenshotKey: string | null }> {
  const row = await opsRow(tx, tenantIds, id);
  return { item: await oneItem(tx, row), screenshotKey: row.screenshotKey };
}

/**
 * Resolves open feedback as `userId`, with an optional note: the back office's Resolve and the MCP
 * server's `feedback_resolve`. Only an open item changes (the update checks it again), so two
 * resolves of the same item never both succeed.
 */
export async function resolveFeedback(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
  userId: string,
  note: string | undefined,
): Promise<FeedbackItem> {
  const row = await opsRow(tx, tenantIds, id);
  if (row.status === "resolved") throw new HttpError(409, "already_resolved", "already resolved");
  const [updated] = await tx
    .update(feedback)
    .set({
      status: "resolved",
      resolvedAt: new Date(),
      resolvedBy: userId,
      resolutionNote: note?.trim() || null,
    })
    .where(and(eq(feedback.id, row.id), eq(feedback.status, "open")))
    .returning();
  if (!updated) throw new HttpError(409, "already_resolved", "already resolved");
  return oneItem(tx, updated);
}

async function clientSetting(tx: Tx, tenantId: string) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const rows = await tx
    .select({
      id: tenantChange.id,
      change: tenantChange.change,
      reason: tenantChange.reason,
      actorId: tenantChange.actorId,
      email: appUser.email,
      name: appUser.name,
      createdAt: tenantChange.createdAt,
    })
    .from(tenantChange)
    .leftJoin(appUser, eq(appUser.id, tenantChange.actorId))
    .where(eq(tenantChange.tenantId, tenantId))
    .orderBy(desc(tenantChange.createdAt), desc(tenantChange.id));
  return {
    tenant: t,
    setting: {
      enabled: feedbackEnabled(t.settings),
      changes: rows
        .filter((r) => r.change.setting === "feedback")
        .map((r) => ({
          id: r.id,
          enabled: r.change.to === true,
          reason: r.reason,
          by: r.actorId ? { id: r.actorId, email: r.email ?? "", name: r.name } : null,
          createdAt: r.createdAt.toISOString(),
        })),
    },
  };
}

async function portalEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return !!t && feedbackEnabled(t.settings);
}

const feedbackOff = () =>
  new HttpError(403, "feedback_off", "feedback is not switched on for this client");

export function feedbackRouteHandlers(app: Hono<AppEnv>): void {
  // ── Portal ─────────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.portalFeedbackStatus, async ({ tx, tenantIds }) => ({
    enabled: await portalEnabled(tx, tenantIds[0] as string),
  }));

  mount(app, routes.portalSendFeedback, async ({ tx, tenantIds, session, body }) => {
    const tenantId = tenantIds[0] as string;
    if (!(await portalEnabled(tx, tenantId))) throw feedbackOff();
    return insertFeedback(tx, { ...body, tenantId, userId: session.user.id });
  });

  mount(app, routes.portalFeedbackScreenshot, async (ctx) => {
    const { c, tx, tenantIds, session, params, services } = ctx;
    const tenantId = tenantIds[0] as string;
    if (!(await portalEnabled(tx, tenantId))) throw feedbackOff();
    const [row] = await tx
      .select()
      .from(feedback)
      .where(and(eq(feedback.id, params.id), eq(feedback.tenantId, tenantId)));
    if (!row) throw notFound("feedback");
    return attachScreenshot(tx, services, row, session.user.id, await readScreenshot(c));
  });

  // ── Back office ────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.opsSendFeedback, async ({ tx, session, body }) =>
    insertFeedback(tx, { ...body, tenantId: null, userId: session.user.id }),
  );

  mount(app, routes.opsFeedbackUploadScreenshot, async (ctx) => {
    const { c, tx, session, params, services } = ctx;
    const [row] = await tx
      .select()
      .from(feedback)
      .where(and(eq(feedback.id, params.id), isNull(feedback.tenantId)));
    if (!row) throw notFound("feedback");
    return attachScreenshot(tx, services, row, session.user.id, await readScreenshot(c));
  });

  mount(app, routes.opsFeedback, async ({ tx, tenantIds, query }) => {
    const where = [inOperatorScope(tenantIds)];
    if (query.status !== "all") where.push(eq(feedback.status, query.status));
    const rows = await tx
      .select()
      .from(feedback)
      .where(and(...where))
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(500);
    return { items: await toItems(tx, rows) };
  });

  mount(app, routes.opsFeedbackScreenshot, async ({ c, tx, tenantIds, params, services }) => {
    const row = await opsRow(tx, tenantIds, params.id);
    if (!row.screenshotKey) throw notFound("screenshot");
    const signer = signerFor(services.env, new URL(c.req.url).origin, () => "feedback.jpg");
    return {
      url: await signer.signedGetUrl(row.screenshotKey),
      expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
    };
  });

  mount(app, routes.opsResolveFeedback, async ({ tx, tenantIds, params, body, session }) => ({
    item: await resolveFeedback(tx, tenantIds, params.id, session.user.id, body.note),
  }));

  mount(app, routes.opsReopenFeedback, async ({ tx, tenantIds, params }) => {
    const row = await opsRow(tx, tenantIds, params.id);
    if (row.status === "open") throw new HttpError(409, "already_open", "already open");
    // DECISION: reopening clears the resolution (who, when, note); the item reads as new again.
    const [updated] = await tx
      .update(feedback)
      .set({ status: "open", resolvedAt: null, resolvedBy: null, resolutionNote: null })
      .where(eq(feedback.id, row.id))
      .returning();
    if (!updated) throw notFound("feedback");
    return { item: await oneItem(tx, updated) };
  });

  mount(app, routes.opsClientFeedback, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return (await clientSetting(ctx.tx, ctx.params.id)).setting;
  });

  mount(app, routes.opsSetClientFeedback, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const { tenant: t, setting } = await clientSetting(tx, params.id);
    if (setting.enabled === body.enabled) {
      throw new HttpError(409, "no_op", body.enabled ? "already on" : "already off");
    }
    await tx
      .update(tenant)
      .set({ settings: { ...t.settings, feedback: body.enabled } })
      .where(eq(tenant.id, t.id));
    await tx.insert(tenantChange).values({
      tenantId: t.id,
      actorId: session.user.id,
      change: { setting: "feedback", from: setting.enabled, to: body.enabled },
      reason:
        body.reason ||
        (body.enabled ? "Feedback button switched on" : "Feedback button switched off"),
    });
    return (await clientSetting(tx, t.id)).setting;
  });
}
