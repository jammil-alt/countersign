// v0.13 W2-I: run oversight's rows (ARCHITECTURE §5.6, §10.11; docs/plan.md §1.54). Each decision is
// one `oversight_decision` row (insert only), written with the items it opens in one transaction:
// an ask (an `approval` item to the step's approver, else the client's team (P-6), subject
// `oversight_ask`), a proposal for the operator (a `review` item, subject `oversight_proposal`,
// made once per fingerprint while open) and a stop the operator must check (a write that reached
// the client's tool). Every read and write is scoped to the run's own client (invariant 1).

import {
  agent,
  type Db,
  externalAction,
  inboxItem,
  OVERSIGHT_ACTIONS,
  OVERSIGHT_CAUSES,
  oversightDecision,
  run,
  stepRun,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { clientApproverSetting } from "../registry/runtime-store";
import { resolveApprover } from "../runtime/context";
import type {
  DecisionRecord,
  OversightContext,
  OversightStore,
  RecordedDecision,
} from "../runtime/oversee";

/** Where a proposal's fingerprint lives in its item's payload (as findings', §1.28). */
export const OVERSIGHT_FINGERPRINT_KEY = "fingerprint";
export const OVERSIGHT_ASK_SUBJECT = "oversight_ask";
export const OVERSIGHT_PROPOSAL_SUBJECT = "oversight_proposal";
export const OVERSIGHT_STOP_SUBJECT = "oversight_stop";

type Row = typeof oversightDecision.$inferSelect;

const isReviewAction = (action: string): action is RecordedDecision["action"] =>
  (OVERSIGHT_ACTIONS as readonly string[]).includes(action);

/** A review's decision (v0.17: the table also keeps the agent's choices, read elsewhere). */
function recorded(row: Row): RecordedDecision {
  if (!isReviewAction(row.action)) {
    throw new Error(`oversight_decision ${row.id} is a choice (${row.action}), not a review`);
  }
  return {
    id: row.id,
    action: row.action,
    note: row.note,
    inputAfter: row.inputAfter ?? null,
    inboxItemId: row.inboxItemId,
  };
}

/** The proposal's item: the open one with its fingerprint, else a new one. */
async function proposalItem(
  tx: Tx,
  tenantId: string,
  agentId: string,
  runId: string,
  item: NonNullable<DecisionRecord["proposalItem"]>,
): Promise<string> {
  // One proposal at a time per fingerprint: two runs failing at once can't both open one.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`oversight:${tenantId}:${item.fingerprint}`}))`,
  );
  const [open] = await tx
    .select({ id: inboxItem.id })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.status, "open"),
        eq(inboxItem.subjectType, OVERSIGHT_PROPOSAL_SUBJECT),
        sql`${inboxItem.payload}->>${OVERSIGHT_FINGERPRINT_KEY} = ${item.fingerprint}`,
      ),
    )
    .limit(1);
  if (open) return open.id;
  const [row] = await tx
    .insert(inboxItem)
    .values({
      tenantId,
      kind: "review",
      agentId,
      subjectType: OVERSIGHT_PROPOSAL_SUBJECT,
      subjectId: runId,
      runId,
      assigneeRole: "operator",
      assigneeUserId: null,
      title: item.title,
      payload: { ...item.payload, [OVERSIGHT_FINGERPRINT_KEY]: item.fingerprint },
    })
    .returning({ id: inboxItem.id });
  if (!row) throw new Error("proposal insert returned nothing");
  return row.id;
}

