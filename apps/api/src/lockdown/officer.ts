// Lockdown (docs/plan.md §1.243): who the security officer is, and whether their sign-in is recent
// enough to unlock or investigate. Imports nothing of the app's, so http.ts can use it.

import type { Session } from "@countersign/auth";
import { UNLOCK_FRESH_SECONDS } from "@countersign/core";
import type { Bindings } from "../env";

/** The security officer's emails (SECURITY_OFFICER_EMAILS), lowercased. */
export function securityOfficers(env: Pick<Bindings, "SECURITY_OFFICER_EMAILS">): string[] {
  return (env.SECURITY_OFFICER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/** Whether this operator is the security officer. */
export function isSecurityOfficer(
  session: Pick<Session, "isOperator" | "user">,
  env: Pick<Bindings, "SECURITY_OFFICER_EMAILS">,
): boolean {
  return (
    session.isOperator && securityOfficers(env).includes(session.user.email.trim().toLowerCase())
  );
}

/**
 * Whether the session proved who it is recently enough: with the second step on, it signed in or
 * passed the step in the last UNLOCK_FRESH_SECONDS, as adding a phone's key asks
 * (mobile/phone-session.ts), so a session taken later can't lift a lock or read a locked client.
 * With the step off (or the dev sign-in) a session carries no step, and nothing more is asked.
 */
export function provedRecently(session: Pick<Session, "secondFactor" | "provedAt">, now: Date) {
  if (session.secondFactor === undefined) return true;
  const proved = session.provedAt ?? 0;
  return Math.floor(now.getTime() / 1000) - proved <= UNLOCK_FRESH_SECONDS;
}
