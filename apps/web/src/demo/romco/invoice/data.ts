// The Invoice CRM update's day, as the demo's run R-1051 reads it: the two daily reports it
// collects (each emailed in by its owner every morning, with a due time, follow-ups and an
// escalation), the day before's sales reconciled with Great Plains invoices, the exceptions, and
// the Zoho CRM deals matched, found and closed. Made up.

export interface Report {
  key: "sales" | "register";
  name: string;
  from: string;
  describe: string;
  owner: string;
  ownerRole: string;
  email: string;
  file: string;
  format: string;
  columns: string[];
  rows: number;
  due: string;
  dueRule: string;
  followUp: string;
}

/** Where both reports are emailed every morning. */
export const INBOX = "invoices@romco.in.mezonas.com";
export const DAY = "Thursday, November 6";
export const COVERS = "Wednesday, November 5";

export const REPORTS: Report[] = [
  {
    key: "sales",
    name: "Unit sales report",
    from: "Sales operations, emailed every morning",
    describe:
      "Every machine sold or delivered the business day before, by branch, with its stock and serial number.",
    owner: "Tom Guerra",
    ownerRole: "Sales operations analyst",
    email: "tguerra@romco.example",
    file: "ROMCO_UnitSales_2026-11-05.xlsx",
    format: "Spreadsheet (.xlsx or .csv)",
    columns: [
      "Stock #",
      "Serial #",
      "Customer",
      "Address",
      "Branch",
      "Sale date",
      "Amount",
      "Salesperson",
    ],
    rows: 9,
    due: "9:00 AM",
    dueRule: "Every business day by 9:00 AM",
    followUp: "At 10:00 AM if it isn't in, then at noon; at most 2",
  },
  {
    key: "register",
    name: "Invoice register",
    from: "Great Plains (Microsoft Dynamics GP), emailed every morning",
    describe:
      "The business day before's equipment invoices exported from Great Plains, with invoice numbers.",
    owner: "Priya Shah",
    ownerRole: "Accounting manager",
    email: "pshah@romco.example",
    file: "GP_InvoiceRegister_2026-11-05.xlsx",
    format: "Spreadsheet (.xlsx or .csv)",
    columns: [
      "Invoice #",
      "Invoice date",
      "Customer",
      "Address",
      "Serial #",
      "Amount",
      "Sales order #",
    ],
    rows: 10,
    due: "9:00 AM",
    dueRule: "Every business day by 9:00 AM",
    followUp: "At 10:00 AM if it isn't in, then at noon; at most 2",
  },
];

export const ESCALATION = {
  to: "Grace Lin",
  role: "Controller",
  after: "1:00 PM, when the follow-ups have run out",
  choices: ["Keep asking", "Go on without it", "Stop today's run"],
  ifNoAnswer: "today's run stops, Renee Park is told, and tomorrow's run picks up both days",
};

/** What happened to each report today, by the run's stage (0: register late, 1+: both in). */
export function reportEvents(
  key: Report["key"],
  stage: number,
): { when: string; what: string; tone?: "late" | "done" }[] {
  if (key === "sales") {
    return [
      { when: "6:32 AM", what: `Emailed in by Tom Guerra's scheduled export to ${INBOX}` },
      { when: "6:32 AM", what: "Checked: 9 rows, all dated Nov 5. Checks passed.", tone: "done" },
    ];
  }
  const base = [
    { when: "9:00 AM", what: "Due. Not in yet.", tone: "late" as const },
    { when: "10:00 AM", what: "Follow-up 1 of 2 emailed to Priya Shah" },
  ];
  if (stage === 0) {
    return [
      ...base,
      { when: "12:00 PM", what: "Next: follow-up 2 of 2" },
      { when: "1:00 PM", what: "Then: Grace Lin, Controller, decides" },
    ];
  }
  return [
    ...base,
    {
      when: "10:47 AM",
      what: "Emailed in by Priya Shah. Checked: 10 invoices, all dated Nov 5. Checks passed.",
      tone: "done",
    },
  ];
}

export const RECON = {
  sales: 9,
  invoices: 10,
  matched: 7,
  bySerial: 6,
  byCustomerAmount: 1,
  exceptions: 4,
};

export interface Reconciled {
  stock: string;
  serial: string;
  customer: string;
  branch: string;
  machine: string;
  amount: string;
  invoice: string;
  invoiceDate: string;
  basis: string;
}

