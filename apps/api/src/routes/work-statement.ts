// docs/plan.md §1.234 (Y5): the work statement's routes. The portal's `GET /api/billing/work`
// and its PDF (the client admin, one client), and the back office's
// `GET /api/ops/billing/clients/:id/work` and its PDF (a client the operator serves, read in that
// one client's scope). Every one answers `workStatement`, so the portal, the PDF, the email with
// the invoice and the back office show the same numbers. The portal's answer carries no cost,
// bundle, instructions or prompts (invariant 11).

import { type Locale, type WorkStatement, workStatementRoutes } from "@countersign/core";
import { narrowToTenant, type Tx, tenant } from "@countersign/db";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  lastMonth,
  type PackCatalog,
  pdfFormatOf,
  workPdfName,
  workStatement,
  workStatementPdf,
} from "../billing/work-statement";
import { type AppEnv, ensureClient, HttpError, mount, mountFile, notFound } from "../http";
import { readerLocale } from "../kpi/view";

/** The month asked for, else last month; never one that hasn't started. */
function monthOf(query: { month?: string | undefined }, now: Date): string {
  const month = query.month ?? lastMonth(now);
  if (month > now.toISOString().slice(0, 7)) {
    throw new HttpError(422, "future_month", "that month hasn't started");
  }
  return month;
}

async function clientRow(tx: Tx, tenantId: string) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  return t;
}

async function pdfOf(
  statement: WorkStatement,
  t: { settings: Record<string, unknown>; timezone: string },
  locale?: Locale,
) {
  return {
    filename: workPdfName(statement.month),
    contentType: "application/pdf" as const,
    bytes: new Uint8Array(await workStatementPdf({ statement, ...pdfFormatOf(t, locale) })),
  };
}

/** One client's statement, in the back office narrowed to that client (as the portal reads it). */
function opsStatement(
  ctx: { tx: Tx; tenantIds: readonly string[] },
  catalog: PackCatalog,
  tenantId: string,
  month: string,
  now: Date,
) {
  ensureClient(ctx, tenantId);
  return narrowToTenant(ctx.tx, tenantId, async (one) => {
    const t = await clientRow(one, tenantId);
    const statement = await workStatement(one, catalog, { tenantId, month, now });
    return { t, statement };
  });
}

export function workStatementRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, workStatementRoutes.portalWorkStatement, async (ctx) => {
    const now = new Date();
    return workStatement(ctx.tx, ctx.services.platform.catalog, {
      tenantId: ctx.tenantIds[0] as string,
      month: monthOf(ctx.query, now),
      now,
    });
  });

  mountFile(app, workStatementRoutes.portalWorkStatementPdf, async (ctx) => {
    const now = new Date();
    const tenantId = ctx.tenantIds[0] as string;
    const t = await clientRow(ctx.tx, tenantId);
    const statement = await workStatement(ctx.tx, ctx.services.platform.catalog, {
      tenantId,
      month: monthOf(ctx.query, now),
      now,
    });
    return pdfOf(statement, t, readerLocale(t, ctx.session.user.id));
  });

  mount(app, workStatementRoutes.opsWorkStatement, async (ctx) => {
    const now = new Date();
    const { t, statement } = await opsStatement(
      ctx,
      ctx.services.platform.catalog,
      ctx.params.id,
      monthOf(ctx.query, now),
      now,
    );
    return { ...statement, client: { id: t.id, name: t.name } };
  });

  // DECISION: the back office's PDF is in the client's language, exactly the one emailed.
  mountFile(app, workStatementRoutes.opsWorkStatementPdf, async (ctx) => {
    const now = new Date();
    const { t, statement } = await opsStatement(
      ctx,
      ctx.services.platform.catalog,
      ctx.params.id,
      monthOf(ctx.query, now),
      now,
    );
    return pdfOf(statement, t);
  });
}
