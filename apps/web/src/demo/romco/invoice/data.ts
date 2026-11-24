// The Invoice CRM update's October close, as the demo's run R-1051 reads it: the two reports it
// collects (each with its owner, due date, follow-ups and escalation), the sales reconciled with
// Great Plains invoices, the exceptions, and the Zoho CRM deals matched, found and closed. Made up.

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

export const REPORTS: Report[] = [
  {
    key: "sales",
    name: "Unit sales report",
    from: "Sales operations",
    describe:
      "Every machine sold or delivered in the month, by branch, with its stock and serial number.",
    owner: "Tom Guerra",
    ownerRole: "Sales operations analyst",
    email: "tguerra@romco.example",
    file: "ROMCO_UnitSales_2026-10.xlsx",
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
    rows: 104,
    due: "Tue Nov 4",
    dueRule: "2 business days after month end",
    followUp: "1 business day after it's due, then daily; at most 2",
  },
  {
    key: "register",
    name: "Invoice register",
    from: "Great Plains (Microsoft Dynamics GP)",
    describe: "October's equipment invoices exported from Great Plains, with invoice numbers.",
    owner: "Priya Shah",
    ownerRole: "Accounting manager",
    email: "pshah@romco.example",
    file: "GP_InvoiceRegister_2026-10.xlsx",
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
    rows: 106,
    due: "Wed Nov 5",
    dueRule: "3 business days after month end",
    followUp: "1 business day after it's due, then daily; at most 2",
  },
];

export const ESCALATION = {
  to: "Grace Lin",
  role: "Controller",
  after: "2 business days late",
  choices: ["Keep asking", "Go on without it", "Stop the run"],
  ifNoAnswer: "the run stops and Renee Park is told",
};

/** What happened to each report, by the run's stage (0: register late, 1+: both in). */
export function reportEvents(
  key: Report["key"],
  stage: number,
): { when: string; what: string; tone?: "late" | "done" }[] {
  if (key === "sales") {
    return [
      { when: "Mon Nov 3, 8:00 AM", what: "Link sent to Tom Guerra" },
      {
        when: "Tue Nov 4, 10:41 AM",
        what: "Received: 104 rows, all dated in October. Checks passed.",
        tone: "done",
      },
    ];
  }
  const base = [
    { when: "Mon Nov 3, 8:00 AM", what: "Link sent to Priya Shah" },
    { when: "Wed Nov 5, 5:00 PM", what: "Due. Not in yet.", tone: "late" as const },
    { when: "Thu Nov 6, 8:00 AM", what: "Follow-up 1 of 2 sent with a new link" },
  ];
  if (stage === 0) {
    return [
      ...base,
      { when: "Fri Nov 7, 8:00 AM", what: "Next: follow-up 2 of 2" },
      {
        when: "Mon Nov 10, 8:00 AM",
        what: "Then: Grace Lin, Controller, decides (2 business days late)",
      },
    ];
  }
  return [
    ...base,
    {
      when: "Thu Nov 6, 11:20 AM",
      what: "Received: 106 invoices, all dated in October. Checks passed.",
      tone: "done",
    },
  ];
}

