// Autopilot and the back office's email routes (docs/plan.md §1.124.4): the Autopilot screen and a
// play's level, a deal's email to its person, a reminder for what waits on a client, and asking
// Reggie to read an issue again. Operator only. Sending mail is a slow route (mountLong): no
// transaction is held while Resend answers.

import { parseCoveredProcessors, routes } from "@countersign/core";
import { deal, dealPerson, todo } from "@countersign/db";
import { leadThread, postMessage } from "@countersign/threads";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { autopilotView, setPlayLevel } from "../backoffice/autopilot";
import { dealTag, HELLO_LOCAL, sendTaggedEmail, taggedAddress } from "../backoffice/outbound-email";
import { readOne } from "../backoffice/reggie-pass";
import { clientModels } from "../compliance/models";
import {
  type AppEnv,
  HttpError,
  type LongHandlerCtx,
  mount,
  mountLong,
  notFound,
  txOnly,
} from "../http";
import { mailerFromEnv } from "../notify/mailer";
import { addActivity, dealDetail, readDeal, salesToday } from "../work/deals";
import { readIssue } from "../work/issues";
import { logPlay } from "../work/play-log";

export function autopilotRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsAutopilot, async ({ tx }) => autopilotView(tx));

  mount(app, routes.opsSetPlay, async ({ tx, params, body, session }) =>
    setPlayLevel(tx, {
      flow: params.flow,
      stage: params.stage,
      play: params.play,
      level: body.level,
      userId: session.user.id,
    }),
  );

  // A deal's email: from the operator via Mezonas, to the deal's primary person, with replies
  // threaded back to the deal by its tag (hello+d…@).
  mountLong(
    app,
    routes.opsDealEmail,
    async ({ inTx, tenantIds, params, body, session, services }) =>
      sendDealEmail({ inTx, tenantIds, session, services }, params.id, body),
  );

  // A reminder for a to-do the client owns: a message from their lead in the lead conversation.
  mount(app, routes.opsTodoRemind, async ({ tx, tenantIds, params, session }) => {
    const [row] = await tx.select().from(todo).where(eq(todo.id, params.id));
    if (!row || (row.clientId && !tenantIds.includes(row.clientId))) throw notFound("to-do");
    if (row.owner !== "client" || !row.clientId) {
      throw new HttpError(409, "not_the_clients", "only what waits on a client can be a reminder");
    }
    if (row.state !== "open" && row.state !== "snoozed") {
      throw new HttpError(409, "done", "this to-do is done");
    }
    const th = await leadThread(tx, row.clientId);
    await postMessage(tx, {
      tenantId: row.clientId,
      thread: th,
      senderType: "user",
      senderId: session.user.id,
      kind: "text",
      body: {
        text: `A reminder: ${row.title}${row.dueAt ? ` (due ${row.dueAt.toISOString().slice(0, 10)})` : ""}.`,
      },
      sources: [],
      audience: "client",
    });
    // A build's chase counts on its play's record (Autopilot, Done today).
    if (row.aboutKind === "build" && row.aboutId)
      await logPlay(tx, {
        clientId: row.clientId,
        flow: "builds",
        stage: "requirements",
        play: "chase_requirements",
        level: "send",
        outcome: "sent",
        about: { kind: "build", id: row.aboutId },
        summary: `Reminded the client: ${row.title}`,
      });
    return { ok: true as const, channel: "portal" as const };
  });

  // Reggie reads an issue again now (the pass reads new ones within a minute on its own).
  mountLong(app, routes.opsIssueRead, async ({ inTx, tenantIds, params, services }) => {
    const row = await txOnly(inTx)((tx) => readIssue(tx, tenantIds, params.id));
    // HIPAA mode (§1.35): held to the issue's client, beside readOne's own check.
    const transport = clientModels(services, { clients: [row.tenantId], read: services.db });
    const read = await readOne(
      { db: services.db, transport, covered: parseCoveredProcessors(services.env.BAA_PROCESSORS) },
      row.tenantId,
      row.id,
      {
        force: true,
      },
    );
    return { read };
  });
}

type LongArgs = LongHandlerCtx<typeof routes.opsDealEmail>;

/**
 * Sends a deal's email (`POST /api/ops/deals/:id/email`). A slow route can't be run through
 * `invokeRoute`, so Your call's "Do it" (§1.124.3) calls this directly, as the same operator.
 */
export async function sendDealEmail(
  {
    inTx,
    tenantIds,
    session,
    services,
  }: Pick<LongArgs, "inTx" | "tenantIds" | "session" | "services">,
  dealId: string,
  body: { subject: string; text: string },
) {
  const domain = services.env.EMAIL_FORWARDING_DOMAIN?.trim();
  const mailer = mailerFromEnv(services.env, services.deps.fetch?.(services.env));
  if (!mailer.isConfigured || !domain) {
    throw new HttpError(503, "email_off", "email isn't set up here yet");
  }
  const run = txOnly(inTx);
  const prepared = await run(async (tx) => {
    const row = await readDeal(tx, tenantIds, dealId, true);
    const people = await tx.select().from(dealPerson).where(eq(dealPerson.dealId, row.id));
    const to = people.find((p) => p.isPrimary && p.email) ?? people.find((p) => p.email);
    if (!to?.email)
      throw new HttpError(422, "no_email", "add the person's email to the deal first");
    let tag = row.replyTag;
    if (!tag) {
      tag = dealTag();
      await tx.update(deal).set({ replyTag: tag }).where(eq(deal.id, row.id));
    }
    return { row, to, tag };
  });
  const idempotencyKey = `deal-${prepared.row.id}-${crypto.randomUUID()}`;
  const providerId = await sendTaggedEmail(mailer, {
    to: prepared.to.email as string,
    subject: body.subject,
    text: body.text,
    from: session.user.name?.trim() || "Your Mezonas lead",
    replyTo: taggedAddress(HELLO_LOCAL, prepared.tag, domain),
    idempotencyKey,
  }).catch((error: unknown) => {
    throw new HttpError(
      502,
      "send_failed",
      error instanceof Error ? error.message : "the email didn't go",
    );
  });
  return run(async (tx) => {
    await addActivity(tx, prepared.row.id, {
      kind: "email_out",
      actor: "operator",
      userId: session.user.id,
      subject: body.subject,
      body: body.text,
      meta: { to: prepared.to.email, personId: prepared.to.id, providerId },
    });
    await tx.update(deal).set({ waitingOn: "client" }).where(eq(deal.id, prepared.row.id));
    return dealDetail(tx, await readDeal(tx, tenantIds, prepared.row.id), salesToday());
  });
}
