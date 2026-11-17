// Inviting and removing an operator from outside the app: the first operator of a fresh environment
// (staging, production) can't be invited from the back office, because nobody can sign in yet. Run
// by `scripts/add-operator.ts` from the by-hand "Add operator" workflow, and by
// `scripts/remove-operator.ts`, as cs_owner.
//
// An invite is an `app_user` row with the email and no `workos_user_id`; the first WorkOS sign-in
// with that verified email claims it (packages/auth provisioning). An operator serves clients
// through `operator` memberships, so the invite is a member of every existing client. An
// environment with no client at all (production on its first day) gets its first client, Mezonas,
// so the operator has somewhere to be an operator of: with no membership the app shows "You don't
// have access to this" and nobody could create a client.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { type Db, withOperator } from "./client";
import { appUser, auditEvent, inboxItem, membership, tenant } from "./schema";

export interface AddOperatorResult {
  readonly userId: string;
  /** False when the user already existed (invited earlier, or already signed in). */
  readonly created: boolean;
  /** Clients the operator now serves, existing memberships included. */
  readonly clients: number;
  /** The first client's name when this call created it (an environment with no client), else null. */
  readonly createdClient: string | null;
}

/**
 * The client an empty environment starts with: Mezonas serves itself first (docs/operations.md,
 * "Mezonas, our own client"), in the owner's time zone. Its internal flag and packs are set from the
 * back office afterwards, as for any client.
 */
// DECISION: created only when the environment has no client at all, so running Add operator again,
// or on an environment with clients, never adds one.
export const FIRST_CLIENT = { name: "Mezonas", timezone: "America/Chicago" } as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invites an operator (above). One `operator.add` audit row records each run, as `operator.remove`
 * does: the user, how many clients they now serve, whether the invite is new, and who ran it.
 */
// DECISION: `by` is optional, as for removeOperator; the script fills it from the workflow's run
// (GITHUB_ACTOR and GITHUB_RUN_ID) when no BY is set, so the workflow needs no change.
export async function addOperator(
  db: Db,
  input: { readonly email: string; readonly name?: string | null; readonly by?: string | null },
): Promise<AddOperatorResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`not an email address: ${JSON.stringify(input.email)}`);
  const name = input.name?.trim() || null;

  const tenants = await db.select({ id: tenant.id }).from(tenant);
  const tenantIds = tenants.map((t) => t.id);
  const firstClientId = tenantIds.length === 0 ? randomUUID() : null;
  if (firstClientId) tenantIds.push(firstClientId);

  return withOperator(db, tenantIds, async (tx) => {
    if (firstClientId) {
      await tx.insert(tenant).values({
        id: firstClientId,
        name: FIRST_CLIENT.name,
        timezone: FIRST_CLIENT.timezone,
        // As a client made in the back office with nothing offered yet (POST /api/ops/clients).
        settings: { connectors_offered: [] },
      });
    }
    const inserted = await tx
      .insert(appUser)
      .values({ email, name })
      .onConflictDoNothing()
      .returning({ id: appUser.id });
    const [row] = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.email, email));
    if (!row) throw new Error(`add-operator: user ${email} missing after insert`);

    // A client user is never turned into an operator here: that would hand them every client.
    const existing = await tx
      .select({ tenantId: membership.tenantId, role: membership.role })
      .from(membership)
      .where(eq(membership.userId, row.id));
    const clientRole = existing.find((m) => m.role !== "operator");
    if (clientRole) {
      throw new Error(
        `add-operator: ${email} is a ${clientRole.role} of a client; refusing to make them an operator`,
      );
    }

    if (tenantIds.length) {
      await tx
        .insert(membership)
        .values(
          tenantIds.map((tenantId) => ({ tenantId, userId: row.id, role: "operator" as const })),
        )
        .onConflictDoNothing();
    }
    await tx.insert(auditEvent).values({
      tenantId: null,
      actorKind: "system",
      action: "operator.add",
      outcome: "ok",
      target: {
        user: row.id,
        clients: String(tenantIds.length),
        created: String(inserted.length > 0),
        ...(firstClientId ? { createdClient: firstClientId } : {}),
        ...(input.by ? { by: input.by.slice(0, 200) } : {}),
      },
    });
    return {
      userId: row.id,
      created: inserted.length > 0,
      clients: tenantIds.length,
      createdClient: firstClientId ? FIRST_CLIENT.name : null,
    };
  });
}

export interface RemoveOperatorResult {
  readonly userId: string;
  /** Clients they no longer serve. */
  readonly clients: number;
  /** Open inbox items that named them, now any operator's. */
  readonly reassigned: number;
  /** Clients whose lead they were, now with no lead. */
  readonly leads: number;
}

/**
 * Removing an operator (de-provisioning, docs/security.md §2), as cs_owner: every operator
 * membership goes. An open session carries memberships in its sealed cookie for up to 5 minutes
 * (docs/plan.md §1.93), so the back office refuses them within 5 minutes; the Ops MCP connector
 * reads memberships on each call, so it refuses them at once. Their `app_user` row stays, as
 * history and the audit log name it. One `operator.remove` audit row records it.
 */
// DECISION: the last operator can't be removed: nobody could sign in to the back office, and an
// environment would need the Add operator workflow again to recover.
// DECISION: their open items assigned by name go to the operator role (any operator who serves the
// client), and a client whose lead they were has no lead until an operator sets one, so nothing
// waits on, or is newly assigned to, someone who can no longer sign in.
export async function removeOperator(
  db: Db,
  input: { readonly email: string; readonly by?: string | null },
): Promise<RemoveOperatorResult> {
  const email = input.email.trim().toLowerCase();
  const [user] = await db.select({ id: appUser.id }).from(appUser).where(eq(appUser.email, email));
  if (!user) throw new Error(`remove-operator: no user ${email}`);
  const tenantIds = (await db.select({ id: tenant.id }).from(tenant)).map((t) => t.id);

  return withOperator(db, tenantIds, async (tx) => {
    const operators = await tx
      .selectDistinct({ userId: membership.userId })
      .from(membership)
      .where(eq(membership.role, "operator"));
    if (!operators.some((o) => o.userId === user.id)) {
      throw new Error(`remove-operator: ${email} is not an operator`);
    }
    if (operators.length === 1) {
      throw new Error(`remove-operator: ${email} is the last operator; add another one first`);
    }
    const removed = await tx
      .delete(membership)
      .where(and(eq(membership.userId, user.id), eq(membership.role, "operator")))
      .returning({ tenantId: membership.tenantId });
    const moved = await tx
      .update(inboxItem)
      .set({ assigneeUserId: null, assigneeRole: "operator" })
      .where(and(eq(inboxItem.assigneeUserId, user.id), eq(inboxItem.status, "open")))
      .returning({ id: inboxItem.id });
    const leads = await tx
      .update(tenant)
      .set({ settings: sql`jsonb_set(${tenant.settings}, '{lead}'::text[], 'null'::jsonb)` })
      .where(sql`${tenant.settings}->'lead'->>'userId' = ${user.id}`)
      .returning({ id: tenant.id });
    await tx.insert(auditEvent).values({
      tenantId: null,
      actorKind: "system",
      action: "operator.remove",
      outcome: "ok",
      target: {
        user: user.id,
        clients: String(removed.length),
        reassigned: String(moved.length),
        leads: String(leads.length),
        ...(input.by ? { by: input.by } : {}),
      },
    });
    return {
      userId: user.id,
      clients: removed.length,
      reassigned: moved.length,
      leads: leads.length,
    };
  });
}
