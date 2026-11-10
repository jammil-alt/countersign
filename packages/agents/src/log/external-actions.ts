// External actions over the database (ARCHITECTURE §5.1, §9.5): proposed with their inbox item in
// one transaction, unique per client by idempotency key, claimed once for execution, and resolved
// by a person through the inbox. Never deleted.

import type { JsonObject } from "@countersign/core";
import {
  type Db,
  externalAction,
  inboxItem,
  run,
  stepRun,
  type Tx,
  withTenant,
} from "@countersign/db";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
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

    // R5: a person's undo of a done write: approved by their press, no run and no agent (like a
    // signed write), under its own key. The original's id is in the key.
    // DECISION: `keepsAfter` stays unset here until external_action has an `after` column (a
    // migration in its own PR): `complete` can't keep the after state yet, so writes don't read
    // their record again, and an undo is refused as `after_unknown` (a person decides instead).
    proposeUndo(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const now = new Date();
        const [inserted] = await tx
          .insert(externalAction)
          .values({
            tenantId,
            connectionId: input.original.connectionId,
            tool: input.tool,
            runId: null,
            stepRunId: null,
            agentVersionId: null,
            input: input.input,
            idempotencyKey: input.idempotencyKey,
            status: "approved",
            approvedBy: input.approvedBy,
            approvedAt: now,
            before: (input.before ?? null) as Record<string, unknown> | null,
          })
          .onConflictDoNothing({
            target: [externalAction.tenantId, externalAction.idempotencyKey],
          })
          .returning();
        if (inserted) return { action: toRecord(inserted), created: true };
        const [existing] = await tx
          .select()
          .from(externalAction)
          .where(
            and(
              eq(externalAction.tenantId, tenantId),
              eq(externalAction.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (!existing) throw new Error("external action vanished during proposeUndo");
        return { action: toRecord(existing), created: false };
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
  // P-6: the operator steps in (docs/plan.md §1.68)
  /**
   * The operator stepping in on an item of a client they serve (`POST /api/ops/clients/:id/inbox/
   * :itemId/step-in`), with a reason recorded on the item. Set only by that route on the server,
   * never from a request body. The approval then takes the client's own path, unchanged.
   */
  steppingIn?: boolean;
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
  // P-6: the client's team runs its agents day to day; the operator oversees and may step into
  // any item of a client they serve, never as the default step (docs/plan.md §1.68).
  if (by.role === "operator" && by.steppingIn === true) return true;
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

// ── R3: a change more than one person signs (docs/plan.md §1.86) ─────────────────────────────────

type ActionItem = Pick<typeof inboxItem.$inferSelect, "id" | "kind" | "subjectType" | "subjectId">;

/** The decision stored on a resolved item (`approve` or `reject`), or null. */
function decisionOf(resolution: unknown): "approve" | "reject" | null {
  const r = resolution as { decision?: unknown; approved?: unknown } | null;
  if (r?.decision === "approve" || r?.decision === "reject") return r.decision;
  if (typeof r?.approved === "boolean") return r.approved ? "approve" : "reject";
  return null;
}

/** An approval item of this action: the gate's own, or one more signer's (same subject). */
function signsAction(action: Pick<Row, "id" | "inboxItemId">) {
  return or(
    eq(inboxItem.id, action.inboxItemId ?? action.id),
    and(eq(inboxItem.subjectType, "external_action"), eq(inboxItem.subjectId, action.id)),
  );
}

/**
 * The external action an approval item signs: the gate's own item (`external_action.inbox_item_id`)
 * or one more signer's (`AgentPort.askApprover`: kind `external_action`, its subject the action).
 * Null for any other item.
 */
export async function actionOfItemTx(
  tx: Tx,
  tenantId: string,
  item: ActionItem,
  options: { lock?: boolean } = {},
): Promise<Row | null> {
  if (item.kind !== "external_action") return null;
  const which =
    item.subjectType === "external_action" && item.subjectId
      ? or(eq(externalAction.inboxItemId, item.id), eq(externalAction.id, item.subjectId))
      : eq(externalAction.inboxItemId, item.id);
  const q = tx
    .select()
    .from(externalAction)
    .where(and(eq(externalAction.tenantId, tenantId), which))
    .limit(1);
  const [row] = options.lock ? await q.for("update") : await q;
  return row ?? null;
}

/** How many approval items of this action are still open, `except` one. */
async function openSignerItemsTx(
  tx: Tx,
  tenantId: string,
  actionId: string,
  except: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.kind, "external_action"),
        eq(inboxItem.subjectType, "external_action"),
        eq(inboxItem.subjectId, actionId),
        eq(inboxItem.status, "open"),
        ne(inboxItem.id, except),
      ),
    );
  return row?.n ?? 0;
}

/** Every approval item that signs this action, oldest (the gate's) first. */
export async function signerItemsTx(
  tx: Tx,
  tenantId: string,
  action: Pick<Row, "id" | "inboxItemId">,
): Promise<(typeof inboxItem.$inferSelect)[]> {
  return tx
    .select()
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.kind, "external_action"),
        signsAction(action),
      ),
    )
    .orderBy(asc(inboxItem.createdAt));
}

