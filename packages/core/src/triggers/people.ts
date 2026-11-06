// Who may start a message trigger (ARCHITECTURE §10.8): a filter over the client's People, matched
// on the sender's contact (by address or number) or the posting user's membership. Pure; apps/api
// loads the sender's facts inside the client's transaction.

import { z } from "zod";
import { Relationship } from "../directory/kinds";
import { CLIENT_ROLES } from "../roles";

const Id = z.uuid();

export const ClientRole = z.enum(CLIENT_ROLES);
export type ClientRole = z.infer<typeof ClientRole>;

/** ARCHITECTURE §10.1 `PeopleFilter`. */
export const PeopleFilter = z.strictObject({
  /** What the person is to the client (`contact.relationship`). */
  relationships: z.array(Relationship).max(10).optional(),
  /** Labels on the contact (`contact.roles`, e.g. `cardholder`). */
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  contactIds: z.array(Id).max(100).optional(),
  /** Members of the client who post a command or ask Sloan. */
  clientRoles: z.array(ClientRole).max(2).optional(),
});
export type PeopleFilter = z.infer<typeof PeopleFilter>;

/** What the platform knows about who sent a message, read from the client's own records. */
export type SenderFacts =
  | {
      kind: "contact";
      contactId: string;
      relationship: string | null;
      /** `contact.roles`. */
      tags: readonly string[];
    }
  | { kind: "user"; userId: string; role: "operator" | ClientRole }
  /** Nobody the client knows: an address or number with no contact, or one not proven (DMARC). */
  | { kind: "stranger" };

// DECISION: a filter lists who may start the workflow and a sender matches when they meet any one
// of its lists (a listed contact, or a contact with one of the relationships or tags, or a member
// with one of the roles). An empty filter matches nobody: the operator says who, so a contact made
// for an unknown number (Twilio's inbound path makes one) never starts work by default. An
// operator serving the client may always start it from a client thread, as with a manual trigger.
export function matchesPeople(filter: PeopleFilter, sender: SenderFacts): boolean {
  switch (sender.kind) {
    case "stranger":
      return false;
    case "user":
      if (sender.role === "operator") return true;
      return (filter.clientRoles ?? []).includes(sender.role);
    case "contact": {
      if ((filter.contactIds ?? []).includes(sender.contactId)) return true;
      if (
        sender.relationship &&
        (filter.relationships ?? []).some((r) => r === sender.relationship)
      )
        return true;
      const tags = new Set(sender.tags.map((t) => t.trim().toLowerCase()));
      return (filter.tags ?? []).some((t) => tags.has(t.trim().toLowerCase()));
    }
  }
}
