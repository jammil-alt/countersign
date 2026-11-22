// docs/plan.md §1.234 (Y5), ARCHITECTURE §10.25: the work-delivered statement. What a client's
// agents did in a billing month, per agent and per business area, from the one query that counts
// it (`workCounts` in packages/db, whose meanings are core's `WORK_COUNTERS`). The portal's page,
// its PDF, the back office's view and the PDF emailed with the Stripe invoice are all this one
// function's answer, so they always agree.
//
// It shows work and dollars identified for the client, never our cost, margin, model or vendor
// spend, bundles, instructions or prompts (invariant 11), and only ever one client.

import {
  clientLanguage,
  complianceOf,
  Decimal,
  type Locale,
  type OwnerArea,
  type Processor,
  processArea,
  processingRefusal,
  readTenantBilling,
  WORK_COUNT_IDS,
  WORK_STATEMENT_EMAIL_FEATURE,
  WORK_STATEMENT_WORDS,
  type WorkAmount,
  type WorkCounts,
  type WorkStatement,
  type WorkStatementAgent,
  type WorkStatementArea,
  workCountLines,
  workMonthName,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  billingStatement,
  type Tx,
  tenant,
  workCounts,
} from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
import { PageSizes, PDFDocument, StandardFonts } from "pdf-lib";
import { meter } from "../metering";
import type { Mailer } from "../notify/mailer";
import { reportHandled } from "../observability/report";
import { packsOf } from "../owners/store";
import { MUTED, paperFor, SLATE, Writer } from "../weekly/pdf";

/** What reads a skill's packs (the platform's skill catalog), for an agent's business area. */
export interface PackCatalog {
  get(id: string): { requiresPacks: string[] } | undefined;
}

/** `2026-10` → its first instant and the first instant of the month after (UTC). */
export function monthBounds(month: string): { since: Date; until: Date; from: string; to: string } {
  const since = new Date(`${month}-01T00:00:00.000Z`);
  const until = new Date(since);
  until.setUTCMonth(until.getUTCMonth() + 1);
  const last = new Date(until.getTime() - 86_400_000);
  return {
    since,
    until,
    from: since.toISOString().slice(0, 10),
    to: last.toISOString().slice(0, 10),
  };
}

/** The month a statement is for by default: last month (UTC), the one invoiced. */
// DECISION (§1.234): months are UTC, as billing months are (§1.32), so the statement covers
// exactly the bill's month whatever the client's time zone.
export function lastMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

const emptyCounts = (): WorkCounts => ({
  itemsProcessed: 0,
  autoPosted: 0,
  sentForApproval: 0,
  exceptionsCaught: 0,
  dollarsIdentified: [],
});

/** Adds counts together, amounts per currency in decimal (never across currencies). */
export function addCounts(all: readonly WorkCounts[]): WorkCounts {
  const out = emptyCounts();
  const money = new Map<string, Decimal>();
  for (const c of all) {
    for (const id of WORK_COUNT_IDS) out[id] += c[id];
    for (const a of c.dollarsIdentified) {
      money.set(a.currency, (money.get(a.currency) ?? new Decimal(0)).plus(new Decimal(a.total)));
    }
  }
  out.dollarsIdentified = [...money]
    .filter(([, total]) => !total.isZero())
    .sort(([ca, a], [cb, b]) => b.comparedTo(a) || ca.localeCompare(cb))
    .map(([currency, total]): WorkAmount => ({ currency, total: total.toFixed(2) }));
  return out;
}

const AREA_ORDER: readonly OwnerArea[] = [
  "purchasing",
  "sales",
  "receivables",
  "bookkeeping",
  "marketing",
  "general",
];

/**
 * A client's work statement for a month (`YYYY-MM`), read in `tx` (the client's scope, or the
 * back office's narrowed to it).
 */
