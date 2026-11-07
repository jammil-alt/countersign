// Plain names for the platform's internal ids where a run or a change shows them (decision 3 of
// the UI cleanup: raw names never show to people): event types, tool ids and skill ids. Back office
// words (English); the portal never shows these ids at all.

/** What happened, to follow "When": "When an invoice has been read". */
const EVENT_WORDS: Record<string, string> = {
  "transaction.created": "a transaction is added",
  "transaction.updated": "a transaction changes",
  "document.received": "a document arrives",
  "document.extracted": "an invoice has been read",
  "document.extraction_failed": "an invoice can't be read",
  "inbox.resolved": "someone answers an inbox item",
  "external_action.done": "a change is made in a tool",
  "external_action.failed": "a change to a tool fails",
  "alert.raised": "an alert is raised",
  "schedule.tick": "the schedule comes round",
  "run.failed": "a run fails",
  "run.succeeded": "another agent finishes",
  "connection.needs_attention": "a connection needs attention",
  "health.checked": "the account check finishes",
  "receivable.created": "an invoice to a customer is added",
  "receivable.updated": "an invoice to a customer changes",
  "receivable.paid": "a customer pays an invoice",
  "thread.message_posted": "a message is posted",
  "inbound.message": "someone sends a message",
  "account.request_passed": "a request is passed on",
  "webhook.received": "a webhook arrives",
};

/** "document.extracted" → "an invoice has been read"; an unknown type in plain words. */
export function eventLabel(type: string): string {
  return EVENT_WORDS[type] ?? words(type);
}

/** Connector names people know, for ids without a manifest name at hand. */
const CONNECTOR_NAMES: Record<string, string> = {
  qbo: "QuickBooks",
  gmail: "Gmail",
  gsheets: "Google Sheets",
  gchat: "Google Chat",
  zoho_crm: "Zoho CRM",
  hubspot: "HubSpot",
  docs: "Documents",
  upload: "Upload",
  testkit: "Testkit",
};

/**
 * A tool or skill id in plain words: "qbo.bill.update_lines" → "QuickBooks: bill update lines",
 * "docs.match-bill" → "Documents: match bill".
 */
export function toolLabel(id: string, connectorName?: string | null): string {
  const [head = id, ...rest] = id.split(".");
  const connector = connectorName ?? CONNECTOR_NAMES[head] ?? capital(words(head));
  return rest.length > 0 ? `${connector}: ${words(rest.join(" "))}` : connector;
}

function words(id: string): string {
  return id
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
