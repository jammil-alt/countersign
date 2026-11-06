// The Desk (ARCHITECTURE §11.1, §4; docs/plan.md §1.39): snooze, edit before signing, sign part of
// a batch, undo inside the window, and who signs what. Every function runs in the request's
// transaction for one client; changes to a client's tool still happen only through the external
// action path (invariant 8): an edit is stored beside the agent's input and re-checked, an undo
// puts the action back to `proposed` before it can be claimed.

import {
  type Approver,
  checkEditedInput,
  clientApproverSetting,
  mayResolve,
  proposedActionTx,
  type RuntimeDeps,
  recordEditTx,
  reopenApprovedTx,
} from "@countersign/agents";
import {
  type ApproverRule,
  type BatchResolveBody,
  changeFacts,
  DESK_WORDS,
  type DeskItemState,
  findStep,
  isPlainObject,
  type JsonObject,
  type Locale,
  pickLocalized,
  readApproverRuleSet,
  routeApproval,
  snoozeUntil,
  type TeamMember,
  undoSecondsOf,
  withUndoSeconds,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  inboxItem,
  membership,
  run,
  type Tx,
  tenant,
  tenantChange,
} from "@countersign/db";
import type { EventRow, EventTypeRegistry } from "@countersign/senses";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HttpError, iso, notFound } from "../http";
import { type InboxRow, type ResolveOutcome, resolveInboxItem, withCanSign } from "../inbox";
import type { Platform } from "../platform";

/** How much of the undo window must be left for an undo to start: it commits well before the end. */
// DECISION: an undo needs two seconds of window left, measured on the database's clock, so it has
// committed before the cron (which delivers at `deliver_after`, also on the database's clock) can
// read the item: a run is never told of an approval that is then undone.
export const UNDO_MARGIN_SECONDS = 2;

export function deskState(row: InboxRow): DeskItemState {
  return {
    id: row.id,
    status: row.status as DeskItemState["status"],
    deliverAfter: iso(row.deliverAfter),
    snoozedUntil: iso(row.snoozedUntil),
    batchKey: row.batchKey,
    resolvedAt: iso(row.resolvedAt),
  };
}

async function lockItem(tx: Tx, tenantId: string, itemId: string): Promise<InboxRow> {
  const [item] = await tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, itemId), eq(inboxItem.tenantId, tenantId)))
    .for("update");
  if (!item) throw notFound("inbox item");
  return item;
}

/** A signer, or 403 `cannot_sign` for a viewer. */
async function signer(tx: Tx, tenantId: string, by: Approver): Promise<Approver> {
  const who = await withCanSign(tx, tenantId, by);
  if (who.canSign === false) {
    throw new HttpError(403, "cannot_sign", "you can see this, but you don't sign for your team");
  }
  return who;
}

// ── Snooze ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Not now: an open item leaves "Waiting on you" until `until`, by its assignee, or the client admin
 * for an item routed to a role. Never moves the step's timeout; cut to an hour before the due time.
 */
export async function snoozeItem(
  tx: Tx,
  input: { tenantId: string; itemId: string; by: Approver; until: Date; now: Date },
): Promise<InboxRow> {
  const by = await signer(tx, input.tenantId, input.by);
  const item = await lockItem(tx, input.tenantId, input.itemId);
  if (item.status !== "open") throw new HttpError(409, "not_open", "only waiting items snooze");
  const roleItem = item.assigneeUserId === null;
  if (!mayResolve(item, by) && !(roleItem && by.role === "client_admin")) {
    throw new HttpError(403, "not_assignee", "this item is assigned to someone else");
  }
  const result = snoozeUntil({ until: input.until, now: input.now, dueAt: item.dueAt });
  if (!result.ok) {
    throw new HttpError(result.code === "due_soon" ? 409 : 422, result.code, result.message);
  }
  const [row] = await tx
    .update(inboxItem)
    .set({ snoozedUntil: result.until, snoozedBy: by.userId })
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, input.tenantId)))
    .returning();
  if (!row) throw notFound("inbox item");
  return row;
}

