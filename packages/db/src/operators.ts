// Inviting and removing an operator from outside the app: the first operator of a fresh environment (staging,
// production) can't be invited from the back office, because nobody can sign in yet. Run by
// `scripts/add-operator.ts` from the by-hand "Add operator" workflow, as cs_owner.
//
// An invite is an `app_user` row with the email and no `workos_user_id`; the first WorkOS sign-in
// with that verified email claims it (packages/auth provisioning). An operator serves clients
// through `operator` memberships, so the invite is a member of every existing client.

import { and, eq } from "drizzle-orm";
import { type Db, withOperator } from "./client";
import { appUser, auditEvent, membership, tenant } from "./schema";

export interface AddOperatorResult {
  readonly userId: string;
  /** False when the user already existed (invited earlier, or already signed in). */
  readonly created: boolean;
  /** Clients the operator now serves, existing memberships included. */
  readonly clients: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function addOperator(
  db: Db,
  input: { readonly email: string; readonly name?: string | null },
): Promise<AddOperatorResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`not an email address: ${JSON.stringify(input.email)}`);
  const name = input.name?.trim() || null;

  const tenants = await db.select({ id: tenant.id }).from(tenant);
  const tenantIds = tenants.map((t) => t.id);

  return withOperator(db, tenantIds, async (tx) => {
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
    return { userId: row.id, created: inserted.length > 0, clients: tenantIds.length };
  });
}

export interface RemoveOperatorResult {
  readonly userId: string;
  /** Clients they no longer serve. */
  readonly clients: number;
}

/**
 * Removing an operator (de-provisioning, docs/security.md §2), from the by-hand "Remove operator"
 * workflow as cs_owner: every operator membership goes, so the back office and the Ops MCP
 * connector refuse them on their next request (both read memberships afresh). Their `app_user` row
 * stays, as history and the audit log name it. One audit row records it.
 */
// DECISION: the last operator can't be removed: nobody could sign in to the back office, and an
// environment would need the Add operator workflow again to recover.
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
    await tx.insert(auditEvent).values({
      tenantId: null,
      actorKind: "system",
      action: "operator.remove",
      outcome: "ok",
      target: {
        user: user.id,
        clients: String(removed.length),
        ...(input.by ? { by: input.by } : {}),
      },
    });
    return { userId: user.id, clients: removed.length };
  });
}