export const RECON = {
  sales: 104,
  invoices: 106,
  matched: 97,
  bySerial: 88,
  byCustomerAmount: 9,
  exceptions: 13,
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
    invoiceDate: "Oct 3",
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
    invoiceDate: "Oct 3",
    basis: "Serial number",
  },
  {
    stock: "H-30455",
    serial: "WL35-60231",
    customer: "Lake Creek Utilities Inc",
    branch: "Houston",
    machine: "Wheel loader",
    amount: "$248,500",
    invoice: "INV-245840",
    invoiceDate: "Oct 6",
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
    invoiceDate: "Oct 9",
    basis: "Serial number",
  },
  {
    stock: "D-22045",
    serial: "TR-55102",
    customer: "Trinity Paving Co",
    branch: "Dallas",
    machine: "Tandem roller",
    amount: "$176,400",
    invoice: "INV-245871",
    invoiceDate: "Oct 10",
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
    invoiceDate: "Oct 14",
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
    invoiceDate: "Oct 15",
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
    invoiceDate: "Oct 17",
    basis: "Serial number",
  },
  {
    stock: "S-40990",
    serial: "AT40-30872",
    customer: "Bell County Earthworks",
    branch: "Waco",
    machine: "Articulated truck",
    amount: "$498,000",
    invoice: "INV-245944",
    invoiceDate: "Oct 21",
    basis: "Serial number",
  },
  {
    stock: "B-11230",
    serial: "FM-20448",
    customer: "Nacogdoches Land Clearing",
    branch: "Tyler",
    machine: "Forestry mulcher",
    amount: "$289,000",
    invoice: "INV-245958",
    invoiceDate: "Oct 23",
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
    count: 3,
  },
  {
    key: "noInvoice",
    name: "Sold, not invoiced",
    what: "On the unit sales report, with no invoice in Great Plains.",
    count: 4,
  },
  {
    key: "noSale",
    name: "Invoiced, not on the sales report",
    what: "An equipment invoice in Great Plains with no sale on the report.",
    count: 6,
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
    ref: "D-22045 · INV-245871",
    customer: "Trinity Paving Co",
    detail: "Tandem roller",
    sale: "$176,400",
    invoice: "$171,400",
  },
  {
    group: "amount",
    ref: "H-30455 · INV-245840",
    customer: "Lake Creek Utilities Inc",
    detail: "Wheel loader: freight on the invoice",
    sale: "$248,500",
    invoice: "$251,150",
  },
  {
    group: "amount",
    ref: "S-41002 · INV-245963",
    customer: "Bexar Site Development",
    detail: "Excavator: attachments",
    sale: "$389,000",
    invoice: "$402,600",
  },
  {
    group: "noInvoice",
    ref: "B-11241",
    customer: "Bay Area Marine Construction",
    detail: "Crawler crane, delivered Oct 30",
    sale: "$1,240,000",
    invoice: "—",
  },
  {
    group: "noInvoice",
    ref: "D-22088",
    customer: "Denton Dirtworks",
    detail: "Two compact excavators",
    sale: "$214,000",
    invoice: "—",
  },
  {
    group: "noInvoice",
    ref: "H-30502",
    customer: "Kingsland Paving LLC",
    detail: "Asphalt paver",
    sale: "$389,000",
    invoice: "—",
  },
  {
    group: "noInvoice",
    ref: "A-51133",
    customer: "Leander Landscape Supply",
    detail: "Skid steer",
    sale: "$72,500",
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
  {
    group: "noSale",
    ref: "INV-245949",
    customer: "Katy Site Services",
    detail: "Long-reach excavator",
    sale: "—",
    invoice: "$355,000",
  },
  {
    group: "noSale",
    ref: "INV-245952",
    customer: "Waxahachie Dirt Co",
    detail: "Motor grader",
    sale: "—",
    invoice: "$398,000",
  },
  {
    group: "noSale",
    ref: "INV-245966",
    customer: "Conroe Concrete Pumping",
    detail: "Two skid steers",
    sale: "—",
    invoice: "$118,000",
  },
  {
    group: "noSale",
    ref: "INV-245971",
    customer: "Lufkin Timber Co",
    detail: "Ride-on trencher",
    sale: "—",
    invoice: "$96,400",
  },
];