export const RECONCILED: Reconciled[] = [
  {
    stock: "H-30418",
    serial: "EX30-11842",
    customer: "Montgomery County Site Works LLC",
    branch: "Houston",
    machine: "30-ton excavator",
    amount: "$306,000",
    invoice: "INV-245811",
    invoiceDate: "Nov 5",
    basis: "Serial number",
  },
  {
    stock: "H-30419",
    serial: "EX30-11857",
    customer: "Montgomery County Site Works LLC",
    branch: "Houston",
    machine: "30-ton excavator",
    amount: "$306,000",
    invoice: "INV-245812",
    invoiceDate: "Nov 5",
    basis: "Serial number",
  },
  {
    stock: "B-11207",
    serial: "DX-77310",
    customer: "Golden Triangle Demolition",
    branch: "Beaumont",
    machine: "High-reach excavator",
    amount: "$735,000",
    invoice: "INV-245866",
    invoiceDate: "Nov 5",
    basis: "Serial number",
  },
  {
    stock: "D-22061",
    serial: "CD-88201",
    customer: "Red River Grading",
    branch: "Dallas",
    machine: "Crawler dozer",
    amount: "$341,000",
    invoice: "INV-245893",
    invoiceDate: "Nov 5",
    basis: "Serial number",
  },
  {
    stock: "S-40977",
    serial: "—",
    customer: "Bexar Site Development",
    branch: "San Antonio",
    machine: "Breaker attachment",
    amount: "$18,750",
    invoice: "INV-245905",
    invoiceDate: "Nov 5",
    basis: "Customer and amount",
  },
  {
    stock: "A-51120",
    serial: "MG14-01017",
    customer: "Capital Area Grading",
    branch: "Austin",
    machine: "Motor grader",
    amount: "$412,000",
    invoice: "INV-245921",
    invoiceDate: "Nov 5",
    basis: "Serial number",
  },
  {
    stock: "S-40990",
    serial: "AT40-30872",
    customer: "Bell County Earthworks",
    branch: "Temple",
    machine: "Articulated truck",
    amount: "$498,000",
    invoice: "INV-245944",
    invoiceDate: "Nov 5",
    basis: "Serial number",
  },
];

export type ExceptionGroup = "amount" | "noInvoice" | "noSale";

export const EXCEPTION_GROUPS: {
  key: ExceptionGroup;
  name: string;
  what: string;
  count: number;
}[] = [
  {
    key: "amount",
    name: "Amounts differ",
    what: "A sale and its invoice match on serial number, but not on amount.",
    count: 1,
  },
  {
    key: "noInvoice",
    name: "Sold, not invoiced",
    what: "On the unit sales report, with no invoice in Great Plains.",
    count: 1,
  },
  {
    key: "noSale",
    name: "Invoiced, not on the sales report",
    what: "An equipment invoice in Great Plains with no sale on the report.",
    count: 2,
  },
];

export const EXCEPTIONS: {
  group: ExceptionGroup;
  ref: string;
  customer: string;
  detail: string;
  sale: string;
  invoice: string;
}[] = [
  {
    group: "amount",
    ref: "H-30455 · INV-245840",
    customer: "Lake Creek Utilities Inc",
    detail: "Wheel loader: freight on the invoice",
    sale: "$248,500",
    invoice: "$251,150",
  },
  {
    group: "noInvoice",
    ref: "B-11241",
    customer: "Bay Area Marine Construction",
    detail: "Crawler crane, delivered Nov 5",
    sale: "$1,240,000",
    invoice: "—",
  },
  {
    group: "noSale",
    ref: "INV-245930",
    customer: "Bastrop Rental Partners",
    detail: "Used skid steer from the rental fleet",
    sale: "—",
    invoice: "$38,500",
  },
  {
    group: "noSale",
    ref: "INV-245937",
    customer: "Victoria Pipe Supply",
    detail: "Pipelayer",
    sale: "—",
    invoice: "$610,000",
  },
];

export const ZOHO = {
  sales: 7,
  matched: 6,
  byRules: 5,
  byAi: 1,
  notFound: 1,
  found: 1,
  noDeal: 0,
  updated: 6,
};

export interface DealMatch {
  customer: string;
  machine: string;
  invoice: string;
  deal: string;
  dealName: string;
  stage: string;
  owner: string;
  basis: string;
  sure: number;
}

