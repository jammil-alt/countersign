// External actions over the database (ARCHITECTURE §5.1, §9.5): proposed with their inbox item in
// one transaction, unique per client by idempotency key, claimed once for execution, and resolved
// by a person through the inbox. Never deleted.

import type { JsonObject } from "@countersign/core";
import { type Db, externalAction, inboxItem, run, type Tx, withTenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { AgentsError, notFound } from "../errors";
import type { ExternalActionRecord, ExternalActionStore } from "../runtime/ports";

type Row = typeof externalAction.$inferSelect;

/** A sense the caller emits in the same transaction (apps/api passes packages/senses' emit). */
export interface EmittedEvent {
  type: string;
  subjectType: string | null;
  subjectId: string | null;
  payload: JsonObject;
}
export type Emit = (tx: Tx, tenantId: string, event: EmittedEvent) => Promise<void>;

function toRecord(row: Row): ExternalActionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    connectionId: row.connectionId,
    tool: row.tool,
    runId: row.runId,
    stepRunId: row.stepRunId,
    agentVersionId: row.agentVersionId,
    input: row.input as JsonObject,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    inboxItemId: row.inboxItemId,
    approvedBy: row.approvedBy,
    result: row.result,
    error: row.error,
    before: row.before,
    editedInput: (row.editedInput ?? null) as JsonObject | null,
  };
}

async function byId(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(externalAction)
    .where(and(eq(externalAction.id, id), eq(externalAction.tenantId, tenantId)));
  return row;
}

export function dbExternalActions(db: Db, options: { emit?: Emit } = {}): ExternalActionStore {
  const finishedEvent = async (tx: Tx, row: Row, type: string) => {
    await options.emit?.(tx, row.tenantId, {
      type,
      subjectType: "external_action",
      subjectId: row.id,
      // The shape packages/senses declares for these events (its event catalog is the contract).
      payload: {
        externalActionId: row.id,
        tool: row.tool,
        connectionId: row.connectionId,
        runId: row.runId,
        ...(type === "external_action.failed"
          ? {
              error: String(
                (row.error as { message?: unknown } | null)?.message ?? "the change failed",
              ),
            }
          : {}),
      },
    });
  };
  return {
    propose(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const [inserted] = await tx
          .insert(externalAction)
          .values({
            tenantId,
            connectionId: input.connectionId,
            tool: input.tool,
            runId: input.runId,
            stepRunId: input.stepRunId,
            agentVersionId: input.agentVersionId,
            input: input.input,
            idempotencyKey: input.idempotencyKey,
            status: input.status,
            before: (input.before ?? null) as Record<string, unknown> | null,
            ...(input.status === "approved" ? { approvedAt: new Date() } : {}),
          })
          .onConflictDoNothing({
            target: [externalAction.tenantId, externalAction.idempotencyKey],
          })
          .returning();
        if (!inserted) {
          // A retried step: the first proposal stands, whatever has happened to it since.
          const [existing] = await tx
            .select()
            .from(externalAction)
            .where(
              and(
                eq(externalAction.tenantId, tenantId),
                eq(externalAction.idempotencyKey, input.idempotencyKey),
              ),
            );
          if (!existing) throw new Error("external action vanished during propose");
          return { action: toRecord(existing), created: false };
        }
        if (!input.inbox) return { action: toRecord(inserted), created: true };
        const [item] = await tx
          .insert(inboxItem)
          .values({
            tenantId,
            kind: "external_action",
            agentId: input.inbox.agentId,
            subjectType: "external_action",
            subjectId: inserted.id,
            runId: input.runId,
            assigneeRole: input.inbox.assigneeRole,
            assigneeUserId: input.inbox.assigneeUserId,
            title: input.inbox.title,
            payload: { ...input.inbox.payload, actionId: inserted.id },
            batchKey: input.inbox.batchKey ?? null,
          })
          .returning({ id: inboxItem.id });
        if (!item) throw new Error("inbox item insert returned nothing");
        const [linked] = await tx
          .update(externalAction)
          .set({ inboxItemId: item.id })
          .where(eq(externalAction.id, inserted.id))
          .returning();
        if (!linked) throw new Error("external action update returned nothing");
        return { action: toRecord(linked), created: true };
      });
    },

    get(tenantId, actionId) {
      return withTenant(db, tenantId, async (tx) => {
        const row = await byId(tx, tenantId, actionId);
        return row ? toRecord(row) : null;
      });
    },

    byKey(tenantId, idempotencyKey) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(externalAction)
          .where(
            and(
              eq(externalAction.tenantId, tenantId),
              eq(externalAction.idempotencyKey, idempotencyKey),
            ),
          );
        return row ? toRecord(row) : null;
      });
    },

    claim(tenantId, actionId) {
      return withTenant(db, tenantId, async (tx) => {
        const [claimed] = await tx
          .update(externalAction)
          .set({ status: "executing" })
          .where(
            and(
              eq(externalAction.id, actionId),
              eq(externalAction.tenantId, tenantId),
              eq(externalAction.status, "approved"),
              // v0.12 W1-D: never inside the undo window. The database's clock decides, as it
              // does for undo and for delivery, so the three agree (ARCHITECTURE §11.1).
              sql`not exists (select 1 from ${inboxItem} where ${inboxItem.id} = ${externalAction.inboxItemId} and ${inboxItem.tenantId} = ${externalAction.tenantId} and ${inboxItem.deliverAfter} > now())`,
            ),
          )
          .returning();
        if (claimed) return { action: toRecord(claimed), claimed: true };
        const row = await byId(tx, tenantId, actionId);
        if (!row) throw notFound(`external action ${actionId}`);
        return { action: toRecord(row), claimed: false };
      });
    },

    complete(tenantId, actionId, result) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .update(externalAction)
          .set({
            status: "done",
            result: (result.output ?? null) as Record<string, unknown> | null,
            before: (result.before ?? null) as Record<string, unknown> | null,
            error: null,
            executedAt: new Date(),
          })
          .where(and(eq(externalAction.id, actionId), eq(externalAction.tenantId, tenantId)))
          .returning();
        if (!row) throw notFound(`external action ${actionId}`);
        await finishedEvent(tx, row, "external_action.done");
        return toRecord(row);
      });
    },

    fail(tenantId, actionId, error, failOptions = {}) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .update(externalAction)
          .set({ status: "failed", error: error as Record<string, unknown> })
          .where(and(eq(externalAction.id, actionId), eq(externalAction.tenantId, tenantId)))
          .returning();
        if (!row) throw notFound(`external action ${actionId}`);
        const item = failOptions.inbox;
        if (item) {
          // The operator checks what happened; the action stays failed and is never re-run.
          await tx.insert(inboxItem).values({
            tenantId,
            kind: "review",
            agentId: item.agentId,
            subjectType: "external_action",
            subjectId: row.id,
            runId: row.runId,
            assigneeRole: "operator",
            assigneeUserId: null,
            title: item.title,
            payload: { ...item.payload, actionId: row.id },
          });
        }
        await finishedEvent(tx, row, "external_action.failed");
        return toRecord(row);
      });
    },
  };
}

