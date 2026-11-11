// Plain names for the platform's internal ids wherever people would otherwise see them (UI
// cleanup, decision 3: raw names never show): event types, the tools a step changes, skills, roles
// and schedules. One source for the builder, the workflow views and the run pages. Back office
// words (English); the portal never shows these ids at all.
// DECISION: the labels live in the web app, not in the tool and event specs, so no connector
// manifest or event registration changes for them; an id with no label here reads as words built
// from it ("Update record"), never as the raw id.

/** The trigger kinds the palette and the trigger picker group events under. */
export type TriggerKind =
  | "document"
  | "schedule"
  | "record"
  | "person"
  | "message"
  | "webhook"
  | "other";

export const TRIGGER_KINDS: { kind: TriggerKind; label: string }[] = [
  { kind: "document", label: "A document arrives" },
  { kind: "schedule", label: "On a schedule" },
  { kind: "record", label: "A record changes" },
  { kind: "person", label: "A person asks" },
  { kind: "message", label: "A message arrives" },
  { kind: "webhook", label: "A webhook" },
  { kind: "other", label: "Something else happens" },
];

/** Each event type as a clause after "When …", and the kind it is grouped under. */
const EVENTS: Record<string, { label: string; kind: TriggerKind }> = {
  "document.received": { label: "a document arrives", kind: "document" },
  "document.extracted": { label: "a document has been read", kind: "document" },
  "document.extraction_failed": { label: "a document can't be read", kind: "document" },
  "transaction.created": { label: "a bill or purchase arrives", kind: "record" },
  "transaction.updated": { label: "a bill or purchase changes", kind: "record" },
  "receivable.created": { label: "a customer invoice arrives", kind: "record" },
  "receivable.updated": { label: "a customer invoice changes", kind: "record" },
  "receivable.paid": { label: "a customer invoice is paid", kind: "record" },
  "zoho_crm.record.changed": { label: "a Zoho CRM record changes", kind: "record" },
  "ramp.transaction.created": { label: "a Ramp card transaction arrives", kind: "record" },
  "card.charge.created": { label: "a card charge arrives", kind: "record" },
  "bank.transaction.created": { label: "a bank transaction arrives", kind: "record" },
  "external_action.done": { label: "a change to a tool is made", kind: "record" },
  "external_action.failed": { label: "a change to a tool fails", kind: "record" },
  "inbox.resolved": { label: "someone answers an approval or question", kind: "person" },
  "account.request_passed": { label: "Sloan passes on a client's request", kind: "person" },
  "thread.message_posted": { label: "someone posts in a thread", kind: "person" },
  "inbound.message": { label: "someone messages the agent", kind: "message" },
  "message.received": { label: "a text or WhatsApp message arrives", kind: "message" },
  "message.status": { label: "a sent message is delivered or fails", kind: "message" },
  "call.received": { label: "a call comes in", kind: "message" },
  "call.completed": { label: "a call ends", kind: "message" },
  "webhook.received": { label: "a webhook arrives", kind: "webhook" },
  "schedule.tick": { label: "a scheduled time comes round", kind: "schedule" },
  "run.succeeded": { label: "another agent's run finishes", kind: "other" },
  "run.failed": { label: "a run fails", kind: "other" },
  "alert.raised": { label: "an agent raises an alert", kind: "other" },
  "connection.needs_attention": { label: "a connection needs attention", kind: "other" },
  "health.checked": { label: "the daily health check finishes", kind: "other" },
};

/** "document.extracted" → "a document has been read". */
export function eventLabel(type: string): string {
  const known = EVENTS[type]?.label;
  if (known) return known;
  // An event we have no words for yet: its last parts as words, "record changed".
  return type.split(".").slice(-2).join(" ").replace(/[_-]+/g, " ");
}

/** "When a document has been read". */
export function whenEvent(type: string): string {
  return `When ${eventLabel(type)}`;
}

export function eventKind(type: string): TriggerKind {
  return EVENTS[type]?.kind ?? "other";
}

