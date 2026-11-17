// Expansion spotting (docs/plan.md §1.124.4; Sales' Expansion, "Spotted"): nightly, deterministic
// signals per live client open an expansion deal at `spotted` with its evidence and sources
// (invariant 10), and a to-do for the operator: "Pursue?". Each signal is made once (`dedupe_key`).
// Nothing reaches the client: pitching is a later stage, and prices are always the operator's.
//
// Signals: run volume up three months running; a renewal 60 days ahead (a won deal's agreed date
// plus 12 months). Documents or emails no agent picks up are not countable yet (left for later).

import { type Db, deal, run, tenant, withOperator } from "@countersign/db";
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { reportHandled } from "../observability/report";
import { addActivity } from "../work/deals";
import { logPlay } from "../work/play-log";
import { addTodo } from "../work/todos-store";

// DECISION: spotting runs nightly at 04:41 UTC, after the packs' nightly passes, so a client's
// numbers for yesterday are in.
export const SPOT_HOUR = 4;
export const SPOT_MINUTE = 41;
const DAY = 24 * 60 * 60 * 1000;

export interface Signal {
  key: string;
  title: string;
  evidence: { text: string; sources: string[] }[];
}

const monthKey = (d: Date) => d.toISOString().slice(0, 7);

function monthStart(d: Date, back: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
}

/** Live runs a month for the last four whole months: up three months running? */
export function volumeUp(counts: readonly number[]): boolean {
  return (
    counts.length === 4 &&
    counts.every((n, i) => i === 0 || n > (counts[i - 1] as number)) &&
    (counts[0] as number) > 0
  );
}

/** The signals at one client tonight. */
export async function signalsFor(db: Db, tenantId: string, now: Date): Promise<Signal[]> {
  return withOperator(db, [tenantId], async (tx) => {
    const out: Signal[] = [];
    const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
    const name = t?.name ?? "the client";
    // Run volume: the four whole months before this one.
    const counts: number[] = [];
    for (let back = 4; back >= 1; back--) {
      const [c] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(run)
        .where(
          and(
            eq(run.tenantId, tenantId),
            eq(run.mode, "live"),
            gte(run.createdAt, monthStart(now, back)),
            lt(run.createdAt, monthStart(now, back - 1)),
          ),
        );
      counts.push(c?.n ?? 0);
    }
    if (volumeUp(counts)) {
      const recent = await tx
        .select({ id: run.id })
        .from(run)
        .where(
          and(
            eq(run.tenantId, tenantId),
            eq(run.mode, "live"),
            gte(run.createdAt, monthStart(now, 1)),
            lt(run.createdAt, monthStart(now, 0)),
          ),
        )
        .orderBy(desc(run.createdAt))
        .limit(5);
      out.push({
        key: `volume:${tenantId}:${monthKey(monthStart(now, 1))}`,
        title: `${name}: more work every month`,
        evidence: [
          {
            text: `Runs a month up three months running: ${counts.join(", ")}.`,
            sources: [tenantId, ...recent.map((r) => r.id)],
          },
        ],
      });
    }
    // Renewals: 60 days before a won deal's year is up.
    const won = await tx
      .select({ id: deal.id, title: deal.title, agreedFrom: deal.agreedFrom })
      .from(deal)
      .where(and(eq(deal.clientId, tenantId), eq(deal.outcome, "won"), isNotNull(deal.agreedFrom)));
    for (const w of won) {
      const from = new Date(`${w.agreedFrom}T00:00:00Z`);
      const due = new Date(
        Date.UTC(from.getUTCFullYear() + 1, from.getUTCMonth(), from.getUTCDate()),
      );
      const ahead = due.getTime() - now.getTime();
      if (ahead <= 0 || ahead > 60 * DAY) continue;
      out.push({
        key: `renewal:${w.id}:${due.toISOString().slice(0, 10)}`,
        title: `${name}: renewal on ${due.toISOString().slice(0, 10)}`,
        evidence: [
          {
            text: `"${w.title}" was agreed from ${w.agreedFrom}; its year is up on ${due.toISOString().slice(0, 10)}.`,
            sources: [w.id],
          },
        ],
      });
    }
    return out;
  });
}

/** Opens a spotted expansion deal and the operator's "Pursue?" to-do for a signal, once. */
export async function openSpotted(db: Db, tenantId: string, s: Signal): Promise<string | null> {
  return withOperator(db, [tenantId], async (tx) => {
    const [made] = await tx
      .insert(deal)
      .values({
        kind: "expansion",
        clientId: tenantId,
        title: s.title.slice(0, 200),
        stage: "spotted",
        source: "reggie",
        evidence: s.evidence,
        dedupeKey: s.key,
        waitingOn: "operator",
        nextStep: "Pursue?",
      })
      .onConflictDoNothing({ target: deal.dedupeKey, where: sql`${deal.dedupeKey} is not null` })
      .returning({ id: deal.id });
    if (!made) return null;
    await addActivity(tx, made.id, {
      kind: "system",
      actor: "reggie",
      body: s.evidence.map((e) => e.text).join("\n"),
      sources: s.evidence.flatMap((e) => e.sources),
    });
    await addTodo(tx, {
      title: `Pursue? ${s.title}`.slice(0, 300),
      owner: "operator",
      clientId: tenantId,
      about: { kind: "deal", id: made.id },
      source: "reggie",
      playKey: "stage",
      why: s.evidence[0]?.text.slice(0, 300) ?? null,
      read: s.evidence.map((e) => e.text).join(" "),
      options: [
        { label: "Pursue", value: "pitch" },
        { label: "Not now", value: "not_now" },
      ],
      primaryAction: { label: "Decide", kind: "decide", ref: { dealId: made.id } },
      dedupeKey: `spotted:${s.key}`.slice(0, 500),
    });
    await logPlay(tx, {
      clientId: tenantId,
      flow: "grow",
      stage: "spotted",
      play: "stage",
      level: "draft",
      outcome: "drafted",
      internal: true,
      about: { kind: "deal", id: made.id },
      summary: s.title,
    });
    return made.id;
  });
}

/** Nightly: every live client's signals. */
export async function spottingTick(db: Db, now: Date): Promise<number> {
  if (now.getUTCHours() !== SPOT_HOUR || now.getUTCMinutes() !== SPOT_MINUTE) return 0;
  const clients = await db.select({ id: tenant.id }).from(tenant).where(isNull(tenant.retiredAt));
  let opened = 0;
  for (const c of clients) {
    try {
      for (const s of await signalsFor(db, c.id, now)) {
        if (await openSpotted(db, c.id, s)) opened += 1;
      }
    } catch (error) {
      reportHandled("expansion spotting failed for a client", error, {
        job: "backoffice_spotting",
        tenant: c.id,
      });
    }
  }
  return opened;
}
