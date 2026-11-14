// @ts-check
// The lists on "Hire, don't build" (/hire): the use cases and the four steps of how we work.
// Headlines, the three paths and the comparison table are in pages/hire.html.

/** @typedef {import("./shared.mjs").Step} Step */

/**
 * Results a client can pick. Each flow has six steps, drawn on four lanes.
 * @type {{ id: string, result: string, who: string, uses: string, flow: Step[], change: string }[]}
 */
export const USE_CASES = [
  {
    id: "sales",
    result: "Close more of your quotes",
    who: "Rae, Sales",
    uses: "your CRM, email and text",
    flow: [
      [
        "target",
        "system",
        "Pull",
        "New leads and open quotes pulled from your CRM",
        "Every morning.",
      ],
      [
        "search",
        "agent",
        "Analyze",
        "Rae finds who is waiting on you",
        "Quotes sent, no reply in five days.",
      ],
      ["chat", "team", "Ask", "Rae checks with your estimator", "“Can we still hold this price?”"],
      [
        "mail",
        "agent",
        "Draft",
        "Rae drafts follow-ups in your voice",
        "Email and text, by deal stage.",
      ],
      ["pen", "you", "Sign", "Ana checks, you sign", "They go out from your sales team."],
      ["target", "system", "Write", "Activity logged in your CRM", "With the next follow-up set."],
    ],
    change: "Every lead and quote followed up, not just the ones someone remembers.",
  },
  {
    id: "quote",
    result: "Pay what you were quoted",
    who: "Pia, Purchasing",
    uses: "accounting and email",
    flow: [
      ["mail", "system", "Trigger", "A bill arrives by email", "Lone Star Panel, INV-20431."],
      [
        "db",
        "agent",
        "Pull",
        "Pia pulls the quote and PO from accounting",
        "Q-1182: 40 sheets at $97.50.",
      ],
      [
        "search",
        "agent",
        "Analyze",
        "Pia compares line by line",
        "Billed $105.25 a sheet: $310 over.",
      ],
      [
        "check",
        "person",
        "Review",
        "Ana checks the difference",
        "Against the quote and the delivery ticket.",
      ],
      ["pen", "you", "Sign", "You sign the credit request", "One tap on Your Desk."],
      [
        "db",
        "system",
        "Write",
        "Bill held in your accounting system",
        "Credit request sent and logged.",
      ],
    ],
    change: "Every bill checked against its quote before it’s paid.",
  },
  {
    id: "buy",
    result: "Buy at the best price",
    who: "Pia, Purchasing",
    uses: "accounting, phone, email, text and web",
    flow: [
      [
        "chat",
        "team",
        "Ask",
        "Your crew texts what they need",
        "40 sheets of birch, 12 boxes of hinges, by Thursday.",
      ],
      [
        "db",
        "agent",
        "Pull",
        "Pia pulls items and past prices",
        "From accounting: last paid, usual vendors.",
      ],
      [
        "chat",
        "agent",
        "Reach out",
        "Pia calls, emails and texts vendors",
        "Price, stock and delivery date.",
      ],
      ["search", "agent", "Analyze", "Pia compares the quotes", "Total, timing, what’s in stock."],
      ["pen", "you", "Sign", "Ana checks, you sign the order", "With every quote one tap away."],
      [
        "db",
        "system",
        "Write",
        "Purchase order written to accounting",
        "Sent to the vendor from your email.",
      ],
    ],
    change: "Quotes compared on every order, not just the big ones.",
  },
  {
    id: "paid",
    result: "Get paid faster",
    who: "Cal, Collections",
    uses: "accounting, CRM, email and text",
    flow: [
      ["db", "system", "Pull", "Open invoices pulled from accounting", "Every morning."],
      [
        "search",
        "agent",
        "Analyze",
        "Cal sorts who is late and by how much",
        "Payment history, promises, amounts.",
      ],
      ["chat", "team", "Ask", "Cal checks with your team", "“Was the Hughes job fully delivered?”"],
      [
        "mail",
        "agent",
        "Draft",
        "Cal drafts reminders in your voice",
        "Email and text, firm or friendly.",
      ],
      ["pen", "you", "Sign", "Ana checks, you sign", "They go out from your company."],
      [
        "db",
        "system",
        "Write",
        "Promises and payments logged",
        "In accounting and your CRM, with the next follow-up set.",
      ],
    ],
    change: "Follow-up from day one, not when cash gets tight.",
  },
  {
    id: "close",
    result: "Close the month on time",
    who: "Bea, Bookkeeping",
    uses: "bank feeds and accounting",
    flow: [
      ["db", "system", "Pull", "Bank and card transactions pulled", "Every day, read only."],
      [
        "search",
        "agent",
        "Match",
        "Bea matches them to your books",
        "Bills, payments and deposits.",
      ],
      [
        "chat",
        "team",
        "Ask",
        "Bea asks about what she can’t place",
        "“What was the $412 at the hardware store for?”",
      ],
      [
        "check",
        "person",
        "Review",
        "Ana reviews the exceptions",
        "Anything unusual gets a second look.",
      ],
      ["pen", "you", "Sign", "You sign the entries", "Before and after, side by side."],
      [
        "db",
        "system",
        "Write",
        "Entries written to your accounting system",
        "The month closes on schedule.",
      ],
    ],
    change: "Books matched every day, not cleaned up at tax time.",
  },
  {
    id: "jobs",
    result: "Know which jobs make money",
    who: "Finn, Planning, with Bea",
    uses: "accounting, job budgets and payroll",
    flow: [
      [
        "db",
        "system",
        "Pull",
        "Bills, time and invoices pulled by job",
        "From accounting and payroll.",
      ],
      [
        "chat",
        "team",
        "Ask",
        "Your PM confirms the job is closed",
        "And flags anything not yet billed.",
      ],
      [
        "search",
        "agent",
        "Analyze",
        "Finn costs it against the bid",
        "Materials, labor and change orders.",
      ],
      ["check", "person", "Review", "Ana checks the numbers", "Before you ever see them."],
      ["chart", "you", "Read", "You see it in The Weekly Table", "Which jobs made money, and why."],
      ["doc", "agent", "Learn", "The next bid starts from real costs", "Not last year’s guess."],
    ],
    change: "Every job costed while you can still change the next bid.",
  },
  {
    id: "cash",
    result: "See cash 13 weeks out",
    who: "Finn, Planning",
    uses: "accounting and your CRM pipeline",
    flow: [
      [
        "db",
        "system",
        "Pull",
        "Books, open invoices and the sales pipeline pulled",
        "Monday, before you’re up.",
      ],
      [
        "search",
        "agent",
        "Analyze",
        "Finn updates the 13-week forecast",
        "Who pays when, and what’s due.",
      ],
      [
        "chat",
        "team",
        "Ask",
        "Finn asks about big buys coming",
        "“Is the new saw still on for March?”",
      ],
      ["check", "person", "Review", "Ana notes what changed and why", "In plain words."],
      [
        "chart",
        "you",
        "Read",
        "You get it in The Weekly Table",
        "With the decisions it points to.",
      ],
      ["pen", "you", "Decide", "You decide with numbers", "Hire, buy, or wait."],
    ],
    change: "A forecast every Monday, with what changed and why.",
  },
];