/** The tools that change a client's tool, by id: what the step does, without the connector. */
const TOOLS: Record<string, string> = {
  "qbo.bill.update_lines": "Itemize a bill",
  "qbo.purchase.update_lines": "Itemize a purchase",
  "qbo.bill.update_memo": "Set a bill's memo",
  "qbo.purchase.update_memo": "Set a purchase's memo",
  "qbo.item.update_purchase_cost": "Update an item's purchase cost",
  "qbo.attachable.upload": "Attach a document",
  "qbo.invoice.add_note": "Add a note to a customer invoice",
  "qbo.bill.create": "Create a bill",
  // P-2: QuickBooks ingredients (docs/plan.md §1.64).
  "qbo.vendor.create": "Add a vendor",
  "qbo.purchaseorder.create": "Create a purchase order",
  "webhook.event.send": "Send to the client's webhook",
  "zoho_crm.record.create": "Create a record",
  "zoho_crm.record.update": "Update a record",
  "zoho_crm.note.create": "Add a note",
  "zoho_crm.task.create": "Create a task",
  "podio.item.create": "Create an item",
  "podio.item.update": "Update an item",
  "podio.comment.create": "Add a comment",
  "podio.task.create": "Create a task",
  "sms.send": "Send a text",
  "whatsapp.send": "Send a WhatsApp message",
  "call.place": "Place a call",
  "call.answer": "Answer calls",
  "gmail.send": "Send an email",
  "outlook.send": "Send an email",
  "email.send": "Send an email",
  "drive.file.upload": "File a document in Drive",
  "sheets.rows.append": "Add rows to a sheet",
  "sheets.range.update": "Change cells in a sheet",
  "gchat.message.post": "Post a message",
  "slack.message.post": "Post a message",
  // §1.77
  "linkedin.post": "Post on LinkedIn",
  "hackernews.search": "Search Hacker News",
  "hackernews.thread": "Read a Hacker News thread",
  "web.search": "Search the web",
  "web.fetch": "Read a web page",
  "ramp.receipt.upload": "Upload a receipt",
  // §1.87
  "billcom.vendor.search": "Find vendors",
  "billcom.vendor.get": "Read a vendor",
  "billcom.vendor.create": "Add a vendor",
  "billcom.vendor.update": "Update a vendor",
  "billcom.bill.list": "Find bills",
  "billcom.bill.get": "Read a bill",
  "billcom.bill.create": "Create a bill",
  "billcom.bill.update": "Update a bill",
  "billcom.bill.archive": "Archive a bill",
  "billcom.bill.attach_document": "Attach a document to a bill",
  "billcom.payment.list": "Find payments",
  "billcom.payment.get": "Read a payment",
  "billcom.payment.create": "Pay a bill",
  "hubspot.record.create": "Create a record",
  "hubspot.record.update": "Update a record",
  "hubspot.note.create": "Add a note",
  "hubspot.task.create": "Create a task",
  "testkit.record.update": "Update a record",
  "testkit.record.query": "Find records",
};

/** "qbo.bill.update_lines" → "Itemize a bill"; an unknown id → "Update lines bill". */
export function toolLabel(id: string): string {
  const known = TOOLS[id];
  if (known) return known;
  const parts = id.split(".");
  const verb = parts.at(-1) ?? id;
  const thing = parts.slice(1, -1).join(" ");
  return words(`${verb}${thing ? ` ${thing}` : ""}`);
}

/** Who a person step or an approval goes to, as people say it. */
export const ROLE_LABEL: Record<string, string> = {
  client_admin: "client admin",
  client_user: "client user",
  operator: "operator",
  lead: "the client's lead",
};

/** A role id in words; a person's id (no name to hand) as "a person". */
export function roleLabel(value: string): string {
  return ROLE_LABEL[value] ?? "a person";
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A cron schedule in words where it is a common one: "Weekdays at 7:00", "Every day at 18:30",
 * "Mondays at 9:00"; anything else as its cron, which the builder's field explains.
 */
export function cronText(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== "*" || mon !== "*") return cron;
  const at = `${Number(hour)}:${min.padStart(2, "0")}`;
  if (dow === "*") return `Every day at ${at}`;
  if (dow === "1-5") return `Weekdays at ${at}`;
  if (/^[0-6]$/.test(dow)) return `${DAYS[Number(dow)]}s at ${at}`;
  return cron;
}

/** "update_lines bill" → "Update lines bill". */
function words(text: string): string {
  const out = text
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Connector names people know, for ids without a manifest name at hand. */
const CONNECTOR_NAMES: Record<string, string> = {
  qbo: "QuickBooks",
  gmail: "Gmail",
  outlook: "Outlook",
  gsheets: "Google Sheets",
  drive: "Google Drive",
  gchat: "Google Chat",
  gsc: "Search Console",
  bing_webmaster: "Bing Webmaster Tools",
  slack: "Slack",
  // §1.77
  linkedin: "LinkedIn",
  hackernews: "Hacker News",
  zoho_crm: "Zoho CRM",
  podio: "Podio",
  hubspot: "HubSpot",
  ramp: "Ramp",
  billcom: "BILL",
  docs: "Documents",
  upload: "Upload",
  testkit: "Testkit",
};

/** "qbo" → "QuickBooks"; an unknown connector id in words. */
export function connectorLabel(id: string): string {
  return CONNECTOR_NAMES[id] ?? words(id);
}

/**
 * A tool or skill with its connector, where the step around it doesn't name one (run pages):
 * "qbo.bill.update_lines" → "QuickBooks · Itemize a bill", "docs.match-bill" → "Documents · Match bill".
 */
export function qualifiedToolLabel(id: string, connectorName?: string | null): string {
  const [head = id, ...rest] = id.split(".");
  const connector = connectorName ?? connectorLabel(head);
  return rest.length > 0 ? `${connector} · ${toolLabel(id)}` : connector;
}
