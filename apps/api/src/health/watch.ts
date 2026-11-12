// v0.17 (ARCHITECTURE §10.15 "Sloan is the chat", docs/plan.md §1.96, O5): the watches Sloan's
// template ran as processes, now platform code on the minute tick. Each client's daily check at
// 08:00 in its own time zone, and a finding for each failed run and each connection that needs a
// person. No agent runs and no model is called. The client's Sloan is named only as the findings'
// reporter, so its items read as before.
//
// A client whose Sloan's live version still has a watch process (v5 and earlier, until the operator
// takes the update) keeps that process, and the platform leaves that watch alone: nothing runs twice.

import {
  dailyCheck,
  type RuntimeDeps,
  reportEvent,
  type SupervisorScope,
} from "@countersign/agents";
import { SUPERVISOR_SLUG } from "@countersign/core";
import { agent, agentVersion, type Db, event, withTenant } from "@countersign/db";
import { and, eq, gte, inArray, lte } from "drizzle-orm";

/** How far back each tick looks for events: findings are fingerprinted, so a second look is free. */
// DECISION (O5): 10 minutes, so a tick or two missed loses nothing; an issue still open is never
// reported twice (findings port), so the overlap costs a read, not an item.
export const WATCH_LOOKBACK_MS = 10 * 60_000;

/** The local time the daily check runs at. */
export const DAILY_CHECK_AT = { hour: 8, minute: 0 } as const;

/** The watch processes of Sloan's older versions, by the event or schedule they cover. */
const LEGACY = {
  daily: "daily-check",
  "run.failed": "run-failed",
  "connection.needs_attention": "connection-needs-attention",
} as const;

interface Sloan {
  agentId: string;
  versionId: string;
  /** Its live version's workflow slugs: a legacy watch among them keeps running as a process. */
  slugs: Set<string>;
}

/** The client's Sloan (its fork of the supervisor template) and what its live version runs. */
async function sloanOf(db: Db, tenantId: string): Promise<Sloan | null> {
  // A client's Sloan carries the supervisor template's slug (templates themselves aren't visible
  // in a client's transaction: row-level security).
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: agent.id, versionId: agent.liveVersionId, bundle: agentVersion.bundle })
      .from(agent)
      .innerJoin(
        agentVersion,
        and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, agent.tenantId)),
      )
      .where(
        and(
          eq(agent.tenantId, tenantId),
          eq(agent.kind, "client"),
          eq(agent.testCopy, false),
          eq(agent.slug, SUPERVISOR_SLUG),
        ),
      )
      .limit(1);
    if (!row?.versionId) return null;
    const workflows = (row.bundle as { workflows?: { slug: string }[] }).workflows ?? [];
    return {
      agentId: row.id,
      versionId: row.versionId,
      slugs: new Set(workflows.map((w) => w.slug)),
    };
  });
}

/** The hour and minute it is in a time zone (the client's; UTC when it has none). */
export function localTime(
  at: Date,
  timeZone: string | null | undefined,
): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { hour: n("hour"), minute: n("minute") };
}

/**
 * One client's watches for this tick: the events of the last minutes reported as findings, and the
 * daily check when it is 08:00 there. Returns what it did, for tests and logs.
 */
export async function platformHealthTick(
  deps: { db: Db; runtime: RuntimeDeps },
  tenantId: string,
  at: Date,
  timeZone: string | null | undefined,
): Promise<{ reported: number; checked: boolean }> {
  const sloan = await sloanOf(deps.db, tenantId);
  if (!sloan) return { reported: 0, checked: false };
  const scope: SupervisorScope = {
    tenantId,
    agentId: sloan.agentId,
    agentVersionId: sloan.versionId,
    runId: "platform:health",
    mode: "live",
    now: () => at,
    health: deps.runtime.ports.health,
    findings: deps.runtime.ports.findings,
    directory: deps.runtime.ports.directory,
  };

  const watched = (["run.failed", "connection.needs_attention"] as const).filter(
    (t) => !sloan.slugs.has(LEGACY[t]),
  );
  let reported = 0;
  if (watched.length > 0) {
    const events = await withTenant(deps.db, tenantId, (tx) =>
      tx
        .select({ type: event.type, payload: event.payload })
        .from(event)
        .where(
          and(
            eq(event.tenantId, tenantId),
            inArray(event.type, [...watched]),
            gte(event.createdAt, new Date(at.getTime() - WATCH_LOOKBACK_MS)),
            lte(event.createdAt, at),
          ),
        ),
    );
    for (const e of events) {
      const out = await reportEvent(scope, {
        event: e.type as (typeof watched)[number],
        facts: e.payload as Record<string, unknown>,
      }).catch((error: unknown) => {
        console.warn(`health watch: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (out?.status === "reported") reported += 1;
    }
  }

  const local = localTime(at, timeZone);
  const due =
    !sloan.slugs.has(LEGACY.daily) &&
    local.hour === DAILY_CHECK_AT.hour &&
    local.minute === DAILY_CHECK_AT.minute;
  if (due) await dailyCheck(scope);
  return { reported, checked: due };
}
