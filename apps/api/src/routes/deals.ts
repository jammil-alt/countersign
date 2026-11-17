// Sales (docs/plan.md §1.123.2; docs/cases-plan.md S1–S2): the operator's deals for new accounts
// and expansion. Every route is the operator's (`/api/ops`), in a transaction scoped to the clients
// the operator serves; a deal for a lead names no client. Set-up, which creates the client and
// its builds, is in ../work/deal-setup.ts.

import { SIGNED_URL_TTL_SECONDS } from "@countersign/connectors";
import {
  DEAL_CHECK_BACK_DAYS,
  DEAL_OUTCOME_WORDS,
  DEAL_SIGNED_COPY_MAX_BYTES,
  DEAL_SIGNED_COPY_TYPE,
  type DealKind,
  type DealStage,
  dealCheckBackOn,
  dealStageOf,
  firstDealStage,
  isDealStage,
  lastDealStage,
  routes,
  salesFigures,
  salesPipeOf,
  shortDay,
  toNumeric,
  wholeMoney,
} from "@countersign/core";
import { deal, dealPerson, type Tx } from "@countersign/db";
import { and, asc, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppContext, type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { signerFor } from "../storage";
import { dealSetupRoutes } from "../work/deal-setup";
import {
  addActivity,
  addCheckBack,
  type DealRow,
  dealDetail,
  inSalesScope,
  makePrimary,
  readDeal,
  salesToday,
  summariesOf,
} from "../work/deals";

/** Closed deals stay on the lists (the Done filter, this month's wins) for this long. */
const CLOSED_SHOWN_DAYS = 90;

function refuseClosed(row: DealRow): void {
  if (row.outcome !== "open") {
    throw new HttpError(
      409,
      "deal_closed",
      `this deal is ${DEAL_OUTCOME_WORDS[row.outcome as "won"]}`,
    );
  }
}

function stageOrRefuse(kind: DealKind, stage: string): DealStage {
  if (!isDealStage(kind, stage)) {
    throw new HttpError(422, "wrong_stage", `${stage} is not a stage of a ${kind} deal`);
  }
  return stage;
}

/** Where the signed copy lives: the operator's own prefix, one object per upload. */
export function signedCopyKey(dealId: string, at: Date): string {
  return `operator/deals/${dealId}/signed-${at.getTime()}.pdf`;
}

const isPdf = (b: Uint8Array) =>
  b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;

/** Reads the PDF body, refusing anything else or anything too big. */
async function readPdf(c: AppContext): Promise<Uint8Array> {
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== DEAL_SIGNED_COPY_TYPE) {
    throw new HttpError(422, "not_pdf", "send the signed copy as application/pdf");
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > DEAL_SIGNED_COPY_MAX_BYTES) {
    throw new HttpError(422, "too_large", "the signed copy is larger than 10 MB");
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) throw new HttpError(422, "empty", "the signed copy is empty");
  if (bytes.length > DEAL_SIGNED_COPY_MAX_BYTES) {
    throw new HttpError(422, "too_large", "the signed copy is larger than 10 MB");
  }
  if (!isPdf(bytes)) throw new HttpError(422, "not_pdf", "that is not a PDF");
  return bytes;
}

/** A stage move: the row, its time and the line on the timeline. Reaching the last stage wins it. */
async function moveStage(
  tx: Tx,
  row: DealRow,
  to: DealStage,
  userId: string,
  reason: string | undefined,
): Promise<Partial<typeof deal.$inferInsert>> {
  const kind = row.kind as DealKind;
  const from = dealStageOf(kind, row.stage as DealStage);
  const next = dealStageOf(kind, to);
  await addActivity(tx, row.id, {
    kind: "stage",
    actor: "operator",
    userId,
    body: `Moved from ${from.name} to ${next.name}.${reason ? ` ${reason}` : ""}`,
    meta: { from: from.id, to: next.id },
  });
  // DECISION: the last stage (first agent live, live and billed) is the win: the deal is won there,
  // so the board's last column and the Done filter agree without a second step.
  const now = new Date();
  return {
    stage: to,
    stageAt: now,
    ...(to === lastDealStage(kind) ? { outcome: "won" as const, wonAt: now, closedAt: now } : {}),
  };
}

