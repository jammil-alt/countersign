// v0.13 W2-I: run oversight as the back office and the portal see it (ARCHITECTURE §10.11, §5.6;
// docs/plan.md §1.54). The back office's run view and the agent lab show each decision with the
// agent's note, the input change, the model and the cost; the portal's timeline shows only the
// platform's words for each decision, in the client's language (invariant 11).

import {
  changedFields,
  fieldLabel,
  findAnyStep,
  type OversightDecisionView,
  oversightLine,
  parseSkillRef,
} from "@countersign/core";
import { appUser, inboxItem, oversightDecision, stepRun, type Tx } from "@countersign/db";
import { and, asc, eq } from "drizzle-orm";
import type { Platform } from "../platform";
import { tenantLocale } from "../routes/language";

type DecisionRow = typeof oversightDecision.$inferSelect;

export function decisionView(row: DecisionRow): OversightDecisionView {
  const proposal = row.proposal as { summary?: unknown; change?: unknown } | null;
  return {
    id: row.id,
    runId: row.runId,
    stepRunId: row.stepRunId,
    nodeId: row.nodeId,
    seq: row.seq,
    cause: row.cause,
    action: row.action,
    inputBefore: row.inputBefore ?? null,
    inputAfter: row.inputAfter ?? null,
    note: row.note,
    proposal:
      proposal && typeof proposal.summary === "string"
        ? { summary: proposal.summary, change: proposal.change ?? null }
        : null,
    inboxItemId: row.inboxItemId,
    sources: Array.isArray(row.sources) ? row.sources : [],
    model: row.model,
    costUsd: row.costUsd,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    agentVersionId: row.agentVersionId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A run's decisions, oldest first, for the back office's run view. */
export async function runOversight(
  tx: Tx,
  tenantId: string,
  runId: string,
): Promise<OversightDecisionView[]> {
  const rows = await tx
    .select()
    .from(oversightDecision)
    .where(and(eq(oversightDecision.tenantId, tenantId), eq(oversightDecision.runId, runId)))
    .orderBy(asc(oversightDecision.createdAt), asc(oversightDecision.seq));
  return rows.map(decisionView);
}

/** The step a durable name stands for: its own id, or the last part inside a loop. */
function baseStepId(nodeId: string): string {
  const afterSlash = nodeId.split("/").at(-1) ?? nodeId;
  return afterSlash.split(":").at(-1) ?? afterSlash;
}

/**
 * The portal timeline's oversight lines, by step_run id: one per decision, in the platform's words
 * and the client's language. A corrected input names its field by the step's input schema (`title`,
 * else the field's name in words), never by anything the model wrote; an ask names the person.
 */
export async function timelineOversight(
  tx: Tx,
  tenantId: string,
  runId: string,
  platform: Platform,
  workflow: StepHolder | undefined,
): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({
      stepRunId: oversightDecision.stepRunId,
      nodeId: oversightDecision.nodeId,
      action: oversightDecision.action,
      inputBefore: oversightDecision.inputBefore,
      inputAfter: oversightDecision.inputAfter,
      skillRef: stepRun.skillRef,
      askedId: inboxItem.assigneeUserId,
      askedName: appUser.name,
      askedEmail: appUser.email,
      askedSubject: inboxItem.subjectType,
    })
    .from(oversightDecision)
    .innerJoin(
      stepRun,
      and(
        eq(stepRun.id, oversightDecision.stepRunId),
        eq(stepRun.tenantId, oversightDecision.tenantId),
      ),
    )
    .leftJoin(
      inboxItem,
      and(
        eq(inboxItem.id, oversightDecision.inboxItemId),
        eq(inboxItem.tenantId, oversightDecision.tenantId),
      ),
    )
    .leftJoin(appUser, eq(appUser.id, inboxItem.assigneeUserId))
    .where(and(eq(oversightDecision.tenantId, tenantId), eq(oversightDecision.runId, runId)))
    .orderBy(asc(oversightDecision.createdAt), asc(oversightDecision.seq));
  const out = new Map<string, string[]>();
  if (rows.length === 0) return out;
  const locale = await tenantLocale(tx, tenantId);
  for (const r of rows) {
    let field: string | null = null;
    if (r.action === "retry_with") {
      const changed = changedFields(r.inputBefore, r.inputAfter);
      if (changed.length === 1 && changed[0]) {
        field = fieldLabel(inputSchemaOf(r.nodeId, r.skillRef, platform, workflow), changed[0]);
      }
    }
    const askedName =
      r.action === "ask" && r.askedSubject === "oversight_ask" && r.askedId
        ? r.askedName?.trim() || (r.askedEmail?.split("@")[0] ?? null)
        : null;
    const line = oversightLine(locale, { action: r.action, field, askedName });
    out.set(r.stepRunId, [...(out.get(r.stepRunId) ?? []), line]);
  }
  return out;
}

/** A v3 workflow or a v4 process, as far as finding a step goes. */
type StepHolder = Parameters<typeof findAnyStep>[0];

/**
 * The step's input schema: its skill's (a built-in), or its tool's: a v3 action's, a v4 read's or
 * write's (wave 3b).
 */
export function inputSchemaOf(
  nodeId: string,
  skillRef: string | null,
  platform: Pick<Platform, "catalog" | "tools">,
  workflow: StepHolder | undefined,
): unknown {
  if (skillRef) return platform.catalog.get(parseSkillRef(skillRef).id)?.input ?? null;
  const step = workflow ? findAnyStep(workflow, baseStepId(nodeId)) : undefined;
  return step?.kind === "action" || step?.kind === "read" || step?.kind === "write"
    ? (platform.tools.get(step.tool)?.spec.input ?? null)
    : null;
}
