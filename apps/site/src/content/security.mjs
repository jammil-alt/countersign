// @ts-check
// The lists on Security (/security). Headlines are in pages/security.html. Each claim here must
// stay true of the platform (apps/site/README.md, "Keeping it true").

export const SECURITY = [
  {
    t: "Walled off per client",
    d: "Each client’s data is kept apart down to the row, and its logins are encrypted with its own key. No shared memory between clients.",
  },
  { t: "Least access", d: "Read-only where possible, send-only email. Agents can’t move money." },
  {
    t: "Masking before AI",
    d: "Account numbers and personal details will be replaced before any model sees them.",
    // Not built yet (the masking plan); the page labels it "Coming soon" until it ships.
    soon: true,
  },
  { t: "Never used for training", d: "Enterprise terms with every AI provider bar it." },
  {
    t: "Every access logged",
    d: "Including our own team’s. Held to enterprise-grade security compliance standards.",
  },
];

export const INTEGRITY = [
  { t: "Nothing posts without approval", d: "Agents propose. A person approves." },
  { t: "Before and after on every change", d: "You see exactly what moves in your books." },
  {
    t: "Every number has a receipt",
    d: "Each result links to the bill, email or record behind it.",
  },
  { t: "Checked twice", d: "A second agent, then your Mezonas lead." },
  { t: "Full audit trail", d: "Every step, who did it, and when." },
];

/**
 * The masking demo: what you see, and what the model sees in its place. A masked value is
 * written with its brackets as entities in the page, so the build doesn't take it for a
 * placeholder still to fill in.
 * @type {{ label: string, real: string, masked?: string }[]}
 */
export const MASKED_FIELDS = [
  { label: "Vendor", real: "Lone Star Panel", masked: "VENDOR_14" },
  { label: "Vendor phone", real: "(214) 555-0142", masked: "PHONE_3" },
  { label: "Remit-to account", real: "Account ending 4417", masked: "BANK_ACCOUNT_1" },
  { label: "Item", real: "Baltic birch 3/4 in. × 40 at $98.00" },
  { label: "Total", real: "$4,251.50" },
];

/** @type {{ time: string, what: string, src: string, who: string, tone: "agent" | "person" | "you" | "positive" }[]} */
export const WORKSHEET = [
  { time: "9:02", what: "Read the bill", src: "INV-20431 · email", who: "Pia", tone: "agent" },
  {
    time: "9:03",
    what: "Matched it to the quote",
    src: "Q-1182 · p. 1",
    who: "Pia",
    tone: "agent",
  },
  { time: "9:05", what: "Checked count on delivery", src: "DT-5521", who: "Sloan", tone: "agent" },
  { time: "10:40", what: "Reviewed and approved", src: "Note added", who: "Ana", tone: "person" },
  { time: "11:15", what: "Signed", src: "Your Desk", who: "You", tone: "you" },
  {
    time: "11:15",
    what: "Posted to your accounting system",
    src: "Before $4,210 → after $3,900",
    who: "Done",
    tone: "positive",
  },
];

/** @type {{ sys: string, note: string, level: string, tone: "agent" | "you" | "risk" }[]} */
export const PERMISSIONS = [
  {
    sys: "Accounting system",
    note: "Reads your books. Writes only what you signed.",
    level: "Read · write after you sign",
    tone: "you",
  },
  {
    sys: "CRM and sales",
    note: "Reads leads, quotes and deals. Logs only the activity you approved.",
    level: "Read · write after you sign",
    tone: "you",
  },
  {
    sys: "Bank and card feeds",
    note: "Transactions only, to match against your books.",
    level: "Read only",
    tone: "agent",
  },
  {
    sys: "Email",
    note: "Sends the messages you approved. Doesn’t read your inbox.",
    level: "Send after you sign",
    tone: "you",
  },
  {
    sys: "Phone and text",
    note: "Calls and texts vendors and customers in your company’s name.",
    level: "Send after you sign",
    tone: "you",
  },
  {
    sys: "Your money",
    note: "Agents can’t pay, transfer or move funds.",
    level: "Never",
    tone: "risk",
  },
];
