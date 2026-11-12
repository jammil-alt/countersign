// v0.17 O8 (ARCHITECTURE §10.15 "Changes the owner drafts", docs/plan.md §1.96): what an owner
// learns from, turned into suggestions for the operator. Once a day per client, code (no model)
// looks at the last 14 days of each area's processes:
// - the same step corrected and tried again 3 or more times (the owner's own decisions);
// - people editing the same field of the same step before signing 3 or more times.
// Each becomes one operator item in the owner's name, with the evidence (invariant 10), and the
// operator decides in the builder. Nothing changes a process on its own (§10.15: every change is
// suggested and approved). The same suggestion is not made again for 30 days.

import { changedFields, oversightFingerprint, stepPathOf } from "@countersign/core";
import {
  areaOwner,
  type Db,
  externalAction,
  inboxItem,
  oversightDecision,
  run,
  stepRun,
  withTenant,
} from "@countersign/db";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { processesOf } from "./store";

export const SIGNAL_DAYS = 14;
export const SIGNAL_MIN = 3;
export const SUGGEST_AGAIN_DAYS = 30;
export const OWNER_SUGGESTION_SUBJECT = "owner_suggestion";

export interface OwnerSignal {
  kind: "corrected" | "edited";
  agentId: string;
  /** The step, by its path in the process (a loop's index left out). */
  stepId: string;
  /** For `edited`: the field people kept changing. */
  field: string | null;
  count: number;
  /** The decisions or external actions it rests on. */
  sources: string[];
}

/** The signals of one client's processes over the last 14 days. */
export async function ownerSignals(db: Db, tenantId: string, at: Date): Promise<OwnerSignal[]> {
  const since = new Date(at.getTime() - SIGNAL_DAYS * 86_400_000);
  return withTenant(db, tenantId, async (tx) => {
    const out: OwnerSignal[] = [];
    // The owner's own corrections, step by step.
    const corrections = await tx
      .select({ id: oversightDecision.id, nodeId: oversightDecision.nodeId, agentId: run.agentId })
      .from(oversightDecision)
      .innerJoin(
        run,
        and(eq(run.id, oversightDecision.runId), eq(run.tenantId, oversightDecision.tenantId)),
      )
      .where(
        and(
          eq(oversightDecision.tenantId, tenantId),
          eq(oversightDecision.action, "retry_with"),
          eq(run.mode, "live"),
          gte(oversightDecision.createdAt, since),
        ),
      );
    const byStep = new Map<string, { agentId: string; stepId: string; ids: string[] }>();
    for (const c of corrections) {
      const stepId = stepPathOf(c.nodeId) || c.nodeId;
      const key = `${c.agentId}|${stepId}`;
      const g = byStep.get(key) ?? { agentId: c.agentId, stepId, ids: [] };
      g.ids.push(c.id);
      byStep.set(key, g);
    }
    for (const g of byStep.values()) {
      if (g.ids.length >= SIGNAL_MIN) {
        out.push({
          kind: "corrected",
          agentId: g.agentId,
          stepId: g.stepId,
          field: null,
          count: g.ids.length,
          sources: g.ids,
        });
      }
    }
    // People's edits before signing, field by field.
    const edits = await tx
      .select({
        id: externalAction.id,
        input: externalAction.input,
        edited: externalAction.editedInput,
        nodeId: stepRun.nodeId,
        agentId: run.agentId,
      })
      .from(externalAction)
      .innerJoin(
        run,
        and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)),
      )
      .innerJoin(
        stepRun,
        and(
          eq(stepRun.id, externalAction.stepRunId),
          eq(stepRun.tenantId, externalAction.tenantId),
        ),
      )
      .where(
        and(
          eq(externalAction.tenantId, tenantId),
          isNotNull(externalAction.editedAt),
          gte(externalAction.editedAt, since),
        ),
      );
    const byField = new Map<
      string,
      { agentId: string; stepId: string; field: string; ids: string[] }
    >();
    for (const e of edits) {
      const stepId = stepPathOf(e.nodeId) || e.nodeId;
      for (const field of changedFields(e.input, e.edited)) {
        const key = `${e.agentId}|${stepId}|${field}`;
        const g = byField.get(key) ?? { agentId: e.agentId, stepId, field, ids: [] };
        g.ids.push(e.id);
        byField.set(key, g);
      }
    }
    for (const g of byField.values()) {
      if (g.ids.length >= SIGNAL_MIN) {
        out.push({
          kind: "edited",
          agentId: g.agentId,
          stepId: g.stepId,
          field: g.field,
          count: g.ids.length,
          sources: g.ids,
        });
      }
    }
    return out;
  });
}

/**
 * The day's suggestions for one client: each signal becomes an operator item in its area owner's
 * name, unless the same one was suggested in the last 30 days. Returns how many were made.
 */
export async function ownerSuggestions(
  deps: { db: Db; catalog: Parameters<typeof processesOf>[2]["catalog"] },
  tenantId: string,
  at: Date,
): Promise<number> {
  const signals = await ownerSignals(deps.db, tenantId, at);
  if (signals.length === 0) return 0;
  return withTenant(deps.db, tenantId, async (tx) => {
    const processes = await processesOf(tx, tenantId, { catalog: deps.catalog });
    const owners = await tx.select().from(areaOwner).where(eq(areaOwner.tenantId, tenantId));
    let made = 0;
    for (const s of signals) {
      const p = processes.find((x) => x.agentId === s.agentId);
      const owner = owners.find((o) => o.area === p?.area);
      if (!p || !owner) continue;
      const fingerprint = oversightFingerprint({
        agentId: s.agentId,
        workflowSlug: "owner",
        nodeId: `${s.stepId}:${s.kind}:${s.field ?? ""}`,
        summary: "owner suggestion",
      });
      const since = new Date(at.getTime() - SUGGEST_AGAIN_DAYS * 86_400_000);
      const [seen] = await tx
        .select({ id: inboxItem.id })
        .from(inboxItem)
        .where(
          and(
            eq(inboxItem.tenantId, tenantId),
            eq(inboxItem.subjectType, OWNER_SUGGESTION_SUBJECT),
            sql`${inboxItem.payload}->>'fingerprint' = ${fingerprint}`,
            gte(inboxItem.createdAt, since),
          ),
        )
        .limit(1);
      if (seen) continue;
      const what =
        s.kind === "corrected"
          ? `I corrected the input of "${s.stepId}" ${s.count} times in ${SIGNAL_DAYS} days`
          : `people changed "${s.field}" in "${s.stepId}" before signing ${s.count} times in ${SIGNAL_DAYS} days`;
      await tx.insert(inboxItem).values({
        tenantId,
        kind: "review",
        agentId: s.agentId,
        subjectType: OWNER_SUGGESTION_SUBJECT,
        subjectId: s.agentId,
        assigneeRole: "operator",
        title: `${owner.name} suggests a change to ${p.name}: ${what}`.slice(0, 200),
        payload: {
          fingerprint,
          owner: { id: owner.id, name: owner.name, area: owner.area },
          signal: { ...s },
          // Every owner change is suggested and approved (owner, 2026-11-12): the operator
          // drafts it in the builder, and a change to the client's own settings goes to its admin.
          class: "process",
          sources: s.sources,
        },
      });
      made += 1;
    }
    return made;
  });
}