export async function workStatement(
  tx: Tx,
  catalog: PackCatalog,
  input: { tenantId: string; month: string; now: Date },
): Promise<WorkStatement> {
  const { since, until, from, to } = monthBounds(input.month);
  const [[t], counts, [bill]] = await Promise.all([
    tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, input.tenantId)),
    workCounts(tx, { tenantId: input.tenantId, since, until }),
    tx
      .select({ number: billingStatement.stripeInvoiceNumber })
      .from(billingStatement)
      .where(and(eq(billingStatement.tenantId, input.tenantId), eq(billingStatement.period, from))),
  ]);
  if (!t) throw new Error("no such client");
  const ids = counts.map((c) => c.agentId);
  const agents =
    ids.length === 0
      ? []
      : await tx
          .select({
            id: agent.id,
            name: agent.name,
            serviceName: agent.serviceName,
            area: agent.area,
            bundle: agentVersion.bundle,
          })
          .from(agent)
          .leftJoin(
            agentVersion,
            and(
              eq(agentVersion.id, agent.liveVersionId),
              eq(agentVersion.tenantId, agent.tenantId),
            ),
          )
          .where(and(eq(agent.tenantId, input.tenantId), inArray(agent.id, ids)));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const rows: WorkStatementAgent[] = counts.map((c) => {
    const a = byId.get(c.agentId);
    const definition = (a?.bundle as { definition?: Record<string, unknown> } | null)?.definition;
    // DECISION (§1.234): "per pack" is per business area, as the data is organised (§12.0): the
    // operator's area on the agent, else its bundle's, else its one area pack (processArea).
    const area = processArea({
      set: a?.area,
      declared: typeof definition?.area === "string" ? definition.area : undefined,
      requiresPacks: packsOf(definition?.skills as readonly { skill: string }[] | undefined, (id) =>
        catalog.get(id),
      ),
    });
    const { agentId, runs, ...rest } = c;
    return {
      id: agentId,
      name: a?.serviceName ?? a?.name ?? "",
      area,
      runs,
      counts: rest,
    };
  });
  const areas: WorkStatementArea[] = AREA_ORDER.flatMap((area) => {
    const inArea = rows.filter((r) => r.area === area);
    return inArea.length === 0
      ? []
      : [{ area, agents: inArea.length, counts: addCounts(inArea.map((r) => r.counts)) }];
  });
  return {
    client: { name: t.name },
    month: input.month,
    from,
    to,
    partial: input.now < until,
    totals: addCounts(rows.map((r) => r.counts)),
    areas,
    agents: rows,
    invoiceNumber: bill?.number ?? null,
  };
}

// ── The PDF ─────────────────────────────────────────────────────────────────────────────────────

/** The statement as a PDF: pdf-lib, Helvetica, nothing stored; the same bytes for the same data. */
export async function workStatementPdf(input: {
  statement: WorkStatement;
  locale: Locale;
  paper: "letter" | "a4";
}): Promise<Uint8Array> {
  const { statement: s, locale } = input;
  const w = WORK_STATEMENT_WORDS[locale];
  const month = workMonthName(s.month, locale);
  const doc = await PDFDocument.create();
  doc.setTitle(`${w.title}: ${s.client.name}, ${month}`);
  doc.setProducer("Mezonas");
  doc.setCreator("Mezonas");
  // A fixed date keeps the bytes the same for the same month.
  const at = new Date(`${s.to}T00:00:00.000Z`);
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const out = new Writer(
    doc,
    input.paper === "letter" ? PageSizes.Letter : PageSizes.A4,
    font,
    bold,
  );
  const num = new Intl.NumberFormat(locale);

  out.text(s.client.name, { size: 10, color: MUTED, gap: 2 });
  out.text(w.title, { size: 20, bold: true, gap: 2 });
  out.text(
    [month, s.partial ? w.soFar : null, s.invoiceNumber ? w.invoice(s.invoiceNumber) : null]
      .filter(Boolean)
      .join(" · "),
    { size: 12, color: MUTED, gap: 8 },
  );
  if (s.agents.length === 0) {
    out.text(w.none);
    return doc.save();
  }
  out.heading(w.totals);
  for (const l of workCountLines(s.totals, locale)) out.text(`${l.label}: ${l.value}`);
  if (s.areas.length > 1) {
    out.heading(w.byArea);
    for (const a of s.areas) {
      out.text(w.areas[a.area], { bold: true, gap: 2 });
      for (const l of workCountLines(a.counts, locale))
        out.text(`${l.label}: ${l.value}`, { color: MUTED, gap: 2 });
      out.text("", { gap: 2 });
    }
  }
  out.heading(w.byAgent);
  for (const a of s.agents) {
    out.text(`${a.name} (${w.areas[a.area]}, ${num.format(a.runs)} ${w.runs.toLowerCase()})`, {
      bold: true,
      color: SLATE,
      gap: 2,
    });
    for (const l of workCountLines(a.counts, locale))
      out.text(`${l.label}: ${l.value}`, { color: MUTED, gap: 2 });
    out.text("", { gap: 2 });
  }
  return doc.save();
}

