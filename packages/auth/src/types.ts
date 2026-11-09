// The session and the data auth needs from the database, as interfaces. The API implements the
// directory with packages/db; auth's own logic never touches the database.

import type { Role } from "@countersign/core";

export interface AuthUser {
  /** app_user.id */
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
}

/** One row of `membership`: the user's role in one client (tenant). */
export interface Membership {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly role: Role;
}

export type AdapterKind = "dev" | "workos";

/**
 * Who is asking and where they may act (ARCHITECTURE §4). An operator's memberships list the
 * clients they serve; a client user belongs to exactly one client.
 */
export interface Session {
  readonly user: AuthUser;
  /** Roles per client. */
  readonly memberships: readonly Membership[];
  readonly isOperator: boolean;
  /** The clients this user serves as an operator: what `/api/ops` sets in `app.tenant_ids`. */
  readonly servedTenantIds: readonly string[];
  /** A portal session's one client, or the operator's switcher choice; null for "all served". */
  readonly activeTenantId: string | null;
  /** The user's role in the active client. */
  readonly activeRole: Role | null;
  readonly adapter: AdapterKind;
}

export type RefusalCode =
  /** No credentials on the request. */
  | "unauthenticated"
  /** Credentials that do not open, are expired, or name a user who is gone. */
  | "session_invalid"
  /** Signed in, but a member of no client. */
  | "no_access"
  /** The role does not allow this. */
  | "forbidden"
  /** The requested client is not one of the user's. */
  | "tenant_forbidden"
  /** The adapter must not run here (the dev adapter in production). */
  | "adapter_disabled"
  /** Sign-in is configured wrongly; nothing can be verified. */
  | "misconfigured";

export interface AuthRefusal {
  readonly ok: false;
  readonly status: 401 | 403 | 503;
  readonly code: RefusalCode;
  readonly message: string;
  /** Cookies to send with the refusal, e.g. clearing a dead session. */
  readonly setCookies: readonly string[];
  /** Why sign-in refused (with `no_access`), so the sign-in page can say so. */
  readonly reason?: SignInRefusalReason;
}

const STATUS: Record<RefusalCode, AuthRefusal["status"]> = {
  unauthenticated: 401,
  session_invalid: 401,
  no_access: 403,
  forbidden: 403,
  tenant_forbidden: 403,
  adapter_disabled: 503,
  misconfigured: 503,
};

export function refuse(
  code: RefusalCode,
  message: string,
  setCookies: readonly string[] = [],
): AuthRefusal {
  return { ok: false, status: STATUS[code], code, message, setCookies };
}

export function isRefusal(value: unknown): value is AuthRefusal {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

/** What an adapter learns from a request: which app_user it is, and cookies to set. */
export type Identification =
  | { readonly ok: true; readonly userId: string; readonly setCookies: readonly string[] }
  | AuthRefusal;

/**
 * What became of the email that tells an invited person to sign in. The invitation itself is the
 * `app_user` row with its membership (the API writes it); this is only the message.
 */
export type InviteDelivery =
  /** The sign-in provider emailed the invitation. */
  | { readonly status: "sent"; readonly invitationId: string }
  /** Nothing to send: the dev sign-in lists every user, so they can sign in at once. */
  | { readonly status: "not_sent"; readonly reason: "dev_sign_in" }
  /** The provider refused or could not be reached; `reason` is its error code, never its text. */
  | { readonly status: "failed"; readonly reason: string };

export interface AuthAdapter {
  readonly kind: AdapterKind;
  identify(request: Request, now: Date): Promise<Identification>;
  /** Tell an invited address how to sign in. Never throws: a failure is a `failed` delivery. */
  invite(email: string): Promise<InviteDelivery>;
}

/** Reads auth needs on every request. */
export interface AuthDirectory {
  user(userId: string): Promise<AuthUser | null>;
  memberships(userId: string): Promise<readonly Membership[]>;
}

/** What the dev adapter needs: seeded users, found by email. */
export interface DevDirectory {
  userByEmail(email: string): Promise<AuthUser | null>;
}

/** What a WorkOS sign-in hands the database to find or create its user. */
export interface ProvisionInput {
  readonly workosUserId: string;
  readonly email: string;
  readonly name: string | null;
  /** WorkOS's `email_verified`. Only a verified address may claim an invited user row. */
  readonly emailVerified: boolean;
  /** Maps to `tenant.workos_organization_id` when the sign-in named an organization. */
  readonly workosOrganizationId: string | null;
  readonly organizationName: string | null;
}

export type ProvisionRefusalReason =
  /** The address is on an invited row, but WorkOS has not verified it. */
  | "email_not_verified"
  /** No invitation or membership: the operator adds clients and invites their users. */
  | "not_invited"
  /** The address belongs to a different WorkOS user: never merged (account takeover). */
  | "email_taken";

/** Why a finished sign-in got no session: provisioning's reasons, or how the person signed in. */
export type SignInRefusalReason =
  | ProvisionRefusalReason
  /** A sign-in method that WorkOS doesn't hold to our second factor (docs/security.md §2). */
  | "sign_in_method";

export type ProvisionOutcome =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: ProvisionRefusalReason };

/**
 * Sign-in provisioning, in one transaction on the API side: upsert `app_user` on
 * `workos_user_id`, claim an invited row by verified email, and refuse anyone who was not invited.
 */
export interface ProvisioningDirectory {
  provision(input: ProvisionInput): Promise<ProvisionOutcome>;
}
