import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Lockdown routes (docs/plan.md §1.243, docs/lockdown-plan.md §4): lock one client or every
// client, see what is locked, unlock. Any operator who serves a client may lock it; only the
// security officer, signed in or past the second step in the last 10 minutes, unlocks. A client
// admin may lock their own account and unlock a lock they made.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;

export const LOCK_REASON_MAX = 500;
/** What locking every client asks to be typed, as retiring asks for the client's name. */
export const LOCK_EVERYTHING_CONFIRM = "lock everything";
/** How recently the security officer must have signed in or passed the second step to unlock. */
export const UNLOCK_FRESH_SECONDS = 10 * 60;

const Reason = z.string().trim().min(1).max(LOCK_REASON_MAX);

export const LockSide = z.enum(["operator", "client"]);
export type LockSide = z.infer<typeof LockSide>;

const Person = z.object({ id: z.string(), name: z.string().nullable(), email: z.string() });

export const ClientLockRow = z.object({
  clientId: z.string(),
  clientName: z.string(),
  lockedAt: z.string(),
  side: LockSide,
  by: Person.nullable(),
  reason: z.string(),
  /** What came in while locked and was answered and dropped, by kind: counts only. */
  inbound: z.record(z.string(), z.number().int().nonnegative()),
});
export type ClientLockRow = z.infer<typeof ClientLockRow>;

export const LockdownState = z.object({
  everything: z
    .object({ lockedAt: z.string(), by: Person.nullable(), reason: z.string() })
    .nullable(),
  /** The locked clients among those this operator serves. */
  clients: z.array(ClientLockRow),
  /** Whether this person may unlock: the security officer (SECURITY_OFFICER_EMAILS). */
  canUnlock: z.boolean(),
});
export type LockdownState = z.infer<typeof LockdownState>;

export const LockClientBody = z.strictObject({
  reason: Reason,
  /** The client's name, typed again: a lock stops everything for the client at once. */
  confirmName: z.string().trim().min(1).max(200),
});

export const LockEverythingBody = z.strictObject({
  reason: Reason,
  /** `lock everything`, typed. */
  confirm: z.string().trim().min(1).max(50),
});

export const UnlockBody = z.strictObject({
  /** What was found: kept in the client's change log and the audit log. */
  note: Reason,
});

export const LockResult = z.object({
  changed: z.boolean(),
  lockedAt: z.string(),
  /** Runs in progress stopped by the lock (their Workflow instances ended). */
  runsStopped: z.number().int().nonnegative(),
});

export const UnlockResult = z.object({ changed: z.boolean() });

/** The portal's view of its own lock: what the locked page shows. Never the operator's reason. */
export const AccountLock = z.object({
  locked: z.boolean(),
  lockedAt: z.string().nullable(),
  side: LockSide.nullable(),
  /** The client's own reason, when the client locked it; never ours. */
  reason: z.string().nullable(),
  /** A client admin may unlock a lock the client side made. */
  canUnlock: z.boolean(),
});
export type AccountLock = z.infer<typeof AccountLock>;

export const AccountLockBody = z.strictObject({ reason: Reason });

export const lockdownRoutes = {
  opsLockdown: defineRoute({
    method: "GET",
    path: "/api/ops/lockdown",
    auth: "session",
    roles: OPS,
    summary: "What is locked: everything, and the clients this operator serves, with who and why",
    response: LockdownState,
  }),
  opsLockClient: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/lock",
    auth: "session",
    roles: OPS,
    summary:
      "Lock a client down: nothing reads or writes its data, tools or model calls, its runs stop and its people can't sign in, until the security officer unlocks it",
    params: IdParams,
    body: LockClientBody,
    response: LockResult,
  }),
  opsUnlockClient: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/unlock",
    auth: "session",
    roles: OPS,
    summary:
      "Unlock a client (the security officer, recently signed in): nothing resumes by itself",
    params: IdParams,
    body: UnlockBody,
    response: UnlockResult,
  }),
  opsLockEverything: defineRoute({
    method: "POST",
    path: "/api/ops/lockdown/lock",
    auth: "session",
    roles: OPS,
    summary: "Lock every client down at once, and every operator but the security officer out",
    body: LockEverythingBody,
    response: LockResult,
  }),
  opsUnlockEverything: defineRoute({
    method: "POST",
    path: "/api/ops/lockdown/unlock",
    auth: "session",
    roles: OPS,
    summary:
      "Unlock everything (the security officer, recently signed in); clients locked on their own stay locked",
    body: UnlockBody,
    response: UnlockResult,
  }),
  accountLock: defineRoute({
    method: "GET",
    path: "/api/account/lock",
    auth: "session",
    roles: ["client_admin", "client_user"],
    summary: "Whether this account is locked, since when, and whether you may unlock it",
    response: AccountLock,
  }),
  accountLockSet: defineRoute({
    method: "POST",
    path: "/api/account/lock",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "Lock your account: your agents stop and nothing reads or changes your tools until it is unlocked",
    body: AccountLockBody,
    response: LockResult,
  }),
  accountUnlock: defineRoute({
    method: "POST",
    path: "/api/account/unlock",
    auth: "session",
    roles: ["client_admin"],
    summary: "Unlock your account, if your side locked it; a lock we made is ours to lift",
    body: UnlockBody,
    response: UnlockResult,
  }),
} as const;
