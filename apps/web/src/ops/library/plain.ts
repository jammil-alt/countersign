// Plain words for the Library's tools: a short title and a one-line description a person can scan,
// with the tool's own description (written for the model) kept whole in its side sheet. Pure.
//
// DECISION (2026-11-12, UI only): the titles and the few rewritten lines are UI copy kept here, not
// fields on the tool spec. A tool this map doesn't know reads by `toolLabel` (its id in words) and
// the first sentence of its description (`brief`), so a new tool still shows sensibly. When a
// tool spec grows a `title`, it replaces this map.
import type { LibraryTool } from "@countersign/core";
import { toolLabel } from "../../runs/labels";
import { brief } from "../../ui/brief";

/** Titles for the tools `toolLabel` has no words for (it names the writes the runs show). */
export const TOOL_TITLES: Record<string, string> = {
  // The platform's own
  "inbox.create": "Ask a person",
  "threads.post": "Post a note to the run",
  "threads.read": "Read a thread",
  "memory.write": "Remember a note",
  "docs.get": "Get a document",
  "docs.read": "Read a document",
  "docs.extract": "Read a document's lines",
  "docs.find_support": "Find a transaction's document",
  "docs.match_bill": "Match an invoice to its bill",
  "docs.plan_bill": "Compare an invoice with its bill",
  "docs.bill_lines": "Build a bill's lines",
  "docs.totals.check": "Check a document's totals",
  "docs.reading.record": "Save a document's reading",
  "docs.bill.check": "Check a prepared bill",
  "knowledge.search": "Search the client's knowledge",
  "knowledge.voice_samples": "Get writing samples",
  "directory.search": "Find people and organizations",
  "directory.get": "Read a directory entry",
  "directory.suggest": "Suggest a directory change",
  "ledger.accounts.list": "List the chart of accounts",
  "ledger.dimensions.list": "List classes and locations",
  "comms.reach_out": "Reach out to a person",
  "comms.converse": "Hold a conversation",
  "comms.translate": "Translate a message",
  "inbound.get": "Read the message that started it",
  "data.reshape": "Reshape data",
  "health.runs": "Read recent runs",
  "health.connections": "Read connections",
  "health.inbox": "Read what's waiting",
  "health.agents": "Read the client's agents",
  "agents.ask": "Ask another agent",
  "supervisor.report": "Explain an event",
  "supervisor.check": "Run the daily health check",
  "account.services": "List the client's services",
  "account.runs": "List recent runs",
  "account.run": "Read a run's timeline",
  "account.waiting": "List what's waiting",
  "account.explain_wait": "Explain why something waits",
  "account.pause_agent": "Pause a service",
  "account.resume_agent": "Resume a service",
  "account.draft_change": "Draft an account change",
  "account.pass_to_lead": "Pass to the Mezonas lead",
  "account.pass_to_agent": "Pass to a service",
  // QuickBooks
  "qbo.purchase.query": "Find purchases",
  "qbo.bill.query": "Find bills",
  "qbo.vendor.query": "Find vendors",
  "qbo.item.query": "Find products and services",
  "qbo.attachable.list": "List attachments",
  "qbo.invoice.query": "Find invoices",
  "qbo.customer.query": "Find customers",
  "qbo.payment.query": "Find customer payments",
  "qbo.aging_report": "Read the receivables aging",
  "qbo.account.query": "Find accounts",
  "qbo.class.query": "Find classes",
  "qbo.purchaseorder.query": "Find purchase orders",
  "qbo.purchase.create": "Book an expense",
  "qbo.deposit.create": "Book a deposit",
  "qbo.transfer.create": "Book a transfer",
  "qbo.account.create": "Add an account",
  "qbo.account.update": "Change an account",
  "qbo.class.create": "Add a class",
  "qbo.class.update": "Change a class",
  "qbo.location.create": "Add a location",
  "qbo.location.update": "Change a location",
  "qbo.account.register": "Read an account's register",
  // Other connectors
  "website.publish": "Publish a guide",
  "website.meta": "Change a page's search title",
  "zoho_crm.record.search": "Find records",
  "zoho_crm.record.get": "Read a record",
  "podio.space.list": "List workspaces",
  "podio.app.list": "List apps",
  "podio.app.get": "Read an app's fields",
  "podio.item.filter": "Find items",
  "podio.item.get": "Read an item",
  "messages.search": "Find messages",
  "message.get": "Read a message",
  "call.get": "Read a call",
  "drive.file.list": "List filed documents",
  "sheets.range.read": "Read cells",
  "ramp.transaction.query": "Find card transactions",
  "ramp.user.query": "Find people",
  "hubspot.record.search": "Find records",
  "hubspot.record.get": "Read a record",
  "bankfeed.transaction.query": "Find transactions",
  "bankfeed.account.query": "List accounts and cards",
  "browser.page.read": "Read a web page",
  "browser.file.download": "Download a file",
  "browser.script.read": "Run a script that reads",
  "browser.script.submit": "Run a script that submits",
  // Materials
  "materials.catalog.search": "Search the catalog",
  "materials.catalog.create_item": "Add a catalog item",
  "materials.catalog.duplicates": "Find possible duplicates",
  "materials.catalog.match-text": "Match descriptions to the catalog",
  "materials.match_line": "Match a line to the catalog",
  "materials.match_lines": "Match a document's lines",
  "materials.lines.lookup": "Look up lines in the catalog",
  "materials.matches.check": "Check line matches",
  "materials.matches.record": "Save line matches",
  "materials.prices.record": "Record prices",
  "materials.prices.check": "Check prices for alerts",
  "materials.prices.compare": "Compare prices",
  "materials.prices.history": "Read an item's price history",
  "materials.prices.compare_vendors": "Compare vendors' prices",
  "materials.prices.digest": "Sum up the week in prices",
  "materials.backfill-from-bills": "Learn from past bills",
  "materials.vendors-for-items": "Find who sold each item",
  "materials.frequent-items": "List the most-bought items",
  "materials.vendor-contacts": "Find vendor contacts",
  "materials.vendor.qbo": "Link a vendor to QuickBooks",
  "materials.request.create": "Open a purchase request",
  "materials.request.get": "Read a purchase request",
  "materials.request.list": "List purchase requests",
  "materials.request.update": "Update a purchase request",
  "materials.request.add-lines": "Add lines to a request",
  "materials.request.update-lines": "Change a request's lines",
  "materials.request.match-lines": "Match a request's lines",
  "materials.quote.create": "Draft quote requests",
  "materials.quote.mark-sent": "Mark a quote request sent",
  "materials.quote.get": "Read a quote request",
  "materials.quote.record": "Record a vendor's quote",
  "materials.quote.compare": "Compare quotes",
  "materials.quote.expire": "Expire unanswered quotes",
  "materials.quote.document": "Make a quote request PDF",
  "materials.quote.chosen": "Read the chosen vendor",
  "materials.po.document": "Make a purchase order PDF",
  "materials.po.qbo-lines": "Prepare a QuickBooks purchase order",
  // Marketing
  "marketing.site.figures": "Read the week's site figures",
  "marketing.site.page": "Read one page's figures",
  "marketing.search.figures": "Read search figures",
  "marketing.content.get": "Read the site's guides",
  "marketing.content.draft": "Save a draft guide",
  "marketing.content.check": "Check a guide",
  "marketing.article.draft": "Save an article draft",
  "marketing.report.record": "Save the weekly report",
  "marketing.report.get": "Read a weekly report",
  "marketing.titles.check": "Check proposed titles",
  "marketing.social.check": "Check a LinkedIn post",
  "marketing.forum.threads.unseen": "Find unseen threads",
  "marketing.forum.thread.mark": "Mark a thread seen",
  "marketing.forum.reply.draft": "Draft a forum reply",
  // Bookkeeping
  "bookkeeping.transactions.import": "Import bank transactions",
  "bookkeeping.transactions.settle": "Settle what rules can",
  "bookkeeping.transactions.open": "List undecided transactions",
  "bookkeeping.transactions.to-review": "List transactions to review",
  "bookkeeping.accounts.list": "List the chart of accounts",
  "bookkeeping.accounts.unclear": "List unclear accounts",
  "bookkeeping.account.note": "Note what an account is for",
  "bookkeeping.booking.propose": "Propose a booking",
  "bookkeeping.booking.qbo-input": "Prepare a QuickBooks booking",
  "bookkeeping.booking.posted": "Record a posted booking",
  "bookkeeping.bookings.ready": "List bookings ready to post",
  "bookkeeping.reconcile": "Reconcile two balances",
  "bookkeeping.reconcile.pairs": "List accounts to reconcile",
  "bookkeeping.reconcile.open": "Read a reconciliation",
  "bookkeeping.reconcile.propose": "Propose matches for leftovers",
};