/** The use case shown first. */
export const USE_CASE_FIRST = "quote";

/** The four lanes, top to bottom, and the actors drawn on each. */
export const LANES = [
  {
    label: "Your systems",
    sub: "Accounting, CRM, bank, email",
    actors: ["system"],
    tone: "system",
  },
  { label: "Agents", sub: "Run by Mezonas", actors: ["agent"], tone: "agent" },
  { label: "People", sub: "Your team and your lead", actors: ["team", "person"], tone: "person" },
  { label: "You", sub: "On Your Desk", actors: ["you"], tone: "you" },
];

/**
 * How we work with you: four steps, each a workflow that lights up node by node.
 * @type {{ name: string, n: string, time: string, title: string, desc: string, flow: Step[] }[]}
 */
export const PROCESS = [
  {
    name: "Find",
    n: "01",
    time: "Week 1",
    title: "Where the gaps are",
    desc: "Before we build anything, we read your books and talk to your team. You get a written diagnostic: where money leaks, what runs late, and which seats on your team are empty.",
    flow: [
      [
        "db",
        "system",
        "Pull",
        "Pull 12 months from accounting and your CRM",
        "Bills, invoices, vendors, payments, leads and deals. Read only.",
      ],
      [
        "db",
        "system",
        "Pull",
        "Pull bank and card transactions",
        "To see what the books missed. Read only.",
      ],
      [
        "search",
        "agent",
        "Analyze",
        "Agents look for patterns",
        "Price drift by vendor, duplicate charges, slow payers, unmatched entries.",
      ],
      [
        "people",
        "team",
        "Ask",
        "We talk to your team",
        "How orders get placed, who approves what, where the work piles up.",
      ],
      [
        "chart",
        "person",
        "Report",
        "Your lead writes the diagnostic",
        "The gaps in dollars and hours, ranked by what to fix first.",
      ],
    ],
  },
  {
    name: "Design",
    n: "02",
    time: "Week 2",
    title: "Results, rules and sign-offs",
    desc: "Together we pick the results worth chasing first, then write each agent’s job description: what it does, what it can read, what it can change, and what always waits for your signature.",
    flow: [
      [
        "target",
        "you",
        "Choose",
        "You pick the results",
        "“Pay what we were quoted.” “Get paid in 30 days.”",
      ],
      [
        "doc",
        "person",
        "Define",
        "We write each agent’s job description",
        "Duties, sources, and how it should sound in your name.",
      ],
      [
        "shield",
        "person",
        "Limit",
        "We set what each agent can touch",
        "Read here, write there, never move money.",
      ],
      [
        "pen",
        "you",
        "Approve",
        "You set what needs your signature",
        "For example: orders, vendor credits, new vendors, write-offs.",
      ],
    ],
  },
  {
    name: "Build",
    n: "03",
    time: "Weeks 3–4",
    title: "On what you already use",
    desc: "We connect to the systems you have and teach the agents your history: your vendors, items, prices and the way you write to customers. Then we run a month of your real work in practice mode before anything goes live.",
    flow: [
      [
        "link",
        "system",
        "Connect",
        "Connect accounting, CRM, bank feeds, email and phone",
        "The least access each job needs.",
      ],
      [
        "db",
        "agent",
        "Learn",
        "Agents learn from your history",
        "Your vendors, items, past prices and how you write.",
      ],
      [
        "loop",
        "agent",
        "Practice",
        "Run last month in practice mode",
        "Nothing is written. We compare against what actually happened.",
      ],
      [
        "check",
        "person",
        "Check",
        "Your lead reviews every result",
        "We tune the rules until the answers match.",
      ],
      [
        "pen",
        "you",
        "Go live",
        "You sign off to go live",
        "Agents start on real work the next morning.",
      ],
    ],
  },
  {
    name: "Run",
    n: "04",
    time: "Every day",
    title: "The daily loop",
    desc: "Agents pull what’s new, do the work, ask your team when something is missing, and prepare changes. After two checks you sign, and only then is anything written back to your systems. Each month we review results with you and adjust.",
    flow: [
      [
        "db",
        "system",
        "Pull",
        "Pull what’s new from accounting, CRM and email",
        "New bills, invoices, payments, leads and quotes.",
      ],
      [
        "search",
        "agent",
        "Analyze",
        "Pia, Cal and Bea do the work",
        "Match, compare, draft and forecast.",
      ],
      [
        "chat",
        "team",
        "Ask",
        "Text your team for what’s missing",
        "“Which job is this hinge order for?”",
      ],
      ["check", "agent", "Check", "Sloan checks the work", "A second agent, against the receipts."],
      ["check", "person", "Review", "Ana reviews", "A person, every time."],
      ["pen", "you", "Sign", "You sign on Your Desk", "Before and after, side by side."],
      [
        "db",
        "system",
        "Write",
        "Write back to accounting and CRM",
        "Only what you signed, logged on the Worksheet.",
      ],
    ],
  },
];
