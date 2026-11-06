// v0.12 W2-F: what a question cost (ARCHITECTURE §11.6; docs/plan.md §1.49). A portal question is
// the client's usage under its account agent (Sloan): recorded as one of Sloan's test runs with one
// step carrying the call's tokens and cost, then rolled up into usage_daily like any run. Without
// an account agent, and for the back office's questions, the cost is the operator's: logged only.

import { rollupUsageForRun } from "@countersign/agents";
import { ACCOUNT_AGENT_SLUG, type RunFilter } from "@countersign/core";
import { agent, agentVersion, run, stepRun, type Tx } from "@countersign/db";
import type { LlmCallRecord } from "@countersign/llm";
import { and, desc, eq } from "drizzle-orm";

/** `run.workflow_slug` of a question's run: it runs no workflow. */
export const ASK_RUN_WORKFLOW = "runs.ask";

/** The account agent's version a question's run is pinned to: its live one, else its latest. */
async function accountAgent(tx: Tx, tenantId: string) {
  const [a] = await tx
    .select({ id: agent.id, liveVersionId: agent.liveVersionId })
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.slug, ACCOUNT_AGENT_SLUG),
      ),
    );
  if (!a) return null;
  if (a.liveVersionId) return { agentId: a.id, versionId: a.liveVersionId };
  const [v] = await tx
    .select({ id: agentVersion.id })
    .from(agentVersion)
    .where(and(eq(agentVersion.agentId, a.id), eq(agentVersion.tenantId, tenantId)))
    .orderBy(desc(agentVersion.version))
    .limit(1);
  return v ? { agentId: a.id, versionId: v.id } : null;
}

export interface AskUsage {
  surface: "portal" | "ops";
  /** The portal's client; null for the back office. */
  tenantId: string | null;
  userId: string;
  question: string;
  record: LlmCallRecord;
  filter: RunFilter | null;
  refused: string | null;
}

function logOperatorCost(u: AskUsage, why: string) {
  console.info(
    JSON.stringify({
      event: "runs.ask.cost",
      who: "operator",
      why,
      surface: u.surface,
      tenantId: u.tenantId,
      model: u.record.model,
      tokensIn: u.record.usage.inputTokens,
      tokensOut: u.record.usage.outputTokens,
      costUsd: u.record.costUsd,
    }),
  );
}

/**
 * Records a question's model call: as the client's usage under Sloan (a portal question of a
 * client that has one), else logged as the operator's. Returns the run it wrote, if any.
 */
// DECISION: the question's run is a test run of the account agent (never shown in the portal, as
// agents' asks are, ARCHITECTURE §10.4), `succeeded` whether or not the answer was usable (the
// step's output says which), so refused questions don't read as failures; the step keeps the
// question as data and the filter it became.
// DECISION: the back office's questions are the operator's own cost, never a client's, even when
// asked about one client: the client didn't ask.
export async function recordAskUsage(tx: Tx, u: AskUsage): Promise<string | null> {
  if (u.surface === "ops" || !u.tenantId) {
    logOperatorCost(u, "back office question");
    return null;
  }
  const sloan = await accountAgent(tx, u.tenantId);
  if (!sloan) {
    logOperatorCost(u, "no account agent");
    return null;
  }
  const now = new Date();
  const cost = u.record.costUsd ?? "0";
  const [r] = await tx
    .insert(run)
    .values({
      tenantId: u.tenantId,
      agentId: sloan.agentId,
      agentVersionId: sloan.versionId,
      workflowSlug: ASK_RUN_WORKFLOW,
      mode: "test",
      trigger: { type: "question", surface: u.surface, askedBy: u.userId },
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      costUsd: cost,
    })
    .returning({ id: run.id });
  if (!r) throw new Error("run insert returned nothing");
  await tx.insert(stepRun).values({
    tenantId: u.tenantId,
    runId: r.id,
    nodeId: "question",
    nodeType: "question",
    agentVersionId: sloan.versionId,
    input: { question: u.question },
    output: u.filter ? { filter: u.filter } : { refused: u.refused ?? "not understood" },
    status: "succeeded",
    attempts: 1,
    costUsd: cost,
    tokensIn: u.record.usage.inputTokens,
    tokensOut: u.record.usage.outputTokens,
    startedAt: now,
    finishedAt: now,
  });
  await rollupUsageForRun(tx, { tenantId: u.tenantId, runId: r.id, now });
  return r.id;
}
