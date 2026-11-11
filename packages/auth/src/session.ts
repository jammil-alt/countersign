// getSession and the role checks, framework-agnostic: they take a Request and an adapter and return
// a session or a typed refusal. The Hono middleware in apps/api turns a refusal into a response and
// a session into `app.tenant_ids` (and `app.operator`) for withTenants().

import { isClientRole, isOperatorRole, type Role, type SessionBase } from "@countersign/core";
import {
  type AuthAdapter,
  type AuthDirectory,
  type AuthRefusal,
  type Membership,
  refuse,
  type Session,
} from "./types";

export type SessionResult =
  | { readonly ok: true; readonly session: Session; readonly setCookies: readonly string[] }
  | AuthRefusal;

export interface GetSessionOptions {
  readonly adapter: AuthAdapter;
  readonly directory: AuthDirectory;
  readonly now?: Date;
  /**
   * The client the request asks to act in (the back office's `?client=` or the portal's one
   * client). Must be one of the user's; omitted means the only one, or all served for operators.
   */
  readonly tenantId?: string | null;
}

/** Build the session for a user from their memberships and the requested client. */
export function buildSession(
  user: Session["user"],
  memberships: readonly Membership[],
  adapter: Session["adapter"],
  requestedTenantId?: string | null,
): { ok: true; session: Session } | AuthRefusal {
  if (memberships.length === 0) {
    return refuse("no_access", "this account is not a member of any client");
  }
  const servedTenantIds = memberships.filter((m) => isOperatorRole(m.role)).map((m) => m.tenantId);
  const isOperator = servedTenantIds.length > 0;

  let active: Membership | undefined;
  if (requestedTenantId) {
    active = memberships.find((m) => m.tenantId === requestedTenantId);
    if (!active) return refuse("tenant_forbidden", "that client is not one of this account's");
  } else if (memberships.length === 1) {
    active = memberships[0];
  }
  // DECISION: the active client is chosen per request (?client= / the portal's one client), not
  // stored in the session cookie, so a back-office tab switcher can't leak into another tab.
  return {
    ok: true,
    session: {
      user,
      memberships,
      isOperator,
      servedTenantIds,
      activeTenantId: active?.tenantId ?? null,
      activeRole: active?.role ?? null,
      adapter,
    },
  };
}

export async function getSession(
  request: Request,
  options: GetSessionOptions,
): Promise<SessionResult> {
  const identified = await options.adapter.identify(request, options.now ?? new Date());
  if (!identified.ok) return identified;
  const { userId, setCookies } = identified;
  const { directory } = options;
  const account = directory.account
    ? await directory.account(userId)
    : { user: await directory.user(userId), memberships: null };
  const memberships =
    account.user && !account.memberships
      ? await directory.memberships(userId)
      : (account.memberships ?? []);
  return sessionFromAccount(
    { user: account.user, memberships },
    options.adapter.kind,
    options.tenantId,
    setCookies,
  );
}

/**
 * The second half of `getSession`, for a caller that identified the request itself and read the
 * account where it chose (apps/api reads it inside the request's own transaction, docs/plan.md
 * §1.84): the session for the requested client, or the refusal, with the identity's cookies.
 */
export function sessionFromAccount(
  account: { readonly user: Session["user"] | null; readonly memberships: readonly Membership[] },
  adapter: Session["adapter"],
  tenantId: string | null | undefined,
  setCookies: readonly string[],
): SessionResult {
  if (!account.user) return refuse("session_invalid", "the signed-in user no longer exists");
  const built = buildSession(account.user, account.memberships, adapter, tenantId);
  if (!built.ok) return { ...built, setCookies: [...built.setCookies, ...setCookies] };
  return { ok: true, session: built.session, setCookies };
}

export type RoleCheck = { readonly ok: true; readonly role: Role } | AuthRefusal;

/**
 * Does the session hold one of `roles`? An operator holds `operator` for every client they serve;
 * a client role counts only in the active client.
 */
export function requireRole(session: Session, roles: readonly Role[]): RoleCheck {
  if (roles.includes("operator") && session.isOperator) {
    if (
      session.activeTenantId === null ||
      session.servedTenantIds.includes(session.activeTenantId)
    ) {
      return { ok: true, role: "operator" };
    }
  }
  if (session.activeRole && roles.includes(session.activeRole)) {
    return { ok: true, role: session.activeRole };
  }
  return refuse("forbidden", `this needs one of: ${roles.join(", ") || "(no role)"}`);
}

export function activeTenant(session: Session): string | null {
  return session.activeTenantId;
}

/** The tenant ids a request runs with (`app.tenant_ids`) and whether `app.operator` is on. */
export type TenantScope =
  | { readonly ok: true; readonly tenantIds: readonly string[]; readonly operator: boolean }
  | AuthRefusal;

/**
 * Back office (`ops`): the clients the operator serves, narrowed to the selected one. Portal: exactly
 * one client, with a client role in it (invariant 1).
 */
export function tenantScope(session: Session, family: "ops" | "portal"): TenantScope {
  if (family === "ops") {
    if (!session.isOperator) return refuse("forbidden", "the back office is for operators");
    if (session.activeTenantId !== null) {
      if (!session.servedTenantIds.includes(session.activeTenantId)) {
        return refuse("tenant_forbidden", "the operator does not serve that client");
      }
      return { ok: true, tenantIds: [session.activeTenantId], operator: true };
    }
    return { ok: true, tenantIds: [...session.servedTenantIds], operator: true };
  }
  if (session.activeTenantId === null || !session.activeRole) {
    return refuse("tenant_forbidden", "choose a client first");
  }
  if (!isClientRole(session.activeRole)) {
    return refuse("forbidden", "the portal is for client users");
  }
  return { ok: true, tenantIds: [session.activeTenantId], operator: false };
}

/**
 * `GET /api/session`'s body (packages/core `SessionResponse`) without its language, which apps/api
 * adds from the client's settings and the request (docs/plan.md §1.18).
 */
export function toSessionResponse(session: Session): SessionBase {
  return {
    user: { id: session.user.id, email: session.user.email, name: session.user.name },
    operator: session.isOperator,
    tenants: session.memberships.map((m) => ({ id: m.tenantId, name: m.tenantName, role: m.role })),
    activeTenantId: session.activeTenantId,
  };
}
