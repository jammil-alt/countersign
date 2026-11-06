// Changes Sloan drafts for the client admin to sign (ARCHITECTURE §9.8; docs/plan.md §1.47
// "Drafted changes"). Drafting checks the change, refuses anything that would loosen a rule
// (`loosens: true`: Sloan offers the lead instead), writes the "now" and "after" lines in the
// client's words from ids and names (never model text), and opens an approval on the Desk for the
// client admin (`subject_type: 'account_change'`). Signing applies it through the portal's own
// code (the invite, the approver rules' save with its stricter-only check, the contact edit) in
// the same transaction as the resolution; if any of it fails, nothing is resolved.

import type { AccountAsker, AccountDraftOutcome } from "@countersign/agents";
import {
  ACCOUNT_CHANGE_SUBJECT,
  ACCOUNT_WORDS,
  type AccountChange,
  type AccountChangeField,
  type AccountChangeOutcome,
  type ApproverRule,
  changeProblem,
  isPlainObject,
  type Locale,
  looseningProblems,
  type RouteSpec,
  readApproverRuleSet,
  readStoredAccountChange,
  type SignerRule,
  type StoredAccountChange,
  signerRules,
} from "@countersign/core";
import {
  agent,
  appUser,
  inboxItem,
  membership,
  organization,
  type Tx,
  tenant,
} from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import { ruleWords } from "../desk/desk";
import { type HandlerCtx, HttpError, notFound } from "../http";
import type { InboxRow } from "../inbox";
import { getContact, updateContact } from "../messaging/contacts";
import type { Platform } from "../platform";
import { save as saveApproverRules } from "../routes/approver-rules";
import { inviteToClient } from "../routes/onboarding";

export function isAccountChange(item: Pick<InboxRow, "subjectType">): boolean {
  return item.subjectType === ACCOUNT_CHANGE_SUBJECT;
}

const refused = (problems: string[], loosens: boolean): AccountDraftOutcome => ({
  status: "refused",
  loosens,
  problems,
  inboxItemId: null,
  title: null,
  now: [],
  after: [],
});

async function clientAgentNames(tx: Tx, tenantId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: agent.id, name: agent.name, serviceName: agent.serviceName })
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client")));
  return new Map(rows.map((a) => [a.id, a.serviceName ?? a.name]));
}

/** A field's value in plain words. Names stand for ids; nothing internal is shown. */
async function valueWords(
  tx: Tx,
  tenantId: string,
  field: AccountChangeField,
  value: unknown,
  none: string,
): Promise<string> {
  if (value === null || value === undefined || value === "") return none;
  if (field === "organizationId" && typeof value === "string") {
    const [o] = await tx
      .select({ name: organization.name })
      .from(organization)
      .where(and(eq(organization.id, value), eq(organization.tenantId, tenantId)));
    return o?.name ?? none;
  }
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : none;
  if (isPlainObject(value)) {
    const { start, end } = value as { start?: unknown; end?: unknown };
    if (typeof start === "string" && typeof end === "string") return `${start}–${end}`;
    return JSON.stringify(value);
  }
  return String(value);
}

/** The rule lines of a new signer, in the Desk's words. */
function signerRuleLines(
  rules: readonly SignerRule[],
  signer: string,
  ctx: { locale: Locale; platform: Platform; agents: Map<string, string> },
): string[] {
  const w = ACCOUNT_WORDS[ctx.locale];
  return rules.map((r) => {
    // ruleWords reads only the match.
    const rule = { id: "", match: r.match, approver: { kind: "client_admin" }, setBy: "client" };
    return w.signs(
      // The Desk's sentence, without its full stop, before the arrow.
      ruleWords(rule as ApproverRule, ctx).replace(/\.$/, ""),
      r.approver === "client_admin" ? w.admins : signer,
    );
  });
}

export interface DraftScope {
  tx: Tx;
  tenantId: string;
  asker: AccountAsker;
  agentId: string;
  agentVersionId: string;
  runId: string;
  locale: Locale;
  platform: Platform;
}