export const ZOHO = {
  sales: 97,
  matched: 89,
  byRules: 82,
  byAi: 7,
  notFound: 8,
  found: 6,
  noDeal: 2,
  updated: 95,
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
    customer: "Lake Creek Utilities Inc",
    machine: "Wheel loader",
    invoice: "INV-245840",
    deal: "D-2307",
    dealName: "Lake Creek – wheel loader",
    stage: "Negotiation",
    owner: "Marcus Bell",
    basis: "Account name and address; one open deal for the model",
    sure: 98,
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
    customer: "Trinity Paving Co",
    machine: "Tandem roller",
    invoice: "INV-245871",
    deal: "D-2288",
    dealName: "Trinity – tandem roller",
    stage: "Negotiation",
    owner: "Tyler Brooks",
    basis: "Account name and address; one open deal for the model",
    sure: 97,
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
  {
    id: "n2",
    customer: "Nacogdoches Land Clearing",
    city: "Nacogdoches",
    machine: "Forestry mulcher",
    invoice: "INV-245958",
    amount: "$289,000",
    why: "No account in Zoho with this name or address",
    candidates: [],
  },
  {
    id: "n3",
    customer: "Cedar Creek Aggregates",
    city: "Kerrville",
    machine: "Wheel loader",
    invoice: "INV-245913",
    amount: "$265,000",
    why: "The account has no open deal; one closed lost in August",
    candidates: [
      {
        deal: "D-2240",
        name: "Cedar Creek – loader (Closed Lost)",
        stage: "Closed Lost",
        owner: "Hannah Kim",
      },
    ],
  },
  {
    id: "n4",
    customer: "Port Arthur Marine Services",
    city: "Port Arthur",
    machine: "Material handler",
    invoice: "INV-245918",
    amount: "$455,000",
    why: 'Account found by address; the name in Zoho differs ("PAMS Inc")',
    candidates: [
      {
        deal: "D-2299",
        name: "PAMS – material handler",
        stage: "Negotiation",
        owner: "Kelsey Tran",
      },
    ],
  },
  {
    id: "n5",
    customer: "Hays County Road Dept. contractor (Stonebridge LLC)",
    city: "San Marcos",
    machine: "Motor grader",
    invoice: "INV-245926",
    amount: "$398,000",
    why: "Two accounts with similar names",
    candidates: [
      { deal: "D-2320", name: "Stonebridge – grader", stage: "Proposal", owner: "Hannah Kim" },
      {
        deal: "D-2228",
        name: "Stonebridge Paving – grader",
        stage: "Negotiation",
        owner: "Luis Ortega",
      },
    ],
  },
  {
    id: "n6",
    customer: "Sugar Land Utility Partners",
    city: "Sugar Land",
    machine: "Backhoe loader (3)",
    invoice: "INV-245939",
    amount: "$486,000",
    why: "The deal is for 2 backhoes; the invoice is for 3",
    candidates: [
      { deal: "D-2309", name: "SLUP – two backhoes", stage: "Negotiation", owner: "Kelsey Tran" },
    ],
  },
  {
    id: "n7",
    customer: "Tyler Pipe & Bore",
    city: "Tyler",
    machine: "Directional drill",
    invoice: "INV-245947",
    amount: "$540,000",
    why: "No account in Zoho with this name or address",
    candidates: [],
  },
  {
    id: "n8",
    customer: "Midland Haul Road Services",
    city: "Midland",
    machine: "Articulated truck",
    invoice: "INV-245955",
    amount: "$472,000",
    why: "The open deal is under the parent company's account",
    candidates: [
      {
        deal: "D-2312",
        name: "Basin Holdings – AT for Midland",
        stage: "Negotiation",
        owner: "Luis Ortega",
      },
    ],
  },
];

/** Tom's answers, by sale: the deal he picked, or "none". */
export const EXAMPLE_PICKS: Record<string, { pick: string; note: string }> = {
  n1: { pick: "D-2311", note: "D-2315 is next spring's order." },
  n2: { pick: "none", note: "New customer this month. Needs an account and a deal." },
  n3: { pick: "D-2240", note: "They came back in October; reopen the lost deal." },
  n4: { pick: "D-2299", note: "PAMS Inc is the same company." },
  n5: { pick: "D-2320", note: "Stonebridge LLC, not Stonebridge Paving." },
  n6: { pick: "D-2309", note: "They added a third backhoe at signing." },
  n7: { pick: "none", note: "Walk-in sale at the Tyler branch. Needs an account and a deal." },
  n8: { pick: "D-2312", note: "Midland Haul Road is a Basin Holdings company." },
};
