// Pausing and resuming client agents (ARCHITECTURE §11.5; docs/plan.md §1.36). A pause sets the
// agent's run status to paused (no new runs; running ones finish, as today) and records the side,
// who, why and until when in `agent.pause`. The client admin pauses one agent or all of them (the
// account agent stays on) and resumes only the client side's pauses; the operator resumes any; the
// minute cron resumes a pause whose `until` has passed. Every change is an `agent_change` row
// (`kind: 'pause'` or `'resume'`). Callers run inside the client's own scope (invariant 1).

import {
  type AgentPause,
  mayResume,
  pauseEnded,
  pauseUntilProblem,
  readPause,
  type ServiceControl,
  SUPERVISOR_SLUG,
} from "@countersign/core";
import { agent, agentChange, type AgentPause as StoredPause, type Tx } from "@countersign/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { type AgentRow, stageOf } from "./stages";

/** A pause as the column stores it (core's AgentPause, built here). */
const stored = (pause: AgentPause): StoredPause => pause as StoredPause;

const serviceName = (a: AgentRow) => a.serviceName ?? a.name;

/** One service as the client's controls show it. */
export function serviceControl(a: AgentRow): ServiceControl {
  const pause = readPause(a.pause);
  return {
    id: a.id,
    name: serviceName(a),
    status: a.runStatus ?? "draft",
    stage: stageOf(a),
    pause: pause
      ? {
          side: pause.side,
          reason: pause.reason,
          at: pause.at,
          until: pause.until ?? null,
          canResume: mayResume(pause, "client"),
        }
      : null,
    accountAgent: a.slug === SUPERVISOR_SLUG,
  };
}

/** The client's agents the controls show: running or paused, never a test copy. */
export async function controllableAgents(tx: Tx, tenantId: string): Promise<AgentRow[]> {
  const rows = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.testCopy, false)))
    .orderBy(agent.slug);
  return rows.filter((a) => a.runStatus === "active" || a.runStatus === "paused");
}

async function lockClientAgent(tx: Tx, tenantId: string, agentId: string): Promise<AgentRow> {
  const [row] = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId), eq(agent.kind, "client")))
    .for("update");
  if (!row || row.testCopy) throw notFound("service");
  return row;
}

async function logChange(
  tx: Tx,
  row: AgentRow,
  actorId: string | null,
  change: Record<string, unknown>,
): Promise<void> {
  await tx.insert(agentChange).values({ tenantId: row.tenantId, agentId: row.id, actorId, change });
}

/** Pauses one running agent from `side`; an agent already paused keeps its first pause. */
export async function pauseAgent(
  tx: Tx,
  input: {
    tenantId: string;
    agentId: string;
    side: AgentPause["side"];
    by: string | null;
    reason: string;
    until?: string | undefined;
    all?: boolean;
    now?: Date;
  },
): Promise<AgentRow> {
  const now = input.now ?? new Date();
  const problem = pauseUntilProblem(input.until, now);
  if (problem) throw new HttpError(422, "invalid_until", problem);
  const row = await lockClientAgent(tx, input.tenantId, input.agentId);
  if (row.runStatus === "paused") {
    // DECISION: pausing a paused agent changes nothing: the first pause (and its side) stands, so
    // a client's pause never hides the operator's and the operator sees who paused it first.
    return row;
  }
  if (row.runStatus !== "active") {
    throw new HttpError(409, "not_running", "only a running service can be paused");
  }
  const pause: AgentPause = {
    side: input.side,
    by: input.by,
    reason: input.reason,
    at: now.toISOString(),
    ...(input.until ? { until: new Date(input.until).toISOString() } : {}),
    ...(input.all ? { all: true } : {}),
  };
  const [updated] = await tx
    .update(agent)
    .set({ runStatus: "paused", pause: stored(pause) })
    .where(eq(agent.id, row.id))
    .returning();
  await logChange(tx, row, input.by, {
    kind: "pause",
    side: input.side,
    reason: input.reason,
    until: pause.until ?? null,
    ...(input.all ? { all: true } : {}),
  });
  return updated ?? row;
}

