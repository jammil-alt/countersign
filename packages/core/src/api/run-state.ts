// UI cleanup, stream A: a run's state as people read it, one definition for the back office and
// the portal. A workflow run that waits on a person keeps `run.status = 'running'` (its step is
// `waiting` and an open inbox item holds it), so the stored status alone would show it as Running.
// Here a run that is still going and has an open item is "waiting for approval": never running.
//
// The back office reads who it waits on (the client admin, the client's team, one named person, or
// us) and since when, and whether anybody can act on it at all; the portal reads only whether it
// waits on the client (`waitingOnYou`). Both go through `runState`.

import { z } from "zod";

/** An approval waiting on a client longer than this shows in Needs us. */
export const APPROVAL_OVERDUE_HOURS = 24;

/** Who a waiting run (or an open item) waits on. */
export const WAIT_ON = ["client_admin", "client_team", "person", "operator"] as const;
export const WaitOn = z.enum(WAIT_ON);
export type WaitOn = z.infer<typeof WaitOn>;

/**
 * Why nobody can act on an approval: nobody at the client may approve it; everyone who may is
 * still invited (has never signed in); or we can't tell who is active and we send no emails, so
 * nobody was told.
 */
export const NOBODY_TO_ACT = ["no_approver", "not_signed_in", "no_email"] as const;
export const NobodyToAct = z.enum(NOBODY_TO_ACT);
export type NobodyToAct = z.infer<typeof NobodyToAct>;

/** What a waiting run waits on: its oldest open item's. */
export const RunWait = z.object({
  on: WaitOn,
  /** The named person's name (else email), when `on` is `person`. */
  person: z.string().nullable(),
  /** When it started waiting: the oldest open item's time. */
  since: z.string(),
  /** Open items it waits on. */
  items: z.number().int().min(1),
  /** Set when nobody can act on it; null when someone can. */
  nobodyToAct: NobodyToAct.nullable(),
  /** We send no emails from this deployment, so the people who may act weren't told. */
  emailOff: z.boolean(),
});
export type RunWait = z.infer<typeof RunWait>;

/** A run's state for people: the stored status, with a run that waits on a person "waiting". */
export type RunState = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";

/** What any run shape carries: its stored status, and whether (or what) it waits on. */
export interface RunStateFields {
  status: string;
  /** The back office's wait, or the portal's `waitingOnYou`. */
  waiting?: RunWait | boolean | null | undefined;
}

export function runState(r: RunStateFields): RunState {
  switch (r.status) {
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "waiting":
      return "waiting";
    default:
      if (r.waiting) return "waiting";
      return r.status === "queued" ? "queued" : "running";
  }
}

/** Whether a run may still change: its screens poll. */
export function runIsOpen(r: RunStateFields): boolean {
  const s = runState(r);
  return s === "queued" || s === "running" || s === "waiting";
}

/** The run statuses that may still change. */
export const OPEN_RUN_STATUSES = ["queued", "running", "waiting"] as const;

// ── Who waits, and whether anybody can act ──────────────────────────────────────────────────────

/** An open item's assignee, as the inbox stores it. */
export interface ItemAssignee {
  assigneeRole: string | null;
  assigneeUserId: string | null;
}

/** Who an item waits on: a named person, us, the client's team, or the client admin. */
export function waitOn(item: ItemAssignee): WaitOn {
  if (item.assigneeUserId) return "person";
  if (item.assigneeRole === "operator") return "operator";
  if (item.assigneeRole === "client_user") return "client_team";
  // client_admin, and items with no assignee, are the client admin's (packages/agents' mayResolve).
  return "client_admin";
}

/** A person of the client, for who may approve. */
export interface ClientMember {
  userId: string;
  role: string;
  /** False for a viewer, who approves nothing. */
  canSign: boolean;
  /** Whether they have signed in; null where sign-in can't tell (the dev sign-in). */
  signedIn: boolean | null;
}

/** The people of the client who may resolve an item (as packages/agents' mayResolve decides). */
export function whoMayApprove(
  item: ItemAssignee,
  members: readonly ClientMember[],
): ClientMember[] {
  return members.filter((m) => {
    if (!m.canSign || m.role === "operator") return false;
    if (item.assigneeUserId) return m.userId === item.assigneeUserId;
    if (item.assigneeRole === "client_user") {
      return m.role === "client_admin" || m.role === "client_user";
    }
    return m.role === "client_admin";
  });
}

/** What the deployment knows about reaching people. */
export interface ReachContext {
  /** Sign-in records first sign-ins (WorkOS); false with the dev sign-in. */
  signInsKnown: boolean;
  /** Emails are sent (the mailer is configured). */
  emailOn: boolean;
}

/**
 * Why nobody can act on a client's open item, or null when someone can. Items for us never are:
 * the operator is always there.
 */
// DECISION: "an approval no active person can act on" is one where nobody at the client may approve
// it, or everyone who may is still invited (never signed in, known with WorkOS). With the dev
// sign-in nobody's sign-in is known, so there it is one we send no email about. A signed-in
// approver with emails off can still act on their next visit: that one shows after 24 hours.
export function nobodyToAct(
  item: ItemAssignee,
  members: readonly ClientMember[],
  reach: ReachContext,
): NobodyToAct | null {
  if (waitOn(item) === "operator") return null;
  const approvers = whoMayApprove(item, members);
  if (approvers.length === 0) return "no_approver";
  if (reach.signInsKnown) {
    return approvers.some((m) => m.signedIn === true) ? null : "not_signed_in";
  }
  return reach.emailOn ? null : "no_email";
}

/** Whether an approval that started waiting at `since` has waited past APPROVAL_OVERDUE_HOURS. */
export function approvalOverdue(since: string | Date, now: Date = new Date()): boolean {
  const at = typeof since === "string" ? Date.parse(since) : since.getTime();
  return now.getTime() - at > APPROVAL_OVERDUE_HOURS * 60 * 60 * 1000;
}

/** An open item with what the run's wait needs. */
export interface OpenItem extends ItemAssignee {
  createdAt: Date;
  /** The named assignee's name, else email; null for a role. */
  personName: string | null;
}

/**
 * A run's wait from its open items (at least one): the oldest item's assignee and time, how many
 * there are, and whether anybody can act on the oldest.
 */
export function runWaitOf(
  items: readonly OpenItem[],
  members: readonly ClientMember[],
  reach: ReachContext,
): RunWait | null {
  const sorted = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const oldest = sorted[0];
  if (!oldest) return null;
  const on = waitOn(oldest);
  return {
    on,
    person: on === "person" ? oldest.personName : null,
    since: oldest.createdAt.toISOString(),
    items: sorted.length,
    nobodyToAct: nobodyToAct(oldest, members, reach),
    emailOff: on !== "operator" && !reach.emailOn,
  };
}
