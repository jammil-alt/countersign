// The process interview (docs/plan.md §1.217): its signed link, its row read as the page and the
// back office see it, and what its model calls cost. The link carries the client, the interview
// and the expiry, signed like the form links under its own label, so no other link opens it.

import {
  answersGiven,
  Decimal,
  INTERVIEW_MAX_ANSWERS,
  INTERVIEW_MAX_FILES,
  IntakeArea,
  type InterviewFile,
  InterviewFile as InterviewFileSchema,
  InterviewLinkToken,
  InterviewOutputs,
  type InterviewPageView,
  InterviewReuse,
  type InterviewTurn,
  InterviewTurn as InterviewTurnSchema,
  interviewPagePath,
  type Locale,
  matchLocale,
  type OpsInterviewSummary,
  type OpsInterviewView,
} from "@countersign/core";
import { contact, processInterview, type Tx, tenant } from "@countersign/db";
import type { LlmCallRecord } from "@countersign/llm";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type FormLinkEnv, signLink, verifyLink } from "../forms/link";
import { notFound } from "../http";

export type InterviewRow = typeof processInterview.$inferSelect;

const LABEL = "mezonas-interview-link";

/** The page's full address for an interview. */
export async function interviewLink(
  env: FormLinkEnv,
  origin: string,
  row: Pick<InterviewRow, "id" | "tenantId" | "expiresAt">,
): Promise<string> {
  const token = await signLink(env, LABEL, {
    t: row.tenantId,
    i: row.id,
    e: Math.floor(row.expiresAt.getTime() / 1000),
  } satisfies InterviewLinkToken);
  return `${origin}${interviewPagePath(token)}`;
}

/** The link's client and interview, or null: forged, malformed or past its expiry. */
export async function verifyInterviewLink(
  env: FormLinkEnv,
  token: string,
  now: number = Date.now(),
): Promise<{ tenantId: string; id: string } | null> {
  const link = await verifyLink(env, LABEL, token, InterviewLinkToken);
  if (!link || link.e * 1000 < now) return null;
  return { tenantId: link.t, id: link.i };
}

/** The stored turns; an unreadable one is left out, never a failure. */
export function turnsOf(row: Pick<InterviewRow, "turns">): InterviewTurn[] {
  return (row.turns ?? []).flatMap((t) => {
    const parsed = InterviewTurnSchema.safeParse(t);
    return parsed.success ? [parsed.data] : [];
  });
}

export function filesOf(row: Pick<InterviewRow, "documents">): InterviewFile[] {
  return z
    .array(InterviewFileSchema)
    .catch([])
    .parse(row.documents ?? []);
}

/** Whether the interview still takes answers now. */
export function isOpen(row: Pick<InterviewRow, "status" | "expiresAt">, now: Date): boolean {
  return row.status === "open" && row.expiresAt.getTime() > now.getTime();
}

/** One interview of the request's clients, or 404 (another client's is not found: invariant 1). */
export async function readInterview(
  tx: Tx,
  tenantId: string,
  id: string,
  lock = false,
): Promise<InterviewRow> {
  const q = tx
    .select()
    .from(processInterview)
    .where(and(eq(processInterview.id, id), eq(processInterview.tenantId, tenantId)));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("interview");
  return row;
}

/** An entry for the interview's log, with time, address and browser. */
export function logEntry(kind: string, origin: Record<string, unknown>, extra = {}) {
  return sql`${processInterview.log} || ${JSON.stringify([
    { at: new Date().toISOString(), kind, ...origin, ...extra },
  ])}::jsonb`;
}

/** What the calls cost, rounded up to a ten-thousandth each (§1.199), added to what it had. */
export function addCost(before: string, calls: readonly LlmCallRecord[]): string {
  let sum = new Decimal(before);
  for (const c of calls) {
    if (c.costUsd) sum = sum.plus(new Decimal(c.costUsd).toDecimalPlaces(4, Decimal.ROUND_UP));
  }
  return sum.toFixed(4);
}

/** The page's view: the client's name, the person, the questions and answers. Nothing of ours. */
export async function pageView(tx: Tx, row: InterviewRow, now: Date): Promise<InterviewPageView> {
  const [client] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, row.tenantId));
  const [who] = await tx
    .select({ name: contact.name })
    .from(contact)
    .where(and(eq(contact.id, row.contactId), eq(contact.tenantId, row.tenantId)));
  const turns = turnsOf(row);
  const state = row.status === "finished" ? "finished" : isOpen(row, now) ? "open" : "closed";
  return {
    client: client?.name ?? "",
    name: who?.name ?? "",
    process: row.process,
    state,
    turns: state === "closed" ? [] : turns,
    question: state === "open" ? row.question : null,
    files: filesOf(row).map((f) => ({ filename: f.filename })),
    answered: answersGiven(turns),
    maxAnswers: INTERVIEW_MAX_ANSWERS,
    maxFiles: INTERVIEW_MAX_FILES,
    language: (matchLocale(row.language) ?? "en") as Locale,
  };
}

const areaOf = (v: string | null) => {
  const parsed = IntakeArea.safeParse(v);
  return parsed.success ? parsed.data : null;
};

/** The back office's list entries, with each contact's name. */
export async function summaries(
  tx: Tx,
  rows: readonly InterviewRow[],
): Promise<OpsInterviewSummary[]> {
  const ids = [...new Set(rows.map((r) => r.contactId))];
  const people =
    ids.length === 0
      ? []
      : await tx
          .select({ id: contact.id, tenantId: contact.tenantId, name: contact.name })
          .from(contact)
          .where(inArray(contact.id, ids));
  return rows.map((r) => {
    const who = people.find((p) => p.id === r.contactId && p.tenantId === r.tenantId);
    return {
      id: r.id,
      contact: { id: r.contactId, name: who?.name ?? "" },
      process: r.process,
      area: areaOf(r.area),
      status: r.status,
      answered: answersGiven(turnsOf(r)),
      buildId: r.buildId ?? null,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

/** The back office's view of one interview: everything, its link while it takes answers. */
export async function opsView(
  tx: Tx,
  row: InterviewRow,
  links: { env: FormLinkEnv; origin: string },
  now: Date,
): Promise<OpsInterviewView> {
  const [summary] = await summaries(tx, [row]);
  if (!summary) throw notFound("interview");
  const outputs = InterviewOutputs.safeParse(row.outputs);
  const reuse = InterviewReuse.safeParse(row.reuse);
  return {
    ...summary,
    link: isOpen(row, now) ? await interviewLink(links.env, links.origin, row) : null,
    expiresAt: row.expiresAt.toISOString(),
    turns: turnsOf(row),
    question: row.status === "open" ? row.question : null,
    files: filesOf(row),
    outputs: outputs.success ? outputs.data : null,
    reuse: reuse.success ? reuse.data : null,
    costUsd: new Decimal(row.costUsd).toFixed(4),
  };
}