/**
 * One more approval item for a proposed change (`AgentPort.askApprover`), signing it as the gate's
 * own item does: the same card (title and payload copied from it), assigned as given, idempotent
 * per (run, `nodeId`). A change already approved on the gate's item alone goes back to
 * `proposed`: the run asked for another signature before deciding, so one signature no longer
 * stands for the change.
 */
export async function addSignerItemTx(
  tx: Tx,
  tenantId: string,
  input: {
    actionId: string;
    runId: string;
    nodeId: string;
    assigneeRole: "operator" | "client_admin" | "client_user" | null;
    assigneeUserId: string | null;
    dueAt: Date;
    remindAt?: readonly string[] | undefined;
  },
): Promise<{ id: string }> {
  const [existing] = await tx
    .select({ id: inboxItem.id })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.runId, input.runId),
        eq(inboxItem.kind, "external_action"),
        sql`${inboxItem.payload}->>'nodeId' = ${input.nodeId}`,
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [action] = await tx
    .select()
    .from(externalAction)
    .where(and(eq(externalAction.id, input.actionId), eq(externalAction.tenantId, tenantId)))
    .for("update");
  if (!action) throw notFound(`external action ${input.actionId}`);
  if (action.status !== "proposed" && action.status !== "approved") {
    throw new AgentsError("invalid_state", `this change was already ${action.status}`);
  }
  const [first] = action.inboxItemId
    ? await tx
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.id, action.inboxItemId), eq(inboxItem.tenantId, tenantId)))
    : [];
  if (!first) throw new AgentsError("invalid_state", "this change has no approval card to copy");
  if (action.status === "approved") {
    await tx
      .update(externalAction)
      .set({ status: "proposed", approvedBy: null, approvedAt: null })
      .where(and(eq(externalAction.id, action.id), eq(externalAction.status, "approved")));
  }
  const payload = (first.payload ?? {}) as JsonObject;
  const [row] = await tx
    .insert(inboxItem)
    .values({
      tenantId,
      kind: "external_action",
      agentId: first.agentId,
      subjectType: "external_action",
      subjectId: action.id,
      runId: input.runId,
      assigneeRole: input.assigneeRole,
      assigneeUserId: input.assigneeUserId,
      title: first.title,
      payload: {
        ...payload,
        actionId: action.id,
        nodeId: input.nodeId,
        // The gate's card this one signs beside.
        signsWith: first.id,
        ...(input.remindAt?.length ? { remindAt: [...input.remindAt] } : {}),
      },
      dueAt: input.dueAt,
    })
    .returning({ id: inboxItem.id });
  if (!row) throw new Error("inbox item insert returned nothing");
  return row;
}

/**
 * The run's decision on a change it asked several people (or, in time, nobody) to sign, applied
 * before it is executed: a change still `proposed` becomes `approved`, by the signer the run names
 * when their own item says yes, or by nobody (`approvedBy` null) when nobody answered and the
 * approval's `ifNoAnswer` let it proceed. False when the change wasn't left to the run (the
 * caller executes what is there, which refuses anything not approved).
 */