/** `mezonas-work-2026-10.pdf`. */
export const workPdfName = (month: string) => `mezonas-work-${month}.pdf`;

/** The client's language and paper for its PDF. */
export function pdfFormatOf(
  t: { settings: Record<string, unknown>; timezone: string },
  locale?: Locale,
): { locale: Locale; paper: "letter" | "a4" } {
  const language = clientLanguage(t.settings);
  return {
    locale: locale ?? language ?? "en",
    paper: paperFor({ language, timezone: t.timezone }),
  };
}

// ── With the invoice ────────────────────────────────────────────────────────────────────────────

export interface WorkStatementMail {
  mailer: Mailer;
  /** The processors with a signed BAA (`BAA_PROCESSORS`), for HIPAA mode. */
  covered: ReadonlySet<Processor>;
  catalog: PackCatalog;
  /** The app's origin, for the link to the statement in the portal. */
  origin: string;
  now?: Date;
}

/**
 * The PDF with the invoice. Stripe's API has no way to attach a file to the invoice email it
 * sends, so the statement goes in our own email to the same billing address, sent when the
 * invoice is: from Mezonas over Resend, with the PDF attached. Once per statement (Resend's
 * idempotency key is the statement's), metered as one email of ours. Never thrown: the invoice
 * has already gone. Returns why it wasn't sent, or null.
 */
// DECISION (§1.234): our own email beside Stripe's, since Stripe can't carry an attachment; to
// the Stripe customer's billing email (none: nothing sent, the statement stays in the portal).
// The email is ours to pay for (`ours`), as a sign-in code is: the client is not billed for its
// own statement. A client in HIPAA mode gets it in the portal only until `resend` is covered.
export async function emailWorkStatement(
  tx: Tx,
  mail: WorkStatementMail,
  input: { tenantId: string; statementId: string; period: string },
): Promise<string | null> {
  try {
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    if (!t) return "no_client";
    const billing = readTenantBilling(t.settings);
    if (!billing?.email) return "no_billing_email";
    if (!mail.mailer.isConfigured) return "not_configured";
    const refused = processingRefusal(
      complianceOf(t.settings ?? {}),
      mail.covered,
      WORK_STATEMENT_EMAIL_FEATURE.processors,
      WORK_STATEMENT_EMAIL_FEATURE.what,
    );
    if (refused) return "hipaa";
    const month = input.period.slice(0, 7);
    const statement = await workStatement(tx, mail.catalog, {
      tenantId: input.tenantId,
      month,
      now: mail.now ?? new Date(),
    });
    const format = pdfFormatOf(t);
    const bytes = await workStatementPdf({ statement, ...format });
    const w = WORK_STATEMENT_WORDS[format.locale];
    const monthName = workMonthName(month, format.locale);
    const id = await mail.mailer.send({
      to: billing.email,
      subject: w.emailSubject(monthName),
      text: w.emailBody({
        client: t.name,
        month: monthName,
        link: `${mail.origin.replace(/\/$/, "")}/billing/work?month=${month}`,
      }),
      idempotencyKey: `work-statement-${input.statementId}`,
      attachments: [
        { filename: workPdfName(month), contentType: "application/pdf", content: bytes },
      ],
      tags: { statement: input.statementId },
    });
    await meter(tx, {
      tenantId: input.tenantId,
      measure: "emails",
      source: "notification",
      key: id ? `resend:${id}` : `work-statement:${input.statementId}`,
      ours: true,
    });
    return null;
  } catch (error) {
    reportHandled(`the work statement for ${input.statementId} wasn't emailed`, error, {
      job: "billing",
      client: input.tenantId,
    });
    return "failed";
  }
}
