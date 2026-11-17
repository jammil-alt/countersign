// Follow-up 1 (audit 3.2): a step that meets a change an earlier try claimed, and may have left
// mid-write, waits durably until that claim's lease has run out, then takes the change over under
// its key (a run again of the step, or the approved change executed again). Bounded: after
// MAX_LEASE_WAITS waits the step fails with what it knows. The wait's length is read from the
// database inside a durable step, so a replay waits the same.

import { EXECUTING_LEASE_MINUTES } from "@countersign/agents";
import { isPlainObject } from "@countersign/core";
import { type Db, externalAction, withTenant } from "@countersign/db";
import type { StepOutcome } from "@countersign/workflows";
import { and, eq, sql } from "drizzle-orm";

/** How many times a step waits for one claim to run out before it fails. */
// DECISION (follow-up 1, the lead's): twice; a claim still held after two leases is a caller
// that is really still writing, or something no wait will fix: a person looks.
export const MAX_LEASE_WAITS = 2;

/** Seconds past the lease's end, so the claim has surely run out when the step looks again. */
const MARGIN_SECONDS = 5;

/** What a step waiting on a claim carries between durable steps: ids and counts only. */
export interface LeaseWaitState {
  lease: {
    actionId: string;
    /** Waits so far for this step (this one included). */
    tries: number;
    /**
     * The approval's resume it came from (the change was approved and claimed): the step's other
     * changes and where this one is among them. Absent: the step runs again from the start.
     */
    resume?: { state: unknown; index: number };
  };
}

export function leaseWaitOf(state: unknown): LeaseWaitState["lease"] | null {
  const l = isPlainObject(state) ? state.lease : undefined;
  if (!isPlainObject(l) || typeof l.actionId !== "string" || typeof l.tries !== "number") {
    return null;
  }
  const resume = isPlainObject(l.resume) && typeof l.resume.index === "number" ? l.resume : null;
  return {
    actionId: l.actionId,
    tries: l.tries,
    ...(resume ? { resume: { state: resume.state, index: resume.index as number } } : {}),
  };
}

/** Waits until the claim's lease has run out (a little longer), or fails once waited enough. */
export function leaseWaitOutcome(
  o: { actionId: string; leaseEndsAt: string | null },
  now: Date,
  tries: number,
  resume?: { state: unknown; index: number },
): StepOutcome {
  if (tries >= MAX_LEASE_WAITS) {
    return {
      kind: "failed",
      error: `a change of this step was started by an earlier try and is still claimed after waiting for it; it may have been made: check before trying again (${o.actionId})`,
    };
  }
  const end = o.leaseEndsAt ? Date.parse(o.leaseEndsAt) : Number.NaN;
  const ms = Number.isNaN(end) ? EXECUTING_LEASE_MINUTES * 60_000 : end - now.getTime();
  const seconds = Math.max(MARGIN_SECONDS, Math.ceil(ms / 1000) + MARGIN_SECONDS);
  return {
    kind: "waiting",
    wait: {
      // Nothing sends it: the wait ends at its timeout, a durable sleep.
      eventType: `lease-${o.actionId.replace(/-/g, "")}`,
      timeout: `${seconds} seconds`,
      state: {
        lease: { actionId: o.actionId, tries: tries + 1, ...(resume ? { resume } : {}) },
      } satisfies LeaseWaitState,
      reason: "change",
    },
  };
}

/** Whether there is nothing left to wait for: the change is no longer claimed, or its lease ran out. */
export async function leaseWaitDone(db: Db, tenantId: string, actionId: string): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        held: sql<boolean>`(${externalAction.status} = 'executing' and ${externalAction.executedAt} >= now() - make_interval(mins => ${EXECUTING_LEASE_MINUTES}))`,
      })
      .from(externalAction)
      .where(and(eq(externalAction.id, actionId), eq(externalAction.tenantId, tenantId)));
    return !row?.held;
  });
}