// DECISION: a yes the run names is checked against the signer's own item (resolved yes, outside
// any undo window, and no signer said no): the run's word alone never signs a change.
export async function approveForRunTx(
  tx: Tx,
  tenantId: string,
  input: { actionId: string; by: string | null; proceeded: boolean },
): Promise<boolean> {
  const [action] = await tx
    .select()
    .from(externalAction)
    .where(and(eq(externalAction.id, input.actionId), eq(externalAction.tenantId, tenantId)))
    .for("update");
  if (action?.status !== "proposed") return false;
  let by: string | null = null;
  if (!input.proceeded) {
    const items = await tx
      .select({
        resolvedBy: inboxItem.resolvedBy,
        resolution: inboxItem.resolution,
        held: sql<boolean>`coalesce(${inboxItem.deliverAfter} > now(), false)`,
      })
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.tenantId, tenantId),
          eq(inboxItem.kind, "external_action"),
          eq(inboxItem.status, "resolved"),
          signsAction(action),
        ),
      );
    if (items.some((i) => decisionOf(i.resolution) === "reject")) return false;
    const yes = items.filter((i) => !i.held && decisionOf(i.resolution) === "approve");
    const signer = yes.find((i) => i.resolvedBy === input.by) ?? yes[0];
    if (!signer?.resolvedBy) return false;
    by = signer.resolvedBy;
  }
  const [row] = await tx
    .update(externalAction)
    .set({ status: "approved", approvedBy: by, approvedAt: new Date() })
    .where(and(eq(externalAction.id, action.id), eq(externalAction.status, "proposed")))
    .returning({ id: externalAction.id });
  return row !== undefined;
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
  const action = await actionOfItemTx(tx, input.tenantId, item, { lock: true });
  if (!action) throw notFound(`the external action of inbox item ${item.id}`);
  const status = input.decision === "approve" ? "approved" : "rejected";
  const result = (changed: boolean): ResolvedExternalAction => ({
    actionId: action.id,
    inboxItemId: item.id,
    runId: action.runId,
    status,
    changed,
  });
  // R3: one more signer's item (`AgentPort.askApprover`) already answered: a repeated click is
  // read from the item itself, since the change may still wait on the other signers.
  if (
    item.status === "resolved" &&
    (action.inboxItemId !== item.id || action.status === "proposed")
  ) {
    if (decisionOf(item.resolution) === input.decision) return result(false);
    throw new AgentsError("invalid_state", "this approval was already answered");
  }
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
  // R3 (docs/plan.md §1.86): a change several people sign (an approval in mode `all` or `any`)
  // has one item each. A yes while another signer's item is still open records that signature on
  // its item and leaves the change proposed: the run decides once it has the answers it needs,
  // and approves the change then (`approveForRunTx`). A no rejects the change at once.
  // DECISION: the change is approved by the last open signer's yes, never by the first, so a
  // change that needs everyone is never `approved` (or carried by a retry) on one signature.
  const waitsOnOthers =
    status === "approved" && (await openSignerItemsTx(tx, input.tenantId, action.id, item.id)) > 0;
  if (!waitsOnOthers) {
    await tx
      .update(externalAction)
      .set({ status, approvedBy: input.by.userId, approvedAt: now })
      .where(eq(externalAction.id, action.id));
  }
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
  const [item] = await tx
    .select({
      id: inboxItem.id,
      kind: inboxItem.kind,
      subjectType: inboxItem.subjectType,
      subjectId: inboxItem.subjectId,
    })
    .from(inboxItem)
    .where(and(eq(inboxItem.id, inboxItemId), eq(inboxItem.tenantId, tenantId)));
  // R3: a signer's own item (askApprover) signs the change it names, as the gate's item does.
  const action = item ? await actionOfItemTx(tx, tenantId, item, { lock: true }) : null;
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
  // R3: a signer's yes that left the change proposed (another signer's item still open): nothing
  // has started, and there is nothing on the change to take back.
  if (action.status === "proposed") return true;
  if (action.status !== "approved") return false;
  await tx
    .update(externalAction)
    .set({ status: "proposed", approvedBy: null, approvedAt: null })
    .where(and(eq(externalAction.id, action.id), eq(externalAction.status, "approved")));
  return true;
}

// ── R5: an answer after the run went ahead (docs/plan.md §1.86, §9) ──────────────────────────────

type ItemRow = typeof inboxItem.$inferSelect;

/** A write that went ahead without this item's answer (`ifNoAnswer: proceed`). */
export interface ProceededWrite {
  /** The step the executor marked `proceededWithoutAnswer`; null when found by the action alone. */
  stepRunId: string | null;
  nodeId: string | null;
  /** The write that went ahead, when there is one. */
  action: ExternalActionRecord | null;
}

/**
 * Whether the run went ahead without this item's answer: the executor's step_run, whose output
 * says `proceededWithoutAnswer: true` and names the item (`inboxItemId` or `inboxItemIds`) or its
 * write (`externalActionId`), or, for an approval of a change, the change itself no longer waiting
 * though nobody signed it while the item is still open.
 */