export function dbOversightStore(db: Db): OversightStore {
  return {
    // R6 (docs/plan.md §1.86): the owner's watch compares a total with this agent's earlier ones:
    // its live runs' succeeded steps of the same workflow, newest first, this client only.
    recentOutputs(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ nodeId: stepRun.nodeId, output: stepRun.output })
          .from(stepRun)
          .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
          .where(
            and(
              eq(stepRun.tenantId, tenantId),
              eq(run.tenantId, tenantId),
              eq(run.agentId, input.agentId),
              eq(run.workflowSlug, input.workflowSlug),
              eq(run.mode, "live"),
              eq(stepRun.status, "succeeded"),
            ),
          )
          .orderBy(desc(stepRun.finishedAt))
          .limit(input.limit);
        return rows.map((r) => ({ nodeId: r.nodeId, output: r.output ?? null }));
      });
    },
    existing(tenantId, key) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(oversightDecision)
          .where(
            and(
              eq(oversightDecision.tenantId, tenantId),
              eq(oversightDecision.runId, key.runId),
              eq(oversightDecision.nodeId, key.nodeId),
              eq(oversightDecision.seq, key.seq),
              inArray(oversightDecision.cause, [...OVERSIGHT_CAUSES]),
            ),
          );
        return row ? recorded(row) : null;
      });
    },

    runTotals(tenantId, runId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({
            // v0.13 M32: a `continue` changes nothing, so it is not an intervention (its cost
            // still counts).
            // v0.17: the agent's choices count in the cost, never as interventions.
            count: sql<number>`(count(*) filter (where ${oversightDecision.action} <> 'continue' and ${inArray(oversightDecision.cause, [...OVERSIGHT_CAUSES])}))::int`,
            costUsd: sql<string>`coalesce(sum(${oversightDecision.costUsd}), 0)::text`,
          })
          .from(oversightDecision)
          .where(and(eq(oversightDecision.tenantId, tenantId), eq(oversightDecision.runId, runId)));
        return { count: row?.count ?? 0, costUsd: row?.costUsd ?? "0" };
      });
    },

    stepActions(tenantId, stepRunId) {
      return withTenant(db, tenantId, (tx) =>
        tx
          .select({
            id: externalAction.id,
            status: externalAction.status,
            error: externalAction.error,
          })
          .from(externalAction)
          .where(
            and(eq(externalAction.tenantId, tenantId), eq(externalAction.stepRunId, stepRunId)),
          ),
      );
    },

    context(tenantId, input): Promise<OversightContext> {
      return withTenant(db, tenantId, async (tx) => {
        const earlier = await tx
          .select({ nodeId: stepRun.nodeId, status: stepRun.status, summary: stepRun.summary })
          .from(stepRun)
          .where(
            and(
              eq(stepRun.tenantId, tenantId),
              eq(stepRun.runId, input.runId),
              ne(stepRun.id, input.stepRunId),
            ),
          )
          .orderBy(stepRun.startedAt, stepRun.id)
          .limit(50);
        // DECISION: "the last 5 failures of the same step" are this step's last 5 decisions in the
        // agent's other runs, each with what was decided: a failure nobody reviewed has nothing
        // to learn from, and an older run's step row no longer holds its error once retried.
        const history = await tx
          .select({
            runId: oversightDecision.runId,
            action: oversightDecision.action,
            note: oversightDecision.note,
            createdAt: oversightDecision.createdAt,
          })
          .from(oversightDecision)
          .innerJoin(
            run,
            and(eq(run.id, oversightDecision.runId), eq(run.tenantId, oversightDecision.tenantId)),
          )
          .where(
            and(
              eq(oversightDecision.tenantId, tenantId),
              eq(run.agentId, input.agentId),
              eq(oversightDecision.nodeId, input.nodeId),
              ne(oversightDecision.runId, input.runId),
              inArray(oversightDecision.cause, [...OVERSIGHT_CAUSES]),
            ),
          )
          .orderBy(desc(oversightDecision.createdAt))
          .limit(5);
        return {
          earlier,
          history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
        };
      });
    },

    record(tenantId, d) {
      return withTenant(db, tenantId, async (tx) => {
        let askId: string | null = null;
        if (d.ask) {
          // DECISION: a test run's ask goes to the operator, like its person steps (§10.4).
          // P-6 (owner, 2026-11-08; docs/plan.md §1.68): a live one goes to the client's team,
          // never to us by default: the step's approver, else the agent's (the client agent's
          // override), else the client's approvals setting, else the client admin. It reaches the
          // operator only where the client's approvals are set to us.
          let assignee: {
            assigneeRole: "operator" | "client_admin" | "client_user" | null;
            assigneeUserId: string | null;
          };
          if (d.ask.test) assignee = { assigneeRole: "operator", assigneeUserId: null };
          else {
            const [a] = await tx
              .select({ approver: agent.approver })
              .from(agent)
              .where(and(eq(agent.id, d.agentId), eq(agent.tenantId, tenantId)));
            const [t] = await tx
              .select({ settings: tenant.settings })
              .from(tenant)
              .where(eq(tenant.id, tenantId));
            assignee = resolveApprover([
              d.ask.approver,
              a?.approver,
              clientApproverSetting(t?.settings ?? {}),
            ]);
          }
          const [row] = await tx
            .insert(inboxItem)
            .values({
              tenantId,
              kind: "approval",
              agentId: d.agentId,
              subjectType: OVERSIGHT_ASK_SUBJECT,
              subjectId: d.runId,
              runId: d.runId,
              ...assignee,
              title: d.ask.title,
              // No error text, note or model here: the item may be the client's (invariant 11).
              payload: {
                mode: "approve",
                question: d.ask.question,
                step: d.ask.stepLabel,
                oversight: { nodeId: d.nodeId, seq: d.seq },
                ...(d.ask.test ? { testRun: true } : {}),
              },
              dueAt: d.ask.dueAt,
            })
            .returning({ id: inboxItem.id });
          askId = row?.id ?? null;
        }
        let stopId: string | null = null;
        if (d.operatorItem) {
          const [row] = await tx
            .insert(inboxItem)
            .values({
              tenantId,
              kind: "review",
              agentId: d.agentId,
              subjectType: OVERSIGHT_STOP_SUBJECT,
              subjectId: d.runId,
              runId: d.runId,
              assigneeRole: "operator",
              assigneeUserId: null,
              title: d.operatorItem.title.slice(0, 200),
              payload: d.operatorItem.payload,
            })
            .returning({ id: inboxItem.id });
          stopId = row?.id ?? null;
        }
        const proposalId = d.proposalItem
          ? await proposalItem(tx, tenantId, d.agentId, d.runId, d.proposalItem)
          : null;
        const [row] = await tx
          .insert(oversightDecision)
          .values({
            tenantId,
            runId: d.runId,
            stepRunId: d.stepRunId,
            nodeId: d.nodeId,
            seq: d.seq,
            cause: d.cause,
            action: d.action,
            inputBefore: d.action === "retry_with" ? (d.inputBefore ?? null) : null,
            inputAfter: d.action === "retry_with" ? d.inputAfter : null,
            note: d.note,
            proposal: d.proposal,
            inboxItemId: askId ?? stopId ?? proposalId,
            sources: d.sources,
            model: d.model,
            costUsd: d.costUsd,
            tokensIn: d.tokensIn,
            tokensOut: d.tokensOut,
            agentVersionId: d.agentVersionId,
          })
          .returning();
        if (!row) throw new Error("oversight_decision insert returned nothing");
        return recorded(row);
      });
    },
  };
}
