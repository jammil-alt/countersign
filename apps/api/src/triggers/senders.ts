// Who sent a message to an agent (ARCHITECTURE §10.8; docs/plan.md §1.48 "Senders"), read from the
// client's own People inside its transaction: a contact by id, address or number, or a member by
// their membership. Everything here is one client's (invariant 1).

import type { ClientRole, SenderFacts } from "@countersign/core";
import { contact, membership, type Tx } from "@countersign/db";
import type { SenderLookup } from "@countersign/workflows";
import { and, eq } from "drizzle-orm";

type ContactRow = typeof contact.$inferSelect;

function contactFacts(c: Pick<ContactRow, "id" | "relationship" | "roles">): SenderFacts {
  return { kind: "contact", contactId: c.id, relationship: c.relationship ?? null, tags: c.roles };
}

export async function senderFacts(
  tx: Tx,
  tenantId: string,
  ref: { contactId: string | null; userId: string | null },
): Promise<SenderFacts> {
  if (ref.userId) {
    const [m] = await tx
      .select({ role: membership.role })
      .from(membership)
      .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, ref.userId)));
    if (m) return { kind: "user", userId: ref.userId, role: m.role as "operator" | ClientRole };
    return { kind: "stranger" };
  }
  if (ref.contactId) {
    const [c] = await tx
      .select({ id: contact.id, relationship: contact.relationship, roles: contact.roles })
      .from(contact)
      .where(and(eq(contact.tenantId, tenantId), eq(contact.id, ref.contactId)));
    if (c) return contactFacts(c);
  }
  return { kind: "stranger" };
}

/** The router's sender lookup for one client, over the dispatching transaction. */
export function senderLookup(tx: Tx, tenantId: string): SenderLookup {
  return (ref) => senderFacts(tx, tenantId, ref);
}

/** The client's contact with this email address (stored lower case), or null. */
export async function contactByEmail(
  tx: Tx,
  tenantId: string,
  address: string,
): Promise<ContactRow | null> {
  const [c] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(contact.email, address.trim().toLowerCase())))
    .limit(1);
  return c ?? null;
}

export { contactFacts };
