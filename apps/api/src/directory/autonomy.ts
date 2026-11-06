// A person's autonomy per channel (ARCHITECTURE v0.12 §6.1, docs/plan.md §1.42): whether agents may
// email, text, message on WhatsApp or call this contact on their own, only with a sign, or not at
// all. The operator sets any level; the client admin sets `off` or `approval` and only tightens
// (invariant 8: only the operator loosens). Every change is a `contact_change` row with before and
// after; the request itself is in the audit log like every other.

import {
  type ContactAutonomy,
  clientAutonomyProblem,
  readAutonomy,
} from "@countersign/core";
import { contact, contactChange, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { type ContactRow, getContact } from "../messaging/contacts";

export async function setContactAutonomy(
  tx: Tx,
  tenantId: string,
  contactId: string,
  autonomy: ContactAutonomy,
  actor: { id: string; role: "operator" | "client_admin" | "client_user" },
): Promise<ContactRow> {
  const row = await getContact(tx, tenantId, contactId);
  const before = readAutonomy(row.autonomy);
  if (actor.role !== "operator") {
    const problem = clientAutonomyProblem(before, autonomy);
    if (problem) throw new HttpError(403, "loosening", problem);
  }
  // DECISION: the setting is stored as written, `auto` included: an explicit `auto` records that
  // Mezonas chose "on its own" for that channel, which the client then can't set back by itself.
  const after = autonomy;
  if (JSON.stringify(sorted(before)) === JSON.stringify(sorted(after))) return row;
  const [updated] = await tx
    .update(contact)
    .set({ autonomy: after })
    .where(and(eq(contact.id, contactId), eq(contact.tenantId, tenantId)))
    .returning();
  if (!updated) throw notFound("contact");
  await tx.insert(contactChange).values({
    tenantId,
    contactId,
    actorId: actor.id,
    change: {
      kind: "autonomy",
      before,
      after,
      by: actor.role === "operator" ? "operator" : "client",
    },
  });
  return updated;
}

function sorted(a: ContactAutonomy): ContactAutonomy {
  return Object.fromEntries(Object.entries(a).sort(([x], [y]) => x.localeCompare(y)));
}