export const MATCHED: DealMatch[] = [
  {
    customer: "Montgomery County Site Works LLC",
    machine: "30-ton excavator (2)",
    invoice: "INV-245811, INV-245812",
    deal: "D-2291",
    dealName: "MCSW – two 30-ton excavators",
    stage: "Negotiation",
    owner: "Marcus Bell",
    basis: "Account name and address; one open deal for the model",
    sure: 99,
  },
  {
    customer: "Golden Triangle Demolition",
    machine: "High-reach excavator",
    invoice: "INV-245866",
    deal: "D-2302",
    dealName: "GTD – high-reach excavator",
    stage: "Proposal",
    owner: "Kelsey Tran",
    basis: "Account name and address; one open deal for the model",
    sure: 99,
  },
  {
    customer: "Red River Grading",
    machine: "Crawler dozer",
    invoice: "INV-245893",
    deal: "D-2296",
    dealName: "Red River – dozer",
    stage: "Negotiation",
    owner: "Andre Wallace",
    basis: "Account name and address; one open deal for the model",
    sure: 98,
  },
  {
    customer: "Bexar Site Development",
    machine: "Breaker attachment",
    invoice: "INV-245905",
    deal: "D-2316",
    dealName: "BSD – breaker",
    stage: "Negotiation",
    owner: "Luis Ortega",
    basis: "Account name and address; one open deal for the attachment",
    sure: 96,
  },
  {
    customer: "Capital Area Grading",
    machine: "Motor grader",
    invoice: "INV-245921",
    deal: "D-2318",
    dealName: "CAG – 14 ft grader",
    stage: "Proposal",
    owner: "Hannah Kim",
    basis: '"Capital Area Grading LLC" in Zoho; AI matched the name, address the same',
    sure: 94,
  },
];

export interface NotFound {
  id: string;
  customer: string;
  city: string;
  machine: string;
  invoice: string;
  amount: string;
  why: string;
  candidates: { deal: string; name: string; stage: string; owner: string }[];
}

export const NOT_FOUND: NotFound[] = [
  {
    id: "n1",
    customer: "Bell County Earthworks",
    city: "Temple",
    machine: "Articulated truck",
    invoice: "INV-245944",
    amount: "$498,000",
    why: "Two open deals for this account could be it",
    candidates: [
      { deal: "D-2311", name: "BCE – articulated truck", stage: "Proposal", owner: "Hannah Kim" },
      {
        deal: "D-2315",
        name: "BCE – two ATs, spring",
        stage: "Qualification",
        owner: "Hannah Kim",
      },
    ],
  },
];

/** Tom's answers, by sale: the deal he picked, or "none". */
export const EXAMPLE_PICKS: Record<string, { pick: string; note: string }> = {
  n1: { pick: "D-2311", note: "D-2315 is next spring's order." },
};

/** The last ten business days, for the Report tab. */
export const DAYS: {
  day: string;
  onTime: string;
  sales: number;
  reconciled: number;
  exceptions: number;
  closed: number;
}[] = [
  { day: "Thu Nov 6", onTime: "1 of 2", sales: 9, reconciled: 7, exceptions: 4, closed: 6 },
  { day: "Wed Nov 5", onTime: "2 of 2", sales: 6, reconciled: 6, exceptions: 1, closed: 6 },
  { day: "Tue Nov 4", onTime: "2 of 2", sales: 11, reconciled: 10, exceptions: 2, closed: 9 },
  { day: "Mon Nov 3", onTime: "2 of 2", sales: 14, reconciled: 12, exceptions: 3, closed: 12 },
  { day: "Fri Oct 31", onTime: "2 of 2", sales: 18, reconciled: 17, exceptions: 1, closed: 17 },
  { day: "Thu Oct 30", onTime: "1 of 2", sales: 7, reconciled: 7, exceptions: 0, closed: 6 },
  { day: "Wed Oct 29", onTime: "2 of 2", sales: 5, reconciled: 4, exceptions: 1, closed: 4 },
  { day: "Tue Oct 28", onTime: "2 of 2", sales: 8, reconciled: 8, exceptions: 0, closed: 8 },
  { day: "Mon Oct 27", onTime: "2 of 2", sales: 10, reconciled: 9, exceptions: 2, closed: 9 },
  { day: "Fri Oct 24", onTime: "2 of 2", sales: 12, reconciled: 11, exceptions: 1, closed: 11 },
];
