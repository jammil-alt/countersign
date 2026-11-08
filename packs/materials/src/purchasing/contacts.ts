// P-9: who to email a request for a quote to (docs/plan.md §1.71). A vendor is linked to an
// organization in the client's directory (`organization.vendor_id`); that organization's people
// with an email address, not opted out and with consent to email, are the ones an agent may write
// to. The first of them (a person with a purchasing or sales role first, then by name) is the
// RFQ's contact: reach out takes its id as `to: { contactId }`. Read in one client's transaction;
// what the directory says is data (invariant 9).

import { contact, organization, type Tx, vendor } from "@countersign/db";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

export interface VendorContact {
  contactId: string;
  name: string;
  email: string;
  title: string | null;
  /** Consent to email from an agent (reach out refuses without it). */
  emailConsent: boolean;
  optedOut: boolean;
  language: string | null;
}

export interface VendorContacts {
  vendorId: string;
  vendorName: string;
  organizationId: string | null;
  /** The person to write to, when there is one who may be emailed. */
  contactId: string | null;
  contactName: string | null;
  contacts: VendorContact[];
  /** Why nobody can be emailed; null when someone can. */
  reason: string | null;
}

const ROLE_WORDS = ["purchas", "sales", "quote", "order", "rep"];

/** Purchasing or sales people first, then by name: the order a contact is picked in. */
function rank(c: { roles: string[]; title: string | null }): number {
  const words = [...c.roles, c.title ?? ""].join(" ").toLowerCase();
  return ROLE_WORDS.some((w) => words.includes(w)) ? 0 : 1;
}

// DECISION: the RFQ's contact is the vendor organization's first person who may be emailed (an
// address, consent to email, not opted out), purchasing and sales roles first. Nobody: the vendor
// is listed with the reason, and is not asked (an agent never guesses an address).
export async function vendorContacts(
  tx: Tx,
  tenantId: string,
  vendorIds: readonly string[],
): Promise<VendorContacts[]> {
  const ids = [...new Set(vendorIds)];
  if (ids.length === 0) return [];
  const vendors = await tx
    .select({ id: vendor.id, name: vendor.name })
    .from(vendor)
    .where(and(eq(vendor.tenantId, tenantId), inArray(vendor.id, ids)));
  const orgs = await tx
    .select({ id: organization.id, vendorId: organization.vendorId })
    .from(organization)
    .where(and(eq(organization.tenantId, tenantId), inArray(organization.vendorId, ids)));
  const orgIds = orgs.map((o) => o.id);
  const people =
    orgIds.length === 0
      ? []
      : await tx
          .select()
          .from(contact)
          .where(
            and(
              eq(contact.tenantId, tenantId),
              inArray(contact.organizationId, orgIds),
              isNotNull(contact.email),
            ),
          )
          .orderBy(asc(contact.name), asc(contact.id));
  const out: VendorContacts[] = [];
  for (const id of ids) {
    const v = vendors.find((x) => x.id === id);
    if (!v) continue;
    const org = orgs.find((o) => o.vendorId === id) ?? null;
    const own = org ? people.filter((p) => p.organizationId === org.id) : [];
    const contacts: VendorContact[] = own.map((p) => ({
      contactId: p.id,
      name: p.name,
      email: p.email as string,
      title: p.title,
      emailConsent: Boolean(p.consent?.email),
      optedOut: p.optedOutAt !== null,
      language: p.language,
    }));
    const reachable = own
      .filter((p) => p.consent?.email && p.optedOutAt === null)
      .sort((a, b) => rank(a) - rank(b));
    const chosen = reachable[0] ?? null;
    const reason = chosen
      ? null
      : !org
        ? "not linked to an organization in the directory"
        : contacts.length === 0
          ? "nobody at the vendor has an email address in the directory"
          : "nobody at the vendor has agreed to email from us";
    out.push({
      vendorId: v.id,
      vendorName: v.name,
      organizationId: org?.id ?? null,
      contactId: chosen?.id ?? null,
      contactName: chosen?.name ?? null,
      contacts,
      reason,
    });
  }
  return out;
}
