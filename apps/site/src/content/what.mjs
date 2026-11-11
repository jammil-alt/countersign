// @ts-check
// The lists on "What we do" (/): the hub, the connectors, the team, the gap chart and the
// purchasing run. Headlines and paragraphs are in pages/index.html.

/** @typedef {import("./shared.mjs").Icon} Icon */

/**
 * The tools around Mezonas in the hub diagram. `x` and `y` are percent of the square box.
 * @type {{ name: string, what: string, icon: Icon, x: number, y: number, kind: "system" | "you" | "person" }[]}
 */
export const HUB = [
  { name: "Accounting", what: "Books, bills, invoices", icon: "db", x: 50, y: 14, kind: "system" },
  {
    name: "Bank and cards",
    what: "Transactions, read only",
    icon: "chart",
    x: 78.1,
    y: 27.5,
    kind: "system",
  },
  {
    name: "CRM and sales",
    what: "Leads, quotes, deals",
    icon: "target",
    x: 85.1,
    y: 58,
    kind: "system",
  },
  { name: "Email", what: "Quotes and bills", icon: "mail", x: 65.6, y: 82.4, kind: "system" },
  {
    name: "Phone and text",
    what: "Vendors, customers",
    icon: "chat",
    x: 34.4,
    y: 82.4,
    kind: "system",
  },
  { name: "You", what: "Sign on Your Desk", icon: "pen", x: 14.9, y: 58, kind: "you" },
  {
    name: "Your team",
    what: "Texts, just like today",
    icon: "people",
    x: 21.9,
    y: 27.5,
    kind: "person",
  },
];

/**
 * Packets moving along the hub's spokes: from, to, delay in seconds, and colour (slate for
 * agents' work, copper for your team, gold for what waits on you).
 * @type {{ from: [number, number], to: [number, number], begin: number, tone: "slate" | "copper" | "signal" }[]}
 */
export const HUB_PACKETS = [
  { from: [50, 14], to: [50, 50], begin: 0, tone: "slate" },
  { from: [50, 50], to: [50, 14], begin: 1.3, tone: "slate" },
  { from: [78.1, 27.5], to: [50, 50], begin: 0.4, tone: "slate" },
  { from: [85.1, 58], to: [50, 50], begin: 0.8, tone: "slate" },
  { from: [50, 50], to: [85.1, 58], begin: 2.1, tone: "slate" },
  { from: [65.6, 82.4], to: [50, 50], begin: 1.1, tone: "slate" },
  { from: [50, 50], to: [34.4, 82.4], begin: 1.7, tone: "slate" },
  { from: [21.9, 27.5], to: [50, 50], begin: 0.6, tone: "copper" },
  { from: [50, 50], to: [14.9, 58], begin: 2, tone: "signal" },
];

/** @type {Record<string, { label: string, icon: Icon }>} */
export const CONNECTOR_CATEGORIES = {
  acct: { label: "Accounting", icon: "db" },
  pay: { label: "Payments and banking", icon: "card" },
  crm: { label: "CRM and sales", icon: "target" },
  comm: { label: "Email and chat", icon: "mail" },
  files: { label: "Files", icon: "folder" },
  mkt: { label: "Marketing", icon: "mega" },
};

/**
 * The connectors shown, each one a connector the platform has (packages/connectors). The design
 * also showed Xero, NetSuite, Odoo, Pipedrive, Microsoft 365 and Google Ads; they come back
 * here when they are built (HANDOFF: "keep it to what you can actually connect").
 * `logo` is a file in src/logos, shown `height` pixels tall.
 * @type {{ name: string, cat: keyof typeof CONNECTOR_CATEGORIES, logo: string, height: number }[]}
 */
export const CONNECTORS = [
  { name: "QuickBooks", cat: "acct", logo: "quickbooks.svg", height: 30 },
  { name: "BILL", cat: "acct", logo: "bill.png", height: 28 },
  { name: "Stripe", cat: "pay", logo: "stripe.svg", height: 26 },
  { name: "Plaid", cat: "pay", logo: "plaid.png", height: 30 },
  { name: "Ramp", cat: "pay", logo: "ramp.svg", height: 22 },
  { name: "HubSpot", cat: "crm", logo: "hubspot.svg", height: 28 },
  { name: "Zoho", cat: "crm", logo: "zoho.svg", height: 24 },
  { name: "Podio", cat: "crm", logo: "podio.svg", height: 30 },
  { name: "Gmail", cat: "comm", logo: "gmail.svg", height: 24 },
  { name: "Outlook", cat: "comm", logo: "outlook.svg", height: 30 },
  { name: "Slack", cat: "comm", logo: "slack.svg", height: 28 },
  { name: "Google Chat", cat: "comm", logo: "google-chat.svg", height: 28 },
  { name: "WhatsApp", cat: "comm", logo: "whatsapp.svg", height: 30 },
  { name: "Google Drive", cat: "files", logo: "google-drive.svg", height: 28 },
  { name: "Google Sheets", cat: "files", logo: "google-sheets.svg", height: 30 },
  { name: "Bing", cat: "mkt", logo: "bing.svg", height: 30 },
  { name: "LinkedIn", cat: "mkt", logo: "linkedin.svg", height: 28 },
];

/**
 * The agents on the org chart, under Sloan. Sample names (HANDOFF, open items).
 * @type {{ name: string, role: string, line: string, tools: [string, Icon][] }[]}
 */