// ── Undo ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Takes back an approval inside its undo window: the item is open again, its change back to
 * `proposed`, and `{undoneAt, by}` is added to `payload.undos`. The run, still waiting on the
 * item's event, never knew. By the person who signed, or the client admin. 409 `too_late` once the
 * window has passed or the change was claimed.
 */
export async function undoItem(
  tx: Tx,
  input: { tenantId: string; itemId: string; by: Approver },
): Promise<InboxRow> {
  const item = await lockItem(tx, input.tenantId, input.itemId);
  const own = item.resolvedBy === input.by.userId;
  if (!own && input.by.role !== "client_admin") {
    throw new HttpError(
      403,
      "not_signer",
      "only the person who signed, or the client admin, can undo",
    );
  }
  const [live] = await tx
    .select({
      open: sql<boolean>`coalesce(${inboxItem.deliverAfter} > clock_timestamp() + make_interval(secs => ${UNDO_MARGIN_SECONDS}::double precision), false)`,
    })
    .from(inboxItem)
    .where(eq(inboxItem.id, item.id));
  if (item.status !== "resolved" || !live?.open) {
    throw new HttpError(409, "too_late", "the undo window has passed");
  }
  // The change goes back to proposed before anything can claim it (the claim skips items inside
  // their window, and the window is still open).
  if (item.kind === "external_action" && !(await reopenApprovedTx(tx, input.tenantId, item.id))) {
    throw new HttpError(409, "too_late", "the change has already started");
  }
  const payload = isPlainObject(item.payload) ? item.payload : {};
  const undos = Array.isArray(payload.undos) ? payload.undos : [];
  const [row] = await tx
    .update(inboxItem)
    .set({
      status: "open",
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      deliverAfter: null,
      runReceivedAt: null,
      payload: {
        ...payload,
        undos: [...undos, { undoneAt: new Date().toISOString(), by: input.by.userId }],
      },
    })
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, input.tenantId)))
    .returning();
  if (!row) throw notFound("inbox item");
  return row;
}

// ── Edit before signing ──────────────────────────────────────────────────────────────────────────

/** Who the approver rules (and the step, agent and client) would send this change to now. */
async function routeFor(
  tx: Tx,
  platform: Platform,
  input: {
    tenantId: string;
    item: InboxRow;
    toolId: string;
    runId: string | null;
    edited: unknown;
  },
) {
  const tool = platform.tools.get(input.toolId);
  if (tool?.kind !== "connector") return null;
  const [r] = input.runId
    ? await tx
        .select({ agentId: run.agentId, versionId: run.agentVersionId, slug: run.workflowSlug })
        .from(run)
        .where(and(eq(run.id, input.runId), eq(run.tenantId, input.tenantId)))
    : [];
  if (!r) return null;
  const [a] = await tx
    .select({ approver: agent.approver })
    .from(agent)
    .where(and(eq(agent.id, r.agentId), eq(agent.tenantId, input.tenantId)));
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(and(eq(agentVersion.id, r.versionId), eq(agentVersion.tenantId, input.tenantId)));
  const payload = isPlainObject(input.item.payload) ? input.item.payload : {};
  const leaf = typeof payload.stepId === "string" ? (payload.stepId.split(":").at(-1) ?? "") : "";
  const workflow = v?.bundle.workflows.find((w) => w.slug === r.slug)?.workflow;
  const step = workflow ? findStep(workflow, leaf)?.step : undefined;
  const stepApprover =
    step && (step.kind === "skill" || step.kind === "action") ? step.approval?.approver : undefined;
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, input.tenantId));
  const settings = t?.settings ?? {};
  const signers = await tx
    .select({ userId: membership.userId })
    .from(membership)
    .where(
      and(
        eq(membership.tenantId, input.tenantId),
        inArray(membership.role, ["client_admin", "client_user"]),
        eq(membership.canSign, true),
      ),
    );
  return routeApproval({
    rules: readApproverRuleSet(settings).rules,
    facts: changeFacts({
      spec: tool.spec,
      connector: tool.connector.manifest.id,
      agentId: r.agentId,
      input: input.edited,
    }),
    step: stepApprover,
    agent: [v?.bundle.definition.permissions.approver, a?.approver],
    client: clientApproverSetting(settings),
    members: new Set(signers.map((s) => s.userId)),
  });
}