/**
 * One-line descriptions for the tools whose first sentence still reads as code (field names,
 * internal ids, how it's built). The rest read well as `brief` makes them.
 */
export const TOOL_LINES: Record<string, string> = {
  "docs.get": "A document's details, a short-lived link to the file, and its latest reading.",
  "docs.read": "A document and what was read from it, reading it first if nobody has yet.",
  "docs.totals.check": "Checks that a document's lines add up to its subtotal and its total.",
  "docs.reading.record": "Saves what was read from a document as its latest reading.",
  "drive.file.upload": "Files a document in the client's Google Drive, in the Mezonas folder.",
  "directory.suggest":
    "Suggests adding or changing a person or organization in the directory, with the reason.",
  "supervisor.check":
    "Looks over this client's runs, connections and agents, and reports what needs a person.",
  "qbo.purchase.query": "Find purchases in QuickBooks by payee or date, with their lines.",
  "qbo.bill.query": "Find bills in QuickBooks by vendor, number or date, with their lines.",
  "website.publish": "Publishes a guide on the client's website, or takes one down.",
  "materials.match_lines": "Matches every line of a document to the client's catalog.",
  "materials.lines.lookup": "Looks up each line of a document in the client's catalog, by rules.",
  "materials.catalog.match-text":
    "Matches descriptions of materials to the client's catalog, by rules.",
  "materials.prices.check":
    "Checks a document's prices against what the client paid before, and raises an alert when one is off.",
  "materials.prices.compare":
    "Compares a document's prices with what the client paid before and what other vendors charge.",
  "materials.prices.digest":
    "The week in prices: what changed, the alerts raised and what they cost.",
  "materials.quote.compare": "Compares the quotes received for a purchase request.",
  "materials.po.document": "Makes a purchase order PDF from a request and the vendor's quote.",
  "materials.po.qbo-lines":
    "Turns a purchase request and its chosen quote into a QuickBooks purchase order, ready to create.",
  "materials.backfill-from-bills":
    "Turns the client's past QuickBooks bills into catalog matches and prices.",
  "bookkeeping.transactions.settle":
    "Settles the transactions rules can: skips accounts that are off and matches what's already in the books.",
  "bookkeeping.accounts.unclear":
    "Income and expense accounts nobody has described yet, to ask the client about.",
  "bookkeeping.bookings.ready": "Bookings proposed or approved and not yet in the accounting tool.",
  "bookkeeping.reconcile.pairs":
    "The client's bank and card accounts linked to a QuickBooks account, ready to reconcile.",
  "bookkeeping.reconcile.propose":
    "Proposes which leftover items on each side are the same money, each with a reason.",
};

/** One-line descriptions for the connectors whose description is a long list. */
export const CONNECTOR_LINES: Record<string, string> = {
  qbo: "Bills, invoices, vendors, customers and payments in your QuickBooks Online.",
};

/** A connector's one line for a list; the whole description is in its side sheet. */
export function connectorLine(c: { id: string; description: string }): string {
  return CONNECTOR_LINES[c.id] ?? brief(c.description);
}

/** A tool's title in plain words: "Find bills", "Book a deposit". */
export function toolName(id: string): string {
  return TOOL_TITLES[id] ?? toolLabel(id);
}

/** A tool's one line for a list; the whole description is in its side sheet. */
export function toolLine(tool: Pick<LibraryTool, "id" | "description">): string {
  return TOOL_LINES[tool.id] ?? brief(tool.description);
}
