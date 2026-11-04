// Inviting an operator from outside the app: the first operator of a fresh environment (staging,
// production) can't be invited from the back office, because nobody can sign in yet. Run by
// `scripts/add-operator.ts` from the by-hand "Add operator" workflow, as cs_owner.
//
// An invite is an `app_user` row with the email and no `workos_user_id`; the first WorkOS sign-in
// with that verified email claims it (packages/auth provisioning). An operator serves clients
// through `operator` memberships, so the invite is a member of every existing client.

import { eq } from "drizzle-orm";
import { type Db, withOperator } from "./client";
import { appUser, membership, tenant } from "./schema";

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