// DECISION: the step_run's output is the contract with the executor (R3); the action's own state
// is the fallback, since an open item whose change has gone ahead unsigned can only have been
// passed by a deadline.
export async function proceededWriteTx(
  tx: Tx,
  tenantId: string,
  item: Pick<ItemRow, "id" | "runId" | "kind" | "status" | "subjectType" | "subjectId">,
): Promise<ProceededWrite | null> {
  if (!item.runId || item.status === "resolved") return null;
  // R3: the gate's item, or one more signer's (askApprover), names the change it signs.
  const own = (await actionOfItemTx(tx, tenantId, item)) ?? undefined;
  const output = sql`${stepRun.output}`;
  const [marked] = await tx
    .select({ id: stepRun.id, nodeId: stepRun.nodeId, output: stepRun.output })
    .from(stepRun)
    .where(
      and(
        eq(stepRun.tenantId, tenantId),
        eq(stepRun.runId, item.runId),
        sql`${output}->>'proceededWithoutAnswer' = 'true'`,
        or(
          sql`${output}->>'inboxItemId' = ${item.id}`,
          sql`jsonb_typeof(${output}->'inboxItemIds') = 'array' and jsonb_exists(${output}->'inboxItemIds', ${item.id})`,
          ...(own ? [sql`${output}->>'externalActionId' = ${own.id}`] : []),
        ),
      ),
    )
    .limit(1);
  if (marked) {
    const named = (marked.output as { externalActionId?: unknown } | null)?.externalActionId;
    const actionId = typeof named === "string" ? named : (own?.id ?? null);
    const row =
      actionId === own?.id ? own : actionId ? await byId(tx, tenantId, actionId) : undefined;
    return { stepRunId: marked.id, nodeId: marked.nodeId, action: row ? toRecord(row) : null };
  }
  if (own && !own.approvedBy && ["approved", "executing", "done", "failed"].includes(own.status)) {
    return { stepRunId: own.stepRunId, nodeId: null, action: toRecord(own) };
  }
  return null;
}

export interface LateAnswerInput {
  tenantId: string;
  /** The item, locked by the caller. */
  item: ItemRow;
  proceeded: ProceededWrite;
  decision?: "approve" | "reject" | undefined;
  /** What the answer means: a yes, or a no (a reject; for a question, a decline). */
  approved: boolean;
  answer?: unknown;
  note?: string | undefined;
  by: Approver;
  emit?: Emit;
}

export interface LateAnswer {
  approved: boolean;
  at: Date;
  /** The write that went ahead, as it stands; null when the step wrote nothing. */
  action: ExternalActionRecord | null;
}

/**
 * Records an answer that came after the run went ahead without it (R5): the item is resolved with
 * who answered, when, and that it was late; the write's own record is left as it is (it ran, or
 * failed, on its own); the run is not told (it isn't waiting), so the item is marked received;
 * `inbox.resolved` is emitted. A late no is never applied by itself: an undo is offered (by the
 * caller), and only a person's press runs it.
 */
export async function resolveLateAnswerTx(tx: Tx, input: LateAnswerInput): Promise<LateAnswer> {
  const { item, proceeded, by } = input;
  if (!mayResolve(item, by)) {
    throw new AgentsError("not_assignee", "this approval is assigned to someone else");
  }
  const at = new Date();
  const action = proceeded.action;
  const resolution = {
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    approved: input.approved,
    answer: (input.answer ?? null) as JsonObject[string],
    by: by.userId,
    ...(input.note === undefined ? {} : { note: input.note }),
    late: {
      proceededWithoutAnswer: true,
      externalActionId: action?.id ?? null,
      actionStatus: action?.status ?? null,
      stepRunId: proceeded.stepRunId,
    },
  };
  await tx
    .update(inboxItem)
    .set({
      status: "resolved",
      resolution,
      resolvedBy: by.userId,
      resolvedAt: at,
      // The run went ahead and waits for nothing here: nothing is delivered to it.
      runReceivedAt: at,
    })
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, input.tenantId)));
  await input.emit?.(tx, input.tenantId, {
    type: "inbox.resolved",
    subjectType: "inbox_item",
    subjectId: item.id,
    payload: {
      inboxItemId: item.id,
      kind: item.kind,
      runId: item.runId,
      approved: input.approved,
      resolvedBy: by.userId,
    },
  });
  return { approved: input.approved, at, action };
}