export const TEAM = [
  {
    name: "Rae",
    role: "Sales",
    line: "Follows up on every lead and open quote.",
    tools: [
      ["CRM", "target"],
      ["Email", "mail"],
      ["Text", "chat"],
    ],
  },
  {
    name: "Pia",
    role: "Purchasing",
    line: "Makes sure you pay what you were quoted.",
    tools: [
      ["Accounting", "db"],
      ["Email", "mail"],
      ["Phone", "chat"],
    ],
  },
  {
    name: "Cal",
    role: "Collections",
    line: "Gets you paid without you chasing.",
    tools: [
      ["Accounting", "db"],
      ["Email", "mail"],
      ["Text", "chat"],
    ],
  },
  {
    name: "Bea",
    role: "Bookkeeping",
    line: "Keeps your books matched to the bank.",
    tools: [
      ["Bank feeds", "chart"],
      ["Accounting", "db"],
    ],
  },
  {
    name: "Finn",
    role: "Planning",
    line: "Tells you where the cash is going.",
    tools: [
      ["Accounting", "db"],
      ["CRM", "target"],
    ],
  },
];

/** The gap chart's scale, left to right. */
export const GAP_SCALE = ["When it hurts", "Monthly", "Weekly", "Every time"];

/**
 * Each row: where you are today and where the best competitors are, as steps on GAP_SCALE.
 * @type {{ label: string, you: number, best: number, now: string, bestText: string }[]}
 */
export const GAP_ROWS = [
  {
    label: "Sales follow-up",
    you: 0,
    best: 3,
    now: "Leads go cold after the first call",
    bestText: "Every lead and quote followed up",
  },
  {
    label: "Bills",
    you: 0,
    best: 3,
    now: "Paid as they come in",
    bestText: "Every bill checked against its quote",
  },
  {
    label: "Purchasing",
    you: 0,
    best: 3,
    now: "Reorder from the usual vendor",
    bestText: "Quotes compared before every buy",
  },
  {
    label: "Collections",
    you: 0,
    best: 3,
    now: "Chased when cash gets tight",
    bestText: "Followed up from day one",
  },
  { label: "Books", you: 0, best: 2, now: "Cleaned up at tax time", bestText: "Clean every week" },
  {
    label: "Job costing",
    you: 0,
    best: 3,
    now: "Nobody knows which jobs made money",
    bestText: "Every job costed",
  },
  { label: "Decisions", you: 0, best: 2, now: "Gut call", bestText: "Options with numbers first" },
];

/**
 * The purchasing run. It ticks every 1.1 seconds through RUN_TICKS ticks; each stage starts at
 * its `start` tick. Sample shop, vendors and prices.
 */
export const RUN_TICKS = 22;

export const RUN_STAGES = [
  { label: "Crew asks", start: 0 },
  { label: "Pia builds the list", start: 4 },
  // Picking this stage jumps to tick 13: every vendor has answered.
  { label: "Pia asks vendors", start: 8, pick: 13 },
  { label: "Compares quotes", start: 14 },
  { label: "You sign", start: 18 },
];

/** @type {{ from: string, text: string, ours?: boolean }[]} */
export const RUN_TEXTS = [
  {
    from: "Marco, shop lead",
    text: "Need 40 sheets 3/4 birch and 12 boxes of soft-close hinges for the Hughes job. Need it Thursday.",
  },
  { from: "Jen, install", text: "Add 6 tubes of adhesive." },
  { from: "Pia", text: "Got it. Pricing it now.", ours: true },
];

export const RUN_ITEMS = [
  { qty: "40", name: "Baltic birch plywood, 3/4 in.", match: "Sheets · last paid $97.50" },
  { qty: "12", name: "Soft-close hinges", match: "Boxes of 10 · last paid $23.00" },
  { qty: "6", name: "Construction adhesive", match: "Tubes · last paid $5.90" },
];

/**
 * Each vendor answers at tick 9 + its place in the list. `tone`: positive for the one we pick,
 * signal for a catch (late, partial), none otherwise.
 * @type {{ name: string, channel: string, icon: Icon, waiting: string, reply: string, tag: string, tone?: "positive" | "signal" }[]}
 */
export const RUN_VENDORS = [
  {
    name: "Lone Star Panel",
    channel: "Phone call",
    icon: "phone",
    waiting: "Calling…",
    reply: "“All in stock. Birch at $98.00. We can deliver Thursday.”",
    tag: "Full list · Thu",
    tone: "positive",
  },
  {
    name: "Hardwood Depot",
    channel: "Email quote",
    icon: "mail",
    waiting: "Waiting on reply…",
    reply: "Quote attached: birch $104.00, hinges $22.00.",
    tag: "Full list · Fri",
    tone: "signal",
  },
  {
    name: "Metro Cabinet Supply",
    channel: "Text",
    icon: "chat",
    waiting: "Texting…",
    reply: "“Hinges yes. Birch out until Tuesday.”",
    tag: "Partial",
    tone: "signal",
  },
  {
    name: "BuildMart",
    channel: "Website price check",
    icon: "web",
    waiting: "Checking site…",
    reply: "Everything listed. Birch at $112.50.",
    tag: "Full list · Wed",
  },
];

/**
 * Totals for the full list, in dollars as strings (money is decimal). `best` is the pick; a
 * vendor with no total couldn't fill the list.
 * @type {{ name: string, total: string | null, day: string, ok: boolean, best?: boolean }[]}
 */
export const RUN_QUOTES = [
  { name: "Lone Star Panel", total: "4251.50", day: "Thu", ok: true, best: true },
  { name: "Hardwood Depot", total: "4459.40", day: "Fri · late", ok: false },
  { name: "BuildMart", total: "4844.88", day: "Wed", ok: true },
  { name: "Metro Cabinet", total: null, day: "No birch", ok: false },
];
