// Lockdown (docs/plan.md §1.243, docs/lockdown-plan.md §2 and §4): who may unlock, stopping a
// locked client's runs in the lock's own transaction, and the notices a lock sends.

import { closeRunApprovalsTx } from "@countersign/agents";
import type { Session } from "@countersign/auth";
import { appUser, membership, run, stepRun, type Tx } from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Bindings } from "../env";
import { HttpError } from "../http";
import type { Mailer } from "../notify/mailer";
import { reportHandled } from "../observability/report";
import { queueFinishedRun } from "../run-audit/store";
import type { RunInstances } from "../runs/instances";
import { closeRunReachOuts } from "../runs/reconcile";
import { isSecurityOfficer, provedRecently, securityOfficers } from "./officer";

export { isSecurityOfficer, securityOfficers };

const OPEN_RUN = ["queued", "running", "waiting"] as const;
const OPEN_STEP = ["pending", "running", "waiting"] as const;

/** Why this session may not unlock now (see provedRecently), or null. */
export function freshProofRefusal(
  session: Pick<Session, "secondFactor" | "provedAt">,
  now: Date,
): HttpError | null {
  if (provedRecently(session, now)) return null;
  return new HttpError(
    403,
    "sign_in_again",
    "sign in again (or pass the second step) to unlock: it must be in the last 10 minutes",
  );
}

/** The operator's unlock: the security officer, recently proved. Throws otherwise. */
export function checkOperatorUnlock(
  session: Session,
  env: Pick<Bindings, "SECURITY_OFFICER_EMAILS">,
  now: Date,
): void {
  if (securityOfficers(env).length === 0) {
    throw new HttpError(
      403,
      "no_security_officer",
      "no security officer is set (SECURITY_OFFICER_EMAILS), so nobody can unlock in the app",
    );
  }
  if (!isSecurityOfficer(session, env)) {
    throw new HttpError(403, "not_security_officer", "only the security officer can unlock");
  }
  const stale = freshProofRefusal(session, now);
  if (stale) throw stale;
}

/**
 * Stops a client's open runs in the lock's transaction (the client is still in its scope): each
 * run and its open steps cancelled with `client_locked`, its reach-outs and approvals closed, and
 * it is queued for audit as any run that ends. Answers their ids, so their Workflow instances can
 * be ended once the lock commits. A write being made right now isn't waited for, as a cancel
 * would: the lock can't wait, and the write's own end is refused by the lock, so its action stays
 * `executing` for a person to check.
 */
export async function stopClientRuns(tx: Tx, tenantId: string, by: string): Promise<string[]> {
  const now = new Date();
  const stopped = await tx
    .update(run)
    .set({
      status: "cancelled",
      finishedAt: now,
      error: {
        reason: "the account was locked down",
        code: "client_locked",
        by,
      },
    })
    .where(and(eq(run.tenantId, tenantId), inArray(run.status, [...OPEN_RUN])))
    .returning({ id: run.id, tenantId: run.tenantId, agentId: run.agentId, mode: run.mode });
  for (const r of stopped) {
    await tx
      .update(stepRun)
      .set({ status: "cancelled", finishedAt: now })
      .where(
        and(
          eq(stepRun.runId, r.id),
          eq(stepRun.tenantId, tenantId),
          inArray(stepRun.status, [...OPEN_STEP]),
        ),
      );
    await closeRunReachOuts(tx, r, "the account was locked down");
    await queueFinishedRun(tx, r);
    await closeRunApprovalsTx(
      tx,
      tenantId,
      r.id,
      { code: "client_locked", message: "the account was locked down" },
      { items: "all" },
    );
  }
  return stopped.map((r) => r.id);
}

/** Ends the stopped runs' Workflow instances, after the lock commits. Best effort per run. */
export async function endInstances(instances: RunInstances, runIds: readonly string[]) {
  for (const id of runIds) {
    await instances.terminate(id).catch((error: unknown) =>
      // A run whose instance can't be ended stops at its next step anyway: the lock refuses it.
      reportHandled("ending a locked client's run failed", error, { kind: "lockdown", run: id }),
    );
  }
}

/** The client's admins' emails, read in the lock's transaction (the client is still in scope). */
export async function clientAdminEmails(tx: Tx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, tenantId), eq(membership.role, "client_admin")));
  return [...new Set(rows.map((r) => r.email))];
}

/**
 * The notices of a lock: the client's admins are told their account is locked and that we'll be
 * in touch (no record content, T8), and the security officer is told who locked what and why.
 * Sent after the response; a send that fails is reported, never undoes the lock.
 */
export async function sendLockNotices(
  mailer: Mailer,
  notice: {
    lockId: string;
    clientName: string | null;
    clientAdmins: readonly string[];
    officers: readonly string[];
    by: string;
    reason: string;
  },
): Promise<void> {
  if (!mailer.isConfigured) {
    console.warn("lockdown notices not sent: email isn't configured", { lock: notice.lockId });
    return;
  }
  const what = notice.clientName ?? "every client";
  const sends = [
    ...notice.clientAdmins.map((to) => ({
      to,
      subject: "We've locked your Mezonas account",
      text: [
        "We've locked your Mezonas account while we look into a security concern.",
        "",
        "Your agents are stopped, and nothing reads or changes your tools until it is unlocked.",
        "We'll contact you within 24 hours to say what we found and what happens next.",
      ].join("\n"),
      idempotencyKey: `lockdown:${notice.lockId}:${to}`,
    })),
    ...notice.officers.map((to) => ({
      to,
      subject: `Locked down: ${what}`,
      text: [
        `${notice.by} locked down ${what}.`,
        "",
        `Reason: ${notice.reason}`,
        "",
        "Only you can unlock it, in the back office (Security, Lockdown).",
      ].join("\n"),
      idempotencyKey: `lockdown:${notice.lockId}:officer:${to}`,
    })),
  ];
  for (const message of sends) {
    await mailer
      .send(message)
      .catch((error: unknown) =>
        reportHandled("a lockdown notice failed to send", error, { kind: "lockdown" }),
      );
  }
}
