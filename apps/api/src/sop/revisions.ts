// The agent's SOP, its revisions (docs/sop-plan.md §6; migration 0074). A revision is recorded at
// the change, in the change's transaction, with who made it and where: `recordSopRevision` makes
// the SOP as it is now, compares its fingerprint with the last revision's, and adds a row only when
// they differ. Rows are never updated or deleted (the table's trigger). Reads and the hourly check
// call it too, as a safety net: a revision they find is one a change site didn't record, reported
// to Sentry so the call site is fixed.

import {
  type SopChange,
  type SopRevisionEntry,
  SopView,
  sopChanges,
  sopFingerprint,
  sopView,
} from "@countersign/core";
import {
  agent,
  appUser,
  type Db,
  membership,
  sopRevision,
  type Tx,
  tenant,
  withOperator,
} from "@countersign/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { reportHandled, reportProblem } from "../observability/report";
import type { Platform } from "../platform";
import { portalAdjustable } from "../setup/adjust";
import { sopInputFor } from "./inputs";

export type SopRevisionSource =
  | "first"
  | "version"
  | "agent"
  | "connection"
  | "grant"
  | "approver_rules"
  | "business_hours"
  | "owner"
  | "adjust"
  | "stage"
  | "check"
  | "format";

const WHERE_WORDS: Record<SopRevisionSource, string> = {
  first: "First revision",
  version: "New version of the agent",
  agent: "The agent's settings",
  connection: "Connections",
  grant: "The agent's access to a connection",
  approver_rules: "Approval rules",
  business_hours: "Business hours",
  owner: "The area's owner",
  adjust: "This agent's settings",
  stage: "Go-live stage",
  check: "Recorded by our check",
  format: "How Mezonas writes SOPs",
};

/** Who made a change: a person's id and which side they are on; null for our checks. */
export interface SopChangeBy {
  userId: string | null;
  side: "client" | "operator" | "system";
}

/** The settings the client may adjust, as the SOP lists them (their value counts in a revision). */
export async function sopSettings(tx: Tx, platform: Platform, tenantId: string, agentId: string) {
  const rows = await portalAdjustable(tx, tenantId, agentId, platform.ctx);
  return rows.map((r) => ({
    label: r.label,
    value: r.current ?? "Not set",
    limits: r.options?.length
      ? r.options.join(", ")
      : r.min !== null || r.max !== null
        ? [r.min !== null ? `from ${r.min}` : null, r.max !== null ? `to ${r.max}` : null]
            .filter(Boolean)
            .join(" ")
        : null,
    changedBy:
      r.changedSide === "client" ? r.changedBy : r.changedSide === "operator" ? "Us" : null,
  }));
}

/**
 * Records a new revision of each agent's SOP whose content changed. Client agents only (a
 * template has no SOP; its copies do), never a test copy. Returns the agents given a revision.
 */
export async function recordSopRevision(
  tx: Tx,
  platform: Platform,
  input: {
    tenantId: string;
    agentIds: readonly string[];
    by: SopChangeBy;
    source: SopRevisionSource;
  },
): Promise<string[]> {
  const made: string[] = [];
  for (const agentId of [...new Set(input.agentIds)]) {
    // One writer per agent at a time, so two changes never take the same number.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sop:${agentId}`}, 0))`);
    const [a] = await tx
      .select()
      .from(agent)
      .where(
        and(eq(agent.id, agentId), eq(agent.tenantId, input.tenantId), eq(agent.kind, "client")),
      );
    if (!a || a.testCopy) continue;
    const read = await sopInputFor(tx, platform, a, {
      learned: null,
      measures: [],
      settings: await sopSettings(tx, platform, input.tenantId, a.id),
      asOf: new Date(),
    });
    if (!read) continue;
    const view = sopView({ ...read.input, revision: null, previous: null, history: [] });
    const fingerprint = await sopFingerprint(view);
    const [last] = await tx
      .select()
      .from(sopRevision)
      .where(and(eq(sopRevision.tenantId, input.tenantId), eq(sopRevision.agentId, a.id)))
      .orderBy(desc(sopRevision.major), desc(sopRevision.minor))
      .limit(1);
    if (last && last.fingerprint === fingerprint) continue;
    const before = last ? SopView.safeParse(last.view) : null;
    const changes: SopChange[] = sopChanges(before?.success ? before.data : null, view);
    const major = read.versionNumber;
    const minor = last && last.major === major ? last.minor + 1 : 0;
    const formatChanged = before?.success === true && before.data.format !== view.format;
    const source: SopRevisionSource = !last
      ? "first"
      : formatChanged
        ? "format"
        : last.major !== major && input.source !== "check"
          ? "version"
          : input.source;
    await tx.insert(sopRevision).values({
      tenantId: input.tenantId,
      agentId: a.id,
      major,
      minor,
      agentVersionId: read.versionId,
      fingerprint,
      view,
      changes,
      changedByUserId: input.by.userId,
      changedBySide: input.by.side,
      source,
    });
    // A new way of writing SOPs is not a change a site missed.
    if (source !== "format") made.push(a.id);
  }
  return made;
}