// ── Resolving an approval (the inbox) ────────────────────────────────────────────────────────────

export interface Approver {
  userId: string;
  role: "operator" | "client_admin" | "client_user";
  /**
   * The operator, resolving an item of the Sandbox client (`tenant.settings.sandbox`). Set only by
   * the server from the item's client, never from a request.
   */
  sandbox?: boolean;
  /**
   * v0.12 W1-D: false for a viewer (`membership.can_sign`), who signs nothing. Set only by the
   * server from the membership; absent means a signer (operators, and callers that predate it).
   */
  canSign?: boolean;
}

export interface ResolveExternalActionInput {
  tenantId: string;
  inboxItemId: string;
  decision: "approve" | "reject";
  by: Approver;
  note?: string;
  emit?: Emit;
}

export interface ResolvedExternalAction {
  actionId: string;
  inboxItemId: string;
  runId: string | null;
  status: "approved" | "rejected";
  /** False when the item was already resolved this way (a repeated click). */
  changed: boolean;
}

/** Whether this person may resolve the item: its assignee user, or someone in its assignee role. */
export function mayResolve(
  item: Pick<typeof inboxItem.$inferSelect, "assigneeUserId" | "assigneeRole">,
  by: Approver,
): boolean {
  // DECISION: the Sandbox client is the operator's own test client and has no client people, so
  // there the operator resolves every item, whoever it is assigned to (docs/plan.md §1.5). Real
  // clients are unchanged: the operator resolves only what is assigned or delegated to them.
  // v0.12 W1-D: a viewer is never an approver, whatever the item names (ARCHITECTURE §4).
  if (by.canSign === false) return false;
  if (by.role === "operator" && by.sandbox === true) return true;
  if (item.assigneeUserId) return item.assigneeUserId === by.userId;
  switch (item.assigneeRole) {
    case "operator":
      return by.role === "operator";
    case "client_user":
      return by.role === "client_admin" || by.role === "client_user";
    default:
      // client_admin (and items with no assignee) are the client admin's: the operator approves
      // only where the approval was delegated to the operator (ARCHITECTURE §4).
      return by.role === "client_admin";
  }
}

/**
 * Approves or rejects the external action behind an inbox item (what `POST /api/inbox/:id/resolve`
 * calls for kind `external_action`): the action and the item change together, the person is
 * recorded, `inbox.resolved` is emitted. Executing is separate (executeAction, in the run).
 */
export async function resolveExternalAction(
  db: Db,
  input: ResolveExternalActionInput,
): Promise<ResolvedExternalAction> {
  return withTenant(db, input.tenantId, (tx) => resolveExternalActionTx(tx, input));
}