/**
 * Edits a drafted change before it is signed. Only the tool's editable fields may differ; the
 * edit is validated by the tool's input schema, the connector's proposal checks and the gate run
 * again (checkEditedInput), and the approver rules route it again: 409 `reroute` when it would go
 * to someone else. `external_action.input` stays the agent's; `edited_input` holds the person's,
 * and execution uses it. The item's payload keeps `edited` for the card (both versions show).
 */
// DECISION: the edit also lands on the item's payload as `edited: {input, by, at}` (a copy of the
// action's `edited_input`), so today's approval card shows both versions without a join; the
// action's column is what executes.
export async function editItem(
  tx: Tx,
  runtime: RuntimeDeps,
  platform: Platform,
  input: { tenantId: string; itemId: string; by: Approver; edited: JsonObject },
): Promise<{ row: InboxRow; edited: JsonObject; at: Date }> {
  const by = await signer(tx, input.tenantId, input.by);
  const item = await lockItem(tx, input.tenantId, input.itemId);
  if (item.kind !== "external_action") {
    throw new HttpError(409, "not_a_change", "only a drafted change can be edited");
  }
  if (item.status !== "open") {
    throw new HttpError(409, "already_resolved", "this change was already signed or rejected");
  }
  if (!mayResolve(item, by)) {
    throw new HttpError(403, "not_assignee", "this item is assigned to someone else");
  }
  const action = await proposedActionTx(tx, input.tenantId, item.id);
  const checked = await checkEditedInput(runtime, {
    tenantId: input.tenantId,
    action,
    edited: input.edited,
  });
  if (!checked.ok) {
    throw new HttpError(checked.code === "refused" ? 409 : 422, checked.code, checked.message);
  }
  const route = await routeFor(tx, platform, {
    tenantId: input.tenantId,
    item,
    toolId: action.tool,
    runId: action.runId,
    edited: checked.input,
  });
  if (
    !route ||
    route.assignee.assigneeRole !== item.assigneeRole ||
    route.assignee.assigneeUserId !== item.assigneeUserId
  ) {
    throw new HttpError(
      409,
      "reroute",
      "with this edit the change would go to someone else to sign; reject it and ask instead",
    );
  }
  const at = new Date();
  await recordEditTx(tx, {
    tenantId: input.tenantId,
    inboxItemId: item.id,
    edited: checked.input,
    by: by.userId,
    at,
  });
  const payload = isPlainObject(item.payload) ? item.payload : {};
  const [row] = await tx
    .update(inboxItem)
    .set({
      payload: {
        ...payload,
        edited: { input: checked.input, by: by.userId, at: at.toISOString() },
      },
    })
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, input.tenantId)))
    .returning();
  if (!row) throw notFound("inbox item");
  return { row, edited: checked.input, at };
}

// ── Batches ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Signs part of a batch: each named item (all of the same `batch_key`, each visible to the person)
 * is resolved with the normal resolve code, in the request's one transaction: all of them or none.
 * Items not named stay open. Each change keeps its own idempotency key.
 */
export async function resolveBatch(
  tx: Tx,
  input: {
    tenantId: string;
    by: Approver;
    body: BatchResolveBody;
    /** The items this person may see (the portal's filter), as a check on each named id. */
    visible: (ids: string[]) => Promise<Set<string>>;
    registry: EventTypeRegistry;
    collect: EventRow[];
  },
): Promise<ResolveOutcome[]> {
  const approve = input.body.approve ?? [];
  const reject = input.body.reject ?? [];
  const ids = [...approve, ...reject];
  const rows = await tx
    .select({ id: inboxItem.id, batchKey: inboxItem.batchKey })
    .from(inboxItem)
    .where(and(eq(inboxItem.tenantId, input.tenantId), inArray(inboxItem.id, ids)));
  const seen = await input.visible(ids);
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row || !seen.has(id)) throw notFound("inbox item");
    if (row.batchKey !== input.body.batchKey) {
      throw new HttpError(422, "not_in_batch", "every item must be from the same batch");
    }
  }
  const outcomes: ResolveOutcome[] = [];
  // In a fixed order, so two people signing overlapping batches lock rows the same way.
  const order = [...ids].sort();
  for (const id of order) {
    outcomes.push(
      await resolveInboxItem(tx, {
        tenantId: input.tenantId,
        itemId: id,
        by: input.by,
        body: {
          decision: approve.includes(id) ? "approve" : "reject",
          ...(input.body.note === undefined ? {} : { note: input.body.note }),
        },
        registry: input.registry,
        collect: input.collect,
      }),
    );
  }
  return ids.map((id) => outcomes.find((o) => o.item.id === id) as ResolveOutcome);
}