/** Drafts one change for the client admin to sign; refuses a loosening one. */
export async function draftAccountChange(
  s: DraftScope,
  input: { change: AccountChange; sources: string[] },
): Promise<AccountDraftOutcome> {
  const { tx, tenantId, locale } = s;
  const change = input.change;
  const w = ACCOUNT_WORDS[locale];
  const problem = changeProblem(change);
  if (problem) return refused([problem], false);
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const loosening = looseningProblems(change, readApproverRuleSet(t.settings).rules);
  if (loosening.length > 0)
    return refused(
      loosening.map((p) => p.message),
      true,
    );

  let title: string;
  let now: string[];
  let after: string[];
  let subjectId: string | null = null;
  if (change.kind === "add_signer") {
    const [member] = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .innerJoin(membership, eq(membership.userId, appUser.id))
      .where(and(eq(appUser.email, change.email), eq(membership.tenantId, tenantId)));
    if (member) return refused(["that address is already on your team"], false);
    const ctx = { locale, platform: s.platform, agents: await clientAgentNames(tx, tenantId) };
    title = w.title.addSigner(change.name);
    now = [w.notOnTeam(change.name)];
    after = [
      w.joins(change.name, change.canSign),
      ...signerRuleLines(change.rules, change.name, ctx),
    ];
  } else {
    const row = await getContact(tx, tenantId, change.contactId).catch(() => null);
    if (!row) return refused(["no such person in your directory"], false);
    subjectId = row.id;
    const fields: Record<string, unknown> =
      change.kind === "edit_person" ? change.fields : change.addresses;
    title =
      change.kind === "edit_person"
        ? w.title.editPerson(row.name)
        : w.title.changeContact(row.name);
    now = [];
    after = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const f = key as AccountChangeField;
      const current = (row as unknown as Record<string, unknown>)[f];
      now.push(w.field(f, await valueWords(tx, tenantId, f, current, w.none)));
      after.push(w.field(f, await valueWords(tx, tenantId, f, value, w.none)));
    }
  }
  if (s.asker.name) after.push(w.askedBy(s.asker.name));

  const stored: StoredAccountChange = {
    change,
    now,
    after,
    askedBy: s.asker.userId as string,
    threadId: s.asker.threadId,
    runId: s.runId,
    agentVersionId: s.agentVersionId,
    sources: input.sources,
  };
  // DECISION: the item has no run: Sloan's run answers and finishes, and nothing waits on the
  // admin's signature but the change itself (its run and thread are kept in the payload).
  const [item] = await tx
    .insert(inboxItem)
    .values({
      tenantId,
      kind: "approval",
      agentId: s.agentId,
      subjectType: ACCOUNT_CHANGE_SUBJECT,
      subjectId,
      assigneeRole: "client_admin",
      title,
      payload: { accountChange: stored, sources: input.sources },
    })
    .returning({ id: inboxItem.id });
  if (!item) throw new Error("inbox insert returned nothing");
  return {
    status: "drafted",
    loosens: false,
    problems: [],
    inboxItemId: item.id,
    title,
    now,
    after,
  };
}

type ResolveCtx = Pick<HandlerCtx<RouteSpec>, "tx" | "services" | "afterCommit" | "session">;

/**
 * The client admin signs or declines a drafted change. Signing applies it with the portal's own
 * code, checked again as it is now (a rule changed since the draft is checked against today's).
 */
export async function resolveAccountChange(
  ctx: ResolveCtx,
  input: {
    tenantId: string;
    itemId: string;
    decision: "approve" | "reject";
    note?: string | undefined;
    /** Emitted events land here for dispatch after the commit. */
    collect: EventRow[];
  },
): Promise<AccountChangeOutcome> {
  const { tx, tenantId } = { tx: ctx.tx, tenantId: input.tenantId };
  const [item] = await tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, input.itemId), eq(inboxItem.tenantId, tenantId)))
    .for("update");
  if (!item || !isAccountChange(item)) throw notFound("change");
  const stored = readStoredAccountChange(item.payload);
  if (!stored) throw new HttpError(409, "invalid_change", "this change can't be applied");
  const approved = input.decision === "approve";
  if (item.status !== "open") {
    const r = isPlainObject(item.resolution) ? item.resolution : {};
    if (r.approved === approved) return outcome(item, approved, null);
    throw new HttpError(409, "already_resolved", "this change was already decided");
  }
  const by = ctx.session.user.id;
  let applied: AccountChangeOutcome["applied"] = null;
  if (approved) applied = await applyAccountChange(ctx, tenantId, item.id, stored, by);
  const resolution = {
    decision: input.decision,
    approved,
    by,
    ...(input.note ? { note: input.note } : {}),
    ...(applied ? { applied } : {}),
  };
  const [updated] = await tx
    .update(inboxItem)
    .set({ status: "resolved", resolution, resolvedBy: by, resolvedAt: new Date() })
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, tenantId)))
    .returning();
  const event = await emit(
    tx,
    {
      tenantId,
      type: "inbox.resolved",
      subjectType: "inbox_item",
      subjectId: item.id,
      payload: {
        inboxItemId: item.id,
        kind: item.kind,
        runId: item.runId,
        approved,
        resolvedBy: by,
      },
    },
    { registry: ctx.services.platform.events },
  );
  if (event) input.collect.push(event);
  return outcome(updated ?? item, approved, applied);
}

function outcome(
  item: InboxRow,
  approved: boolean,
  applied: AccountChangeOutcome["applied"],
): AccountChangeOutcome {
  return {
    item: { id: item.id, title: item.title, status: item.status, approved },
    applied,
  };
}

async function applyAccountChange(
  ctx: ResolveCtx,
  tenantId: string,
  itemId: string,
  stored: StoredAccountChange,
  actorId: string,
): Promise<NonNullable<AccountChangeOutcome["applied"]>> {
  const { tx } = ctx;
  const change = stored.change;
  const log = { accountChange: itemId, agentVersionId: stored.agentVersionId };
  if (change.kind === "add_signer") {
    // The portal's invite, then its approver-rule save as the client (stricter only).
    const invited = await inviteToClient(
      ctx,
      tenantId,
      { email: change.email, name: change.name, role: change.role, canSign: change.canSign },
      { surface: "portal" },
    );
    if (change.rules.length > 0) {
      const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
      const current = readApproverRuleSet(t?.settings ?? {});
      await saveApproverRules(tx, {
        tenantId,
        body: {
          revision: current.revision,
          rules: signerRules(current.rules, change.rules, invited.member.userId),
          reason: `${change.name} added as a signer through Sloan`,
        },
        side: "client",
        actorId,
        platform: ctx.services.platform,
      });
    }
    return { kind: change.kind, userId: invited.member.userId, contactId: null };
  }
  const patch = change.kind === "edit_person" ? change.fields : change.addresses;
  const row = await updateContact(tx, tenantId, change.contactId, patch, actorId, { log });
  return { kind: change.kind, userId: null, contactId: row.id };
}