export async function resolveExternalActionTx(
  tx: Tx,
  input: ResolveExternalActionInput,
): Promise<ResolvedExternalAction> {
  const [item] = await tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, input.inboxItemId), eq(inboxItem.tenantId, input.tenantId)))
    .for("update");
  if (!item) throw notFound(`inbox item ${input.inboxItemId}`);
  if (item.kind !== "external_action") {
    throw new AgentsError("invalid_state", `inbox item ${item.id} is a ${item.kind}`);
  }
  const [action] = await tx
    .select()
    .from(externalAction)
    .where(
      and(eq(externalAction.tenantId, input.tenantId), eq(externalAction.inboxItemId, item.id)),
    )
    .for("update");
  if (!action) throw notFound(`the external action of inbox item ${item.id}`);
  const status = input.decision === "approve" ? "approved" : "rejected";
  const result = (changed: boolean): ResolvedExternalAction => ({
    actionId: action.id,
    inboxItemId: item.id,
    runId: action.runId,
    status,
    changed,
  });
  if (item.status !== "open" || action.status !== "proposed") {
    const same =
      action.status === status ||
      (status === "approved" && ["executing", "done", "failed"].includes(action.status));
    if (same) return result(false);
    throw new AgentsError("invalid_state", `this change was already ${action.status}`);
  }
  if (action.runId) {
    const [r] = await tx.select({ mode: run.mode }).from(run).where(eq(run.id, action.runId));
    if (r?.mode === "test") throw new AgentsError("test_run", "test runs never execute changes");
  }
  if (!mayResolve(item, input.by)) {
    throw new AgentsError("not_assignee", "this approval is assigned to someone else");
  }
  const now = new Date();
  await tx
    .update(externalAction)
    .set({ status, approvedBy: input.by.userId, approvedAt: now })
    .where(eq(externalAction.id, action.id));
  const resolution = {
    decision: input.decision,
    by: input.by.userId,
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  await tx
    .update(inboxItem)
    .set({ status: "resolved", resolution, resolvedBy: input.by.userId, resolvedAt: now })
    .where(eq(inboxItem.id, item.id));
  await input.emit?.(tx, input.tenantId, {
    type: "inbox.resolved",
    subjectType: "inbox_item",
    subjectId: item.id,
    payload: {
      inboxItemId: item.id,
      kind: item.kind,
      runId: action.runId,
      approved: input.decision === "approve",
      resolvedBy: input.by.userId,
    },
  });
  return result(true);
}

// ── v0.12 W1-D: the Desk (ARCHITECTURE §11.1) ────────────────────────────────────────────────────

async function lockedAction(tx: Tx, tenantId: string, inboxItemId: string): Promise<Row> {
  const [action] = await tx
    .select()
    .from(externalAction)
    .where(
      and(eq(externalAction.tenantId, tenantId), eq(externalAction.inboxItemId, inboxItemId)),
    )
    .for("update");
  if (!action) throw notFound(`the external action of inbox item ${inboxItemId}`);
  return action;
}

/** The proposed action behind an open inbox item, locked for an edit. */
export async function proposedActionTx(
  tx: Tx,
  tenantId: string,
  inboxItemId: string,
): Promise<ExternalActionRecord> {
  const action = await lockedAction(tx, tenantId, inboxItemId);
  if (action.status !== "proposed") {
    throw new AgentsError("invalid_state", `this change was already ${action.status}`);
  }
  return toRecord(action);
}

/**
 * Stores a person's checked edit of a proposed action (checkEditedInput first): `edited_input`,
 * who and when; `input` stays the agent's version. The caller has locked the open item.
 */
export async function recordEditTx(
  tx: Tx,
  input: { tenantId: string; inboxItemId: string; edited: JsonObject; by: string; at: Date },
): Promise<ExternalActionRecord> {
  const [row] = await tx
    .update(externalAction)
    .set({ editedInput: input.edited, editedBy: input.by, editedAt: input.at })
    .where(
      and(
        eq(externalAction.tenantId, input.tenantId),
        eq(externalAction.inboxItemId, input.inboxItemId),
        eq(externalAction.status, "proposed"),
      ),
    )
    .returning();
  if (!row) throw new AgentsError("invalid_state", "this change is no longer waiting to be signed");
  return toRecord(row);
}

/**
 * Puts an approved action back to `proposed` (an undo inside its window). False when it has left
 * `approved` (claimed, executing or done): then it is too late, and nothing changes.
 */
export async function reopenApprovedTx(
  tx: Tx,
  tenantId: string,
  inboxItemId: string,
): Promise<boolean> {
  const action = await lockedAction(tx, tenantId, inboxItemId);
  if (action.status !== "approved") return false;
  await tx
    .update(externalAction)
    .set({ status: "proposed", approvedBy: null, approvedAt: null })
    .where(and(eq(externalAction.id, action.id), eq(externalAction.status, "approved")));
  return true;
}