// ── Team and settings ────────────────────────────────────────────────────────────────────────────

function ruleWords(
  rule: ApproverRule,
  ctx: { locale: Locale; platform: Platform; agents: Map<string, string> },
): string {
  const m = rule.match;
  const tool = m.tool ? ctx.platform.connectors.findTool(m.tool) : undefined;
  const what = tool?.spec.display
    ? pickLocalized(tool.spec.display.name, ctx.locale)
    : m.connector
      ? (ctx.platform.connectors.get(m.connector)?.manifest.name ?? m.connector)
      : tool
        ? tool.connector.manifest.name
        : null;
  return DESK_WORDS[ctx.locale].team.rule({
    what,
    verb: m.verb ?? null,
    amount: m.amountOver ? `${m.amountOver.currency} ${m.amountOver.value}` : null,
    agent: m.agentId ? (ctx.agents.get(m.agentId) ?? null) : null,
  });
}

/**
 * The client's people, whether each signs, and what the approver rules send them in plain words.
 * The client admins also sign what no rule sends elsewhere (the default).
 */
export async function teamOf(
  tx: Tx,
  input: { tenantId: string; locale: Locale; platform: Platform },
): Promise<TeamMember[]> {
  const people = await tx
    .select({
      userId: membership.userId,
      role: membership.role,
      canSign: membership.canSign,
      name: appUser.name,
      email: appUser.email,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, input.tenantId),
        inArray(membership.role, ["client_admin", "client_user"]),
      ),
    )
    .orderBy(appUser.email);
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, input.tenantId));
  const rules = readApproverRuleSet(t?.settings ?? {}).rules;
  const agentRows = await tx
    .select({ id: agent.id, name: agent.name, serviceName: agent.serviceName })
    .from(agent)
    .where(and(eq(agent.tenantId, input.tenantId), eq(agent.kind, "client")));
  const ctx = {
    locale: input.locale,
    platform: input.platform,
    agents: new Map(agentRows.map((a) => [a.id, a.serviceName ?? a.name])),
  };
  const w = DESK_WORDS[input.locale].team;
  return people.map((p) => {
    const role = p.role as TeamMember["role"];
    const signs: string[] = [];
    if (!p.canSign) {
      signs.push(w.viewer);
    } else {
      for (const r of rules) {
        const a = r.approver;
        const theirs =
          (a.kind === "user" && a.userId === p.userId) ||
          (a.kind === "client_admin" && role === "client_admin") ||
          (a.kind === "role" && a.role === role);
        if (theirs) signs.push(ruleWords(r, ctx));
      }
      if (role === "client_admin") signs.push(w.everythingElse);
    }
    return { userId: p.userId, name: p.name, email: p.email, role, canSign: p.canSign, signs };
  });
}

/** The client's undo window, set by the client admin or the operator; logged in tenant_change. */
export async function setUndoSeconds(
  tx: Tx,
  input: { tenantId: string; seconds: number; actorId: string; side: "client" | "operator" },
): Promise<number> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId)).for("update");
  if (!t) throw notFound("client");
  const from = undoSecondsOf(t.settings);
  if (from === input.seconds) return from;
  await tx
    .update(tenant)
    .set({ settings: withUndoSeconds(t.settings, input.seconds) })
    .where(eq(tenant.id, t.id));
  await tx.insert(tenantChange).values({
    tenantId: t.id,
    actorId: input.actorId,
    change: { setting: "approvals.undoSeconds", side: input.side, from, to: input.seconds },
    reason: input.side === "client" ? "set by the client admin" : "set by the operator",
  });
  return input.seconds;
}
