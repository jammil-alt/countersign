// The account carried in the sealed session cookie (docs/plan.md §1.93, the owner's D2): the user
// and their memberships as read at `at`, so a request inside the window builds its session and
// scope without reading them again. Older than the window, the request reads them in its own
// transaction and the cookie is sealed again with what it read.
//
// What the window costs: a member removed from a client (or a role lowered) by someone else keeps
// what their cookie carries for up to ACCOUNT_WINDOW_SEC. It never delays a grant: a session the
// carried account refuses (a client it doesn't list, a role it lacks) is read again before the
// request is refused. Sign-out, the idle lock and a new sign-in drop it with the session.

import { Role } from "@countersign/core";
import { z } from "zod";
import type { AuthUser, Membership } from "./types";

// DECISION: five minutes, the same as the WorkOS refresh interval (REFRESH_INTERVAL_SEC): the owner
// allowed "a few minutes" (D2), and a session ended in WorkOS stops working within five already.
export const ACCOUNT_WINDOW_SEC = 5 * 60;

/**
 * The largest `Set-Cookie` header we send: browsers keep a cookie of 4096 bytes (name, value and
 * attributes, RFC 6265 §6.1) and may drop a larger one whole, which would sign the person out.
 */
export const MAX_COOKIE_BYTES = 4096;

/** A user's account as read at `at` (seconds since the epoch). */
export interface CarriedAccount {
  readonly at: number;
  readonly user: AuthUser;
  readonly memberships: readonly Membership[];
}

/** The compact form in the cookie: short keys, so an operator with many clients still fits. */
const Compact = z.object({
  at: z.int(),
  u: z.object({ id: z.string().min(1), e: z.string().min(1), n: z.string().nullable() }),
  m: z.array(z.object({ t: z.string().min(1), n: z.string(), r: Role })),
});
export type CompactAccount = z.infer<typeof Compact>;

export function compactAccount(account: CarriedAccount): CompactAccount {
  return {
    at: account.at,
    u: { id: account.user.id, e: account.user.email, n: account.user.name },
    m: account.memberships.map((m) => ({ t: m.tenantId, n: m.tenantName, r: m.role })),
  };
}

/**
 * The carried account for `userId`, or null when there is none, it does not parse, or it belongs
 * to someone else (a cookie is never trusted to name its own user: `userId` comes from the
 * identity it was sealed with).
 */
export function expandAccount(raw: unknown, userId: string): CarriedAccount | null {
  if (raw === undefined || raw === null) return null;
  const parsed = Compact.safeParse(raw);
  if (!parsed.success || parsed.data.u.id !== userId) return null;
  const { at, u, m } = parsed.data;
  return {
    at,
    user: { id: u.id, email: u.e, name: u.n },
    memberships: m.map((x) => ({ tenantId: x.t, tenantName: x.n, role: x.r })),
  };
}

/** Whether a carried account may stand in for a read at `now` (seconds): younger than the window. */
export function accountFresh(account: CarriedAccount, now: number): boolean {
  // A time in the future is not fresh: it was not sealed by this clock.
  return account.at <= now && now - account.at < ACCOUNT_WINDOW_SEC;
}

/** Whether a `Set-Cookie` header is small enough for every browser to keep. */
export function cookieFits(setCookie: string): boolean {
  return new TextEncoder().encode(setCookie).length <= MAX_COOKIE_BYTES;
}