/**
 * The same, never failing the change it follows: a revision that can't be made is reported and
 * the next read or the hourly check makes it.
 */
export async function recordSopRevisionQuietly(
  tx: Tx,
  platform: Platform,
  input: Parameters<typeof recordSopRevision>[2],
): Promise<void> {
  try {
    await tx.transaction(async (inner) => {
      await recordSopRevision(inner as unknown as Tx, platform, input);
    });
  } catch (error) {
    reportProblem("sop revision not recorded", {
      source: input.source,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

/** The agents of a client that use a connection (their bindings name it). */
export async function agentsUsingConnection(tx: Tx, tenantId: string, connectionId: string) {
  const rows = await tx
    .select({ id: agent.id, bindings: agent.bindings })
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.testCopy, false)));
  return rows
    .filter((r) =>
      Object.values((r.bindings ?? {}) as Record<string, string>).includes(connectionId),
    )
    .map((r) => r.id);
}

/** Every client agent of a client (a client-wide change: approval rules, business hours). */
export async function clientAgentIds(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.testCopy, false)));
  return rows.map((r) => r.id);
}

/** The agent's revisions, newest first, with who made each by name ("Mezonas" for ours). */
export async function sopHistory(
  tx: Tx,
  tenantId: string,
  agentId: string,
): Promise<SopRevisionEntry[]> {
  const rows = await tx
    .select({
      major: sopRevision.major,
      minor: sopRevision.minor,
      at: sopRevision.createdAt,
      changes: sopRevision.changes,
      side: sopRevision.changedBySide,
      source: sopRevision.source,
      name: appUser.name,
      email: appUser.email,
      role: membership.role,
    })
    .from(sopRevision)
    .leftJoin(appUser, eq(appUser.id, sopRevision.changedByUserId))
    .leftJoin(
      membership,
      and(
        eq(membership.userId, sopRevision.changedByUserId),
        eq(membership.tenantId, sopRevision.tenantId),
      ),
    )
    .where(and(eq(sopRevision.tenantId, tenantId), eq(sopRevision.agentId, agentId)))
    .orderBy(desc(sopRevision.major), desc(sopRevision.minor))
    .limit(100);
  return rows.map((r) => ({
    number: `${r.major}.${r.minor}`,
    at: r.at.toISOString(),
    changes: (r.changes ?? []) as SopChange[],
    by:
      r.side === "system"
        ? null
        : r.side === "operator" || r.role === "operator"
          ? "Mezonas"
          : r.name?.trim() || r.email || "Your team",
    where: WHERE_WORDS[r.source as SopRevisionSource] ?? "",
  }));
}

/** The minute of the hour the SOP check runs (others: Sloan 23, search 11). */
export const SOP_CHECK_MINUTE = 37;

/**
 * The hourly safety net (docs/sop-plan.md §6): each client's agents whose SOP changed without a
 * revision get one now ("Recorded by our check"), each reported, so a change site that doesn't
 * record its own is found and fixed. One client per transaction, in that client's scope.
 */
export async function sopCheckTick(db: Db, platform: Platform, scheduledTime: Date): Promise<void> {
  if (scheduledTime.getUTCMinutes() !== SOP_CHECK_MINUTE) return;
  const clients = await db.select({ id: tenant.id, retiredAt: tenant.retiredAt }).from(tenant);
  for (const c of clients) {
    if (c.retiredAt !== null) continue;
    try {
      const made = await withOperator(db, [c.id], async (tx) =>
        recordSopRevision(tx, platform, {
          tenantId: c.id,
          agentIds: await clientAgentIds(tx, c.id),
          by: { userId: null, side: "system" },
          source: "check",
        }),
      );
      if (made.length > 0)
        reportProblem("sop revisions made by the hourly check", {
          client: c.id,
          agents: String(made.length),
        });
    } catch (error) {
      reportHandled(`sop check for client ${c.id} failed`, error, {
        job: "sop_check",
        client: c.id,
      });
    }
  }
}
