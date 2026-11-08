// Inviting a person from the directory to sign in (docs/plan.md §1.27, 2026-11-08). Only the
// client's own people get a login: an employee or a contractor, or anyone whose organization is the
// client's own, and only with an email address. Vendors, customers, partners and others never do.
// Pure: the API enforces it, the screens use it to offer the button.

import { z } from "zod";
import type { OrganizationKind, Relationship } from "./kinds";

/** Relationships that are the client's own people. */
const OWN_RELATIONSHIPS: readonly Relationship[] = ["employee", "contractor"];

export interface InvitableContact {
  relationship?: Relationship | null | undefined;
  email?: string | null | undefined;
}

export interface InvitableOrganization {
  kinds?: readonly OrganizationKind[] | null | undefined;
}

/** Whether a person is one of the client's own people (whatever their email). */
export function isOwnPerson(
  contact: InvitableContact,
  organization?: InvitableOrganization | null,
): boolean {
  if (contact.relationship && OWN_RELATIONSHIPS.includes(contact.relationship)) return true;
  return (organization?.kinds ?? []).includes("own");
}

/**
 * Whether a person may be invited to sign in: one of the client's own people, with an email.
 * Whether they are already a member is the invite's own check.
 */
export function canInviteContact(
  contact: InvitableContact,
  organization?: InvitableOrganization | null,
): boolean {
  return isOwnPerson(contact, organization) && !!contact.email?.trim();
}

/** Whether a person can sign in: a member of the client, or invited and not signed in yet. */
export const ContactAccess = z.enum(["member", "invited"]);
export type ContactAccess = z.infer<typeof ContactAccess>;

export interface AccessMember {
  email: string;
  /** False: invited, not signed in yet; null where sign-in can't tell (the dev sign-in). */
  signedIn: boolean | null;
}

/**
 * A person's access by their email (lower case) among the client's members: `member` when a member
 * has it, `invited` when that member hasn't signed in yet, else null.
 */
// DECISION: an invite is a membership (docs/plan.md §1.14), so "invited" is a member whose sign-in
// says they haven't signed in yet. Where sign-in can't tell (the dev sign-in), they are a member,
// as the Team page shows them.
export function contactAccess(
  email: string | null | undefined,
  members: readonly AccessMember[],
): ContactAccess | null {
  const key = email?.trim().toLowerCase();
  if (!key) return null;
  const m = members.find((x) => x.email.trim().toLowerCase() === key);
  if (!m) return null;
  return m.signedIn === false ? "invited" : "member";
}
