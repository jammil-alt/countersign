// Per-person limits on the portal routes that call a paid model on each request (audit 5.9):
// plain-words questions (POST /api/runs/ask) and voice typing (POST /api/transcribe), and the back
// office's Draft (POST /api/ops/assist/draft, docs/plan.md §1.168). Each call a
// person makes is first claimed as an `audit_event` row (`metered <kind>`, the person and the
// client), in a short transaction that commits before the model is called; past the minute's or
// the day's allowance the request is refused with 429 and the model is never called.

import type { Session } from "@countersign/auth";
import { auditEvent, type Tx } from "@countersign/db";
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "./audit";
import { HttpError } from "./http";

export type MeteredKind = "runs.ask" | "transcribe" | "assist.draft";

/**
 * Each person's allowance per client: a short burst, then a rolling day.
 */
// DECISION: questions: 10 a minute and 200 in any 24 hours, per person, per client: a person asking
// by hand stays far below both, a script is stopped within a minute. Rolling windows, so no
// client's time zone decides when a day starts.
// DECISION (2026-11-21, live dictation, docs/plan.md §1.109): voice typing sends a recording in
// segments of five to eight seconds while the person speaks (apps/web/src/ui/dictation.ts), at most
// 12 a minute from one composer, so a call is now a segment, not a dictation (it was 10 a minute
// and 200 a day). 30 a minute leaves room for the 12 and a second tab; 1,500 a day is about two
// hours of speech in five-second segments. A script is still stopped within a minute.
export const METERED_LIMITS: Record<MeteredKind, { perMinute: number; perDay: number }> = {
  "runs.ask": { perMinute: 10, perDay: 200 },
  transcribe: { perMinute: 30, perDay: 1500 },
  // DECISION (§1.168): more a minute for Draft than for questions, since a brief has nine fields
  // drafted one after another, each with a Try again; a script is still stopped within a minute.
  "assist.draft": { perMinute: 20, perDay: 300 },
};

export const meteredAction = (kind: MeteredKind) => `metered ${kind}`;

/**
 * Claims one call of `kind` for this person in this client, or refuses it with 429. Runs in the
 * caller's short transaction, which must commit before the model is called. A per-person advisory
 * lock makes the count and the claim one step, so calls sent at once can't all read the same count.
 */
// DECISION: counted from the audit log (`audit_event`, its actor index), the one record every call
// leaves whatever the client has set up: a question's usage row exists only for a client with an
// account agent, and a transcription has no usage row at all. The claim is its own row, written
// before the call, so calls still running count too.
export async function claimMetered(
  tx: Tx,
  c: Context | null,
  /** `tenantId` null: an operator's call about no client (a template's build, a prospect). */
  input: { kind: MeteredKind; tenantId: string | null; session: Session; role: string },
): Promise<void> {
  const { kind, tenantId, session } = input;
  const userId = session.user.id;
  const limits = METERED_LIMITS[kind];
  const action = meteredAction(kind);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`metered:${kind}:${tenantId ?? "none"}:${userId}`}, 0))`,
  );
  // The database's clock, as the rows' created_at is.
  const since = (window: "1 minute" | "24 hours") =>
    tx
      .select({ n: count() })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.actorUserId, userId),
          tenantId ? eq(auditEvent.tenantId, tenantId) : isNull(auditEvent.tenantId),
          eq(auditEvent.action, action),
          gte(auditEvent.createdAt, sql`now() - ${window}::interval`),
        ),
      )
      .then((rows) => Number(rows[0]?.n ?? 0));
  if ((await since("1 minute")) >= limits.perMinute) {
    throw new HttpError(429, "rate_limited", "that's a lot at once: wait a minute and try again");
  }
  if ((await since("24 hours")) >= limits.perDay) {
    throw new HttpError(429, "daily_limit", "you've reached today's limit for this; try tomorrow");
  }
  await auditInTx(tx, c, {
    tenantId,
    actorKind: "user",
    actorUserId: userId,
    actorEmail: session.user.email,
    actorRole: input.role,
    action,
    outcome: "ok",
    target: tenantId ? { client: tenantId } : {},
  });
}
