// What kind of tool each connector is, for Browse's groups (docs/connectors-plan.md §3.1).
// DECISION (docs/plan.md §1.157, C4): the same map as the web's `connections/groups.ts`, kept
// here so the API can send a card's group without the web depending on the API or the manifest
// gaining a field; an unknown connector is "other".

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

const GROUP_OF: Readonly<Record<string, ConnectorGroup>> = {
  qbo: "money",
  bankfeed: "money",
  ramp: "money",
  billcom: "money",
  odoo: "money",
  stripe: "money",
  gmail: "email",
  outlook: "email",
  resend: "email",
  twilio: "messages",
  whatsapp_meta: "messages",
  slack: "messages",
  gchat: "messages",
  teams: "messages",
  elevenlabs: "messages",
  gdrive: "files",
  gsheets: "files",
  onedrive: "files",
  excel: "files",
  upload: "files",
  desktop: "files",
  outlook_calendar: "other",
  gcal: "other",
  hubspot: "sales",
  zoho_crm: "sales",
  podio: "sales",
  linkedin: "sales",
  gsc: "web",
  gsc_oauth: "web",
  bing_webmaster: "web",
  website: "web",
  hackernews: "web",
  browser: "web",
};

export function connectorGroup(connector: string): ConnectorGroup {
  return GROUP_OF[connector] ?? "other";
}
