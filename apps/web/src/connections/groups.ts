// What kind of tool each connector is, so the portal's Accounts page can list the tools still to
// connect in groups a client recognises (R8, docs/plan.md §1.86; ARCHITECTURE §10.14 "The Library
// and the client's settings"), with how each one connects.
//
// DECISION: the groups live here, by connector id, as ConnectorMark's brands do (./brands.ts),
// rather than as a new field of the connector manifest and the API contract: they are words on one
// screen, and packages/connectors is being changed by another stream. An unknown connector lands in
// "Other tools".
import type { PlainKey } from "../i18n/catalog";

export const CONNECTOR_GROUPS = [
  "money",
  "email",
  "messages",
  "files",
  "sales",
  "web",
  "other",
] as const;
export type ConnectorGroup = (typeof CONNECTOR_GROUPS)[number];

const GROUP_OF: Record<string, ConnectorGroup> = {
  qbo: "money",
  bankfeed: "money",
  ramp: "money",
  billcom: "money",
  stripe: "money",
  gmail: "email",
  outlook: "email",
  resend: "email",
  twilio: "messages",
  whatsapp_meta: "messages",
  slack: "messages",
  gchat: "messages",
  elevenlabs: "messages",
  gdrive: "files",
  gsheets: "files",
  upload: "files",
  hubspot: "sales",
  zoho_crm: "sales",
  podio: "sales",
  linkedin: "sales",
  gsc: "web",
  gsc_oauth: "web",
  bing_webmaster: "web",
  website: "web",
  hackernews: "web",
};

export const GROUP_KEY: Record<ConnectorGroup, PlainKey> = {
  money: "accounts.group.money",
  email: "accounts.group.email",
  messages: "accounts.group.messages",
  files: "accounts.group.files",
  sales: "accounts.group.sales",
  web: "accounts.group.web",
  other: "accounts.group.other",
};

export function connectorGroup(connector: string): ConnectorGroup {
  return GROUP_OF[connector] ?? "other";
}

/** Items in the groups' order, each group's items as given; empty groups are left out. */
export function groupByConnector<T extends { connector: string }>(
  items: readonly T[],
): { group: ConnectorGroup; items: T[] }[] {
  return CONNECTOR_GROUPS.map((group) => ({
    group,
    items: items.filter((i) => connectorGroup(i.connector) === group),
  })).filter((g) => g.items.length > 0);
}