/** Resumes a paused agent for `side`: the client only the client side's pauses. */
export async function resumeAgent(
  tx: Tx,
  input: {
    tenantId: string;
    agentId: string;
    side: "client" | "operator" | "system";
    by: string | null;
    reason?: string;
  },
): Promise<AgentRow> {
  const row = await lockClientAgent(tx, input.tenantId, input.agentId);
  if (row.runStatus !== "paused") return row;
  const pause = readPause(row.pause);
  if (input.side === "client" && !mayResume(pause, "client")) {
    throw new HttpError(403, "not_your_pause", "we paused this service: ask us to resume it");
  }
  const [updated] = await tx
    .update(agent)
    .set({ runStatus: "active", pause: null })
    .where(eq(agent.id, row.id))
    .returning();
  await logChange(tx, row, input.by, {
    kind: "resume",
    side: input.side,
    pausedBy: pause?.side ?? null,
    ...(input.reason ? { reason: input.reason } : {}),
  });
  return updated ?? row;
}

/**
 * The operator's existing pause (run status already paused by the registry): records it as the
 * operator's, so the client can't resume it. A pause already recorded stays as it was.
 */
export async function markOperatorPause(
  tx: Tx,
  row: AgentRow,
  by: string,
  now = new Date(),
): Promise<AgentRow> {
  if (row.kind !== "client" || row.pause !== null) return row;
  const pause: AgentPause = {
    side: "operator",
    by,
    // DECISION: the back office's Pause takes no reason today; the record says who paused it.
    reason: "paused by the operator",
    at: now.toISOString(),
  };
  const [updated] = await tx
    .update(agent)
    .set({ pause: stored(pause) })
    .where(eq(agent.id, row.id))
    .returning();
  return updated ?? row;
}

/** Pause all: every running agent of the client but the account agent. */
export async function pauseAll(
  tx: Tx,
  input: { tenantId: string; by: string; reason: string; until?: string | undefined; now?: Date },
): Promise<AgentRow[]> {
  const now = input.now ?? new Date();
  const problem = pauseUntilProblem(input.until, now);
  if (problem) throw new HttpError(422, "invalid_until", problem);
  for (const a of await controllableAgents(tx, input.tenantId)) {
    if (a.slug === SUPERVISOR_SLUG || a.runStatus !== "active") continue;
    await pauseAgent(tx, { ...input, agentId: a.id, side: "client", all: true, now });
  }
  return controllableAgents(tx, input.tenantId);
}

/** Resume all: every agent the client side paused (the operator's and the system's stay). */
export async function resumeAll(
  tx: Tx,
  input: { tenantId: string; by: string },
): Promise<AgentRow[]> {
  for (const a of await controllableAgents(tx, input.tenantId)) {
    if (a.runStatus !== "paused" || !mayResume(readPause(a.pause), "client")) continue;
    await resumeAgent(tx, {
      tenantId: input.tenantId,
      agentId: a.id,
      side: "client",
      by: input.by,
    });
  }
  return controllableAgents(tx, input.tenantId);
}

/** The minute cron: resumes this client's pauses whose `until` has passed. Answers the agents. */
export async function resumeEndedPauses(tx: Tx, tenantId: string, now: Date): Promise<string[]> {
  const rows = await tx
    .select()
    .from(agent)
    .where(
      and(eq(agent.tenantId, tenantId), eq(agent.runStatus, "paused"), isNotNull(agent.pause)),
    );
  const resumed: string[] = [];
  for (const a of rows) {
    if (!pauseEnded(readPause(a.pause), now)) continue;
    await resumeAgent(tx, {
      tenantId,
      agentId: a.id,
      side: "system",
      by: null,
      reason: "the pause ended",
    });
    resumed.push(a.id);
  }
  return resumed;
}
