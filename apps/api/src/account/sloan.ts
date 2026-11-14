// Sloan on by default (docs/plan.md §1.47 "On by default"): every client has Sloan, the account
// agent, turned on unless the operator said otherwise. A new client gets it when it is created
// (ops-clients), and the cron's hourly pass turns it on for clients made before, or whose Sloan
// was added but never activated. What Sloan sees and does is unchanged (invariant 11): this only
// switches it on.

import { SUPERVISOR_SLUG } from "@countersign/core";
import { agent, type Db, type Tx, tenant, withOperator } from "@countersign/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { SYSTEM_ACTOR } from "../lifecycle/stages";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { neverTurnedOn, turnOnSloan } from "../routes/supervisor";

/** `tenant.settings` key: `"off"` when the operator created the client without Sloan. */
export const SLOAN_SETTING = "sloan";

/** The minute of the hour the pass runs (each hour, apart from the usage sweep's minute). */
export const SLOAN_SWEEP_MINUTE = 23;

/** A new client's settings, with the operator's choice recorded only when it is "off". */
export function withSloan(settings: Record<string, unknown>, on: boolean): Record<string, unknown> {
  return on ? settings : { ...settings, [SLOAN_SETTING]: "off" };
}

/**
 * Whether a client should have Sloan on by default: not the Sandbox (it has no client people, and
 * Sloan answers only them) and not one the operator created without it.
 */
export function sloanByDefault(settings: unknown): boolean {
  const s = (settings ?? {}) as Record<string, unknown>;
  return s.sandbox !== true && s[SLOAN_SETTING] !== "off";
}

/**
 * The clients among `ids` whose Sloan is still to turn on: those with no Sloan at all, and those
 * whose every Sloan was added but never turned on. A client whose Sloan the operator activated,
 * paused, moved back, retired or discarded keeps it as it is.
 */
// DECISION: "never turned on" is read from the agent's own log (no `run_status` change), so the
// pass needs no column or migration and never undoes an operator's choice.
export async function clientsWithSloanOff(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const [template] = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(and(isNull(agent.tenantId), eq(agent.slug, SUPERVISOR_SLUG)));
  const forks = template
    ? await tx
        .select({
          id: agent.id,
          tenantId: agent.tenantId,
          runStatus: agent.runStatus,
          status: agent.status,
        })
        .from(agent)
        .where(
          and(
            inArray(agent.tenantId, [...ids]),
            eq(agent.templateId, template.id),
            eq(agent.testCopy, false),
          ),
        )
    : [];
  const out: string[] = [];
  for (const id of ids) {
    const mine = forks.filter((f) => f.tenantId === id);
    let off = true;
    for (const f of mine) {
      if (!(await neverTurnedOn(tx, f))) {
        off = false;
        break;
      }
    }
    if (off) out.push(id);
  }
  return out;
}

/**
 * The cron's pass: Sloan turned on for each client that should have it and doesn't, each client in
 * its own transaction (an operator scope of that client alone, so the template is readable and,
 * where the seed never runs, installable). One client's failure is reported and the pass goes on.
 */
export async function sloanTick(db: Db, platform: Platform, scheduledTime: Date): Promise<void> {
  if (scheduledTime.getUTCMinutes() !== SLOAN_SWEEP_MINUTE) return;
  const clients = await db
    .select({ id: tenant.id, settings: tenant.settings, retiredAt: tenant.retiredAt })
    .from(tenant);
  const ids = clients.filter((c) => c.retiredAt === null && sloanByDefault(c.settings));
  if (ids.length === 0) return;
  const off = await withOperator(
    db,
    ids.map((c) => c.id),
    (tx) =>
      clientsWithSloanOff(
        tx,
        ids.map((c) => c.id),
      ),
  );
  for (const id of off) {
    try {
      await withOperator(db, [id], (tx) =>
        turnOnSloan(tx, { tenantId: id, actorId: null, actor: SYSTEM_ACTOR, platform }),
      );
    } catch (error) {
      reportHandled(`turning Sloan on for client ${id} failed`, error, {
        job: "sloan",
        client: id,
      });
    }
  }
}