export function dealRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsDeals, async ({ tx, tenantIds, query }) => {
    const today = salesToday();
    const since = new Date(Date.now() - CLOSED_SHOWN_DAYS * 86_400_000);
    const where = [
      inSalesScope(tenantIds),
      or(eq(deal.outcome, "open"), and(isNotNull(deal.closedAt), gte(deal.closedAt, since))),
    ];
    if (query.tab !== "all") where.push(eq(deal.kind, query.tab === "new" ? "new" : "expansion"));
    if (query.client) {
      ensureClient({ tenantIds }, query.client);
      where.push(eq(deal.clientId, query.client));
    }
    const rows = await tx
      .select()
      .from(deal)
      .where(and(...where))
      .orderBy(sql`${deal.nextDueOn} asc nulls last`, asc(deal.createdAt))
      .limit(1000);
    const deals = await summariesOf(tx, rows, today);
    return {
      deals,
      kpis: salesFigures(
        deals.map((d) => ({ ...d, agreedMrr: d.agreedMrr })),
        today,
      ),
      today,
    };
  });

  mount(app, routes.opsCreateDeal, async ({ tx, tenantIds, body, session }) => {
    const kind = body.kind;
    if (body.clientId) ensureClient({ tenantIds }, body.clientId);
    if (kind === "expansion" && !body.clientId) {
      throw new HttpError(422, "client_required", "an expansion deal is for a client");
    }
    if (!body.clientId && !body.company) {
      throw new HttpError(422, "company_required", "name the company or the client");
    }
    const stage = stageOrRefuse(kind, body.stage ?? firstDealStage(kind));
    if (stage === lastDealStage(kind)) {
      throw new HttpError(422, "wrong_stage", "a new deal starts before its last stage");
    }
    const agentsSold = body.agentsSold ?? [];
    const [row] = await tx
      .insert(deal)
      .values({
        kind,
        clientId: body.clientId ?? null,
        company: body.company ?? null,
        title: body.title,
        description: body.description ?? "",
        stage,
        agentCount: body.agentCount ?? agentsSold.length,
        agentsSold,
        mrr: toNumeric(body.mrr),
        currency: body.currency ?? "USD",
        source: body.source ?? "ops",
        sourceDetail: body.sourceDetail ?? null,
        nextStep: body.nextStep ?? "",
        nextDueOn: body.nextDueOn ?? null,
        originKind: body.origin?.kind ?? null,
        originId: body.origin?.id ?? null,
        createdBy: session.user.id,
      })
      .returning();
    if (!row) throw new Error("deal insert returned nothing");
    const people = body.people ?? [];
    const primary = Math.max(
      0,
      people.findIndex((p) => p.isPrimary),
    );
    if (people.length > 0) {
      await tx.insert(dealPerson).values(
        people.map((p, i) => ({
          dealId: row.id,
          name: p.name,
          email: p.email ?? null,
          phone: p.phone ?? null,
          role: p.role ?? null,
          isPrimary: i === primary,
        })),
      );
    }
    await addActivity(tx, row.id, {
      kind: "system",
      actor: "operator",
      userId: session.user.id,
      body: body.origin
        ? `Opened from ${body.origin.kind === "enhancement" ? "an enhancement" : `the ${body.origin.kind}`}.`
        : "Opened the deal.",
      meta: body.origin ? { origin: body.origin } : {},
    });
    return dealDetail(tx, row, salesToday());
  });

  mount(app, routes.opsDeal, async ({ tx, tenantIds, params }) =>
    dealDetail(tx, await readDeal(tx, tenantIds, params.id), salesToday()),
  );

  mount(app, routes.opsUpdateDeal, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readDeal(tx, tenantIds, params.id, true);
    refuseClosed(row);
    const kind = row.kind as DealKind;
    const set: Partial<typeof deal.$inferInsert> = {};
    if (body.title !== undefined) set.title = body.title;
    if (body.description !== undefined) set.description = body.description;
    if (body.company !== undefined) set.company = body.company;
    if (body.agentCount !== undefined) set.agentCount = body.agentCount;
    if (body.agentsSold !== undefined) {
      set.agentsSold = body.agentsSold;
      if (body.agentCount === undefined) set.agentCount = body.agentsSold.length;
    }
    if (body.mrr !== undefined) set.mrr = toNumeric(body.mrr);
    if (body.currency !== undefined) set.currency = body.currency;
    if (body.waitingOn !== undefined) set.waitingOn = body.waitingOn;
    if (body.statusLine !== undefined) set.statusLine = body.statusLine;
    if (body.stuck !== undefined) set.stuck = body.stuck;
    if (body.nextStep !== undefined) set.nextStep = body.nextStep;
    if (body.nextDueOn !== undefined) set.nextDueOn = body.nextDueOn;
    if (body.sourceDetail !== undefined) set.sourceDetail = body.sourceDetail;
    if (body.stage !== undefined && body.stage !== row.stage) {
      Object.assign(
        set,
        await moveStage(tx, row, stageOrRefuse(kind, body.stage), session.user.id, body.reason),
      );
    }
    if (Object.keys(set).length > 0) {
      await tx.update(deal).set(set).where(eq(deal.id, row.id));
    }
    return dealDetail(tx, await readDeal(tx, tenantIds, row.id), salesToday());
  });

  mount(app, routes.opsDealActivity, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readDeal(tx, tenantIds, params.id);
    await addActivity(tx, row.id, {
      kind: body.kind,
      actor: "operator",
      userId: session.user.id,
      subject: body.subject ?? null,
      body: body.body,
    });
    await tx.update(deal).set({ updatedAt: new Date() }).where(eq(deal.id, row.id));
    return dealDetail(tx, row, salesToday());
  });

  mount(app, routes.opsAddDealPerson, async ({ tx, tenantIds, params, body }) => {
    const row = await readDeal(tx, tenantIds, params.id);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(dealPerson)
      .where(eq(dealPerson.dealId, row.id));
    const [person] = await tx
      .insert(dealPerson)
      .values({
        dealId: row.id,
        name: body.name,
        email: body.email ?? null,
        phone: body.phone ?? null,
        role: body.role ?? null,
        isPrimary: false,
      })
      .returning({ id: dealPerson.id });
    if (!person) throw new Error("person insert returned nothing");
    // The first person on a deal is its primary one, unless the operator names another.
    if (body.isPrimary || n === 0) await makePrimary(tx, row.id, person.id);
    return dealDetail(tx, row, salesToday());
  });

  mount(app, routes.opsUpdateDealPerson, async ({ tx, tenantIds, params, body }) => {
    const row = await readDeal(tx, tenantIds, params.id);
    const [person] = await tx
      .select()
      .from(dealPerson)
      .where(and(eq(dealPerson.id, params.personId), eq(dealPerson.dealId, row.id)));
    if (!person) throw notFound("person");
    const set: Partial<typeof dealPerson.$inferInsert> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.email !== undefined) set.email = body.email;
    if (body.phone !== undefined) set.phone = body.phone;
    if (body.role !== undefined) set.role = body.role;
    if (Object.keys(set).length > 0) {
      await tx.update(dealPerson).set(set).where(eq(dealPerson.id, person.id));
    }
    if (body.isPrimary) await makePrimary(tx, row.id, person.id);
    return dealDetail(tx, row, salesToday());
  });

  // Contracts stay by hand (owner, 2026-11-17): the operator records what was agreed and attaches
  // the signed copy; nothing is posted to the client.
  mount(app, routes.opsDealTerms, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readDeal(tx, tenantIds, params.id, true);
    refuseClosed(row);
    const currency = body.currency ?? row.currency;
    const agreed = toNumeric(body.agreedMrr);
    await tx
      .update(deal)
      .set({ agreedMrr: agreed, agreedFrom: body.from, currency })
      .where(eq(deal.id, row.id));
    await addActivity(tx, row.id, {
      kind: "terms",
      actor: "operator",
      userId: session.user.id,
      body: `Recorded the agreed terms: ${wholeMoney(agreed, currency)} a month from ${shortDay(body.from)}.${body.note ? ` ${body.note}` : ""}`,
      meta: { agreedMrr: agreed, currency, from: body.from },
    });
    return dealDetail(tx, await readDeal(tx, tenantIds, row.id), salesToday());
  });

  mount(app, routes.opsDealUploadSignedCopy, async (ctx) => {
    const { c, tx, tenantIds, params, query, services, session } = ctx;
    const row = await readDeal(tx, tenantIds, params.id, true);
    const bytes = await readPdf(c);
    // DECISION: a new upload is a new object (keyed by time), never written over: the earlier
    // copy stays in storage and on the timeline; the deal points at the latest.
    const key = signedCopyKey(row.id, new Date());
    await services.deps
      .objects(services.env)
      .put(key, bytes, { contentType: DEAL_SIGNED_COPY_TYPE, onlyIfAbsent: true });
    const name = query.name ?? "Signed copy.pdf";
    await tx
      .update(deal)
      .set({ signedCopyKey: key, signedCopyName: name })
      .where(eq(deal.id, row.id));
    await addActivity(tx, row.id, {
      kind: "terms",
      actor: "operator",
      userId: session.user.id,
      body: `Attached the signed copy: ${name}.`,
      meta: { signedCopyKey: key, bytes: bytes.length },
    });
    return { ok: true as const, bytes: bytes.length };
  });

  mount(app, routes.opsDealSignedCopy, async ({ c, tx, tenantIds, params, services }) => {
    const row = await readDeal(tx, tenantIds, params.id);
    if (!row.signedCopyKey) throw notFound("signed copy");
    const name = row.signedCopyName ?? "Signed copy.pdf";
    const signer = signerFor(services.env, new URL(c.req.url).origin, () => name);
    return {
      url: await signer.signedGetUrl(row.signedCopyKey),
      expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
    };
  });

  mount(app, routes.opsDealOutcome, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readDeal(tx, tenantIds, params.id, true);
    refuseClosed(row);
    if (body.outcome === "no" && !body.reason) {
      throw new HttpError(422, "reason_required", "say why they said no");
    }
    const now = new Date();
    const days = DEAL_CHECK_BACK_DAYS[body.outcome];
    const checkBackOn = days ? dealCheckBackOn(salesToday(now), days) : null;
    await tx
      .update(deal)
      .set({
        outcome: body.outcome,
        outcomeReason: body.reason ?? null,
        closedAt: now,
        checkBackOn,
        ...(body.outcome === "won" ? { wonAt: now } : {}),
      })
      .where(eq(deal.id, row.id));
    await addActivity(tx, row.id, {
      kind: "stage",
      actor: "operator",
      userId: session.user.id,
      body: `${DEAL_OUTCOME_WORDS[body.outcome]}.${body.reason ? ` ${body.reason}` : ""}${checkBackOn ? ` Reggie checks back ${shortDay(checkBackOn)}.` : ""}`,
      meta: { outcome: body.outcome, pipe: salesPipeOf(row.kind as DealKind) },
    });
    const closed = await readDeal(tx, tenantIds, row.id);
    if (checkBackOn) await addCheckBack(tx, closed, checkBackOn, session.user.id);
    return dealDetail(tx, closed, salesToday());
  });

  dealSetupRoutes(app);
}
