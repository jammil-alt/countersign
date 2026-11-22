// Running an agent's security checks and keeping their results (docs/agent-assurance-plan.md §6):
// nightly for every live client agent, after a change to its setup, and when an operator asks. Each
// result is a `control_check` row, never updated or deleted. A check that goes into review opens
// one issue for us; it stays linked while the check stays in review.

import {
  type AssuranceView,
  assuranceView,
  CHECKS,
  type CheckOutcome,
  checkSpec,
  runAssuranceChecks,
  type StoredResult,
} from "@countersign/core";
import { agent, controlCheck, type Db, type Tx, tenant, withOperator } from "@countersign/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { createIssue } from "../work/issues";
import { type AssuranceEnv, assuranceInputFor } from "./inputs";
import { assuranceScans } from "./scan";

type AgentRow = typeof agent.$inferSelect;
export type CheckTrigger = "nightly" | "setup_change" | "person";

/** Each check's latest result for the agent, and since when it has been in review. */
export async function storedResults(
  tx: Tx,
  tenantId: string,
  agentId: string,
): Promise<StoredResult[]> {
  const rows = await tx
    .select()
    .from(controlCheck)
    .where(and(eq(controlCheck.tenantId, tenantId), eq(controlCheck.agentId, agentId)))
    .orderBy(desc(controlCheck.checkedAt));
  const out: StoredResult[] = [];
  for (const c of CHECKS) {
    const mine = rows.filter((r) => r.checkId === c.id);
    const latest = mine[0];
    if (!latest) continue;
    // In review since the first of the unbroken run of in-review results up to now.
    let since: Date | null = null;
    for (const r of mine) {
      if (r.result !== "in_review") break;
      since = r.checkedAt;
    }
    out.push({
      checkId: c.id,
      result: latest.result,
      found: latest.found,
      evidence: (latest.evidence ?? {}) as Record<string, unknown>,
      checkedAt: latest.checkedAt.toISOString(),
      issueId: latest.issueId,
      inReviewSince: since?.toISOString() ?? null,
    });
  }
  return out;
}

/** The issue a check in review keeps: the one its last in-review result opened, if any. */
async function openIssueFor(tx: Tx, tenantId: string, agentId: string, checkId: string) {
  const [last] = await tx
    .select({ result: controlCheck.result, issueId: controlCheck.issueId })
    .from(controlCheck)
    .where(
      and(
        eq(controlCheck.tenantId, tenantId),
        eq(controlCheck.agentId, agentId),
        eq(controlCheck.checkId, checkId),
      ),
    )
    .orderBy(desc(controlCheck.checkedAt))
    .limit(1);
  return last?.result === "in_review" ? last.issueId : null;
}

/**
 * Runs the agent's checks and stores one row per check. Returns the outcomes, or null for an agent
 * with no version. In the caller's withTenant for the agent's client.
 */
export async function runAgentChecks(
  tx: Tx,
  platform: Platform,
  env: AssuranceEnv,
  a: AgentRow,
  trigger: CheckTrigger,
  now = new Date(),
): Promise<CheckOutcome[] | null> {
  const tenantId = a.tenantId as string;
  const read = await assuranceInputFor(tx, platform, env, a, now);
  if (!read) return null;
  // §1.231.2: the stored requests and secrets are read only here, when the checks run.
  const input = env.scan
    ? {
        ...read,
        ...(await assuranceScans(tx, env.scan, tenantId, a.id, read.period, read.connections)),
      }
    : read;
  const outcomes = runAssuranceChecks(input);
  for (const o of outcomes) {
    let issueId: string | null = null;
    if (o.result === "in_review") {
      issueId = await openIssueFor(tx, tenantId, a.id, o.checkId);
      if (!issueId) {
        // DECISION (§6): the client admin sees issues as requests, so the issue says only that a
        // check is in review; what it found is on the check's row, in the back office.
        const name = checkSpec(o.checkId)?.name ?? o.checkId;
        const row = await createIssue(tx, {
          tenantId,
          title: `Security check in review: ${name}`,
          description: `A security check of ${input.sop.agent.name} found something we're looking at. We'll update this when it's verified again.`,
          agentId: a.id,
          source: "assurance",
          actor: "system",
          userId: null,
          about: { kind: "control_check", checkId: o.checkId },
          now,
        });
        issueId = row.id;
      }
    }
    await tx.insert(controlCheck).values({
      tenantId,
      agentId: a.id,
      agentVersionId: input.version.id,
      checkId: o.checkId,
      kind: o.kind,
      controls: [...o.controls],
      result: o.result,
      found: o.found.slice(0, 500),
      evidence: o.evidence,
      periodStart: o.kind === "runs" ? new Date(input.period.start) : null,
      periodEnd: o.kind === "runs" ? new Date(input.period.end) : null,
      trigger,
      issueId,
      checkedAt: now,
    });
  }
  return outcomes;
}

/** The view for one reader, with the stored results. */
export async function readAssurance(
  tx: Tx,
  platform: Platform,
  env: AssuranceEnv,
  a: AgentRow,
  audience: "client" | "ops",
  now = new Date(),
): Promise<AssuranceView | null> {
  const input = await assuranceInputFor(tx, platform, env, a, now);
  if (!input) return null;
  const stored = await storedResults(tx, a.tenantId as string, a.id);
  return assuranceView(input, stored, {
    audience,
    asOf: now.toISOString(),
    agent: { id: a.id, name: input.sop.agent.name },
  });
}

/** The nightly run: 08:23 UTC, after the night's work in the Americas (docs/agent-assurance-plan.md §6). */
export const ASSURANCE_HOUR = 8;
export const ASSURANCE_MINUTE = 23;

/**
 * Every live client agent's checks, nightly, one client at a time. A client whose checks throw is
 * reported and skipped; the others still run.
 */
export async function assuranceTick(
  db: Db,
  platform: Platform,
  env: AssuranceEnv,
  scheduledTime: Date,
): Promise<void> {
  if (scheduledTime.getUTCHours() !== ASSURANCE_HOUR) return;
  if (scheduledTime.getUTCMinutes() !== ASSURANCE_MINUTE) return;
  const clients = await db.select({ id: tenant.id, retiredAt: tenant.retiredAt }).from(tenant);
  for (const c of clients) {
    if (c.retiredAt !== null) continue;
    try {
      await withOperator(db, [c.id], async (tx) => {
        const rows = await tx
          .select()
          .from(agent)
          .where(
            and(
              eq(agent.tenantId, c.id),
              eq(agent.kind, "client"),
              eq(agent.testCopy, false),
              isNotNull(agent.liveVersionId),
            ),
          );
        for (const a of rows) await runAgentChecks(tx, platform, env, a, "nightly", scheduledTime);
      });
    } catch (error) {
      reportHandled(`assurance checks for client ${c.id} failed`, error, {
        job: "assurance",
        client: c.id,
      });
    }
  }
}
