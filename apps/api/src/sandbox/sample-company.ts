// The Sandbox's sample company (packages/core `sampleCompanyRoutes`): Ridgeline Builders, a small,
// invented contractor that builds kitchens and trim, with the records a workflow's steps read in
// the Sandbox client: its vendors (with their accounting ids, tax ids and email domains, an
// organization and a rep each), its own people (employees, and the operator if they ask), its
// customers and their projects, a chart of accounts with a few notes, master items and the
// vendors' SKUs for them with their last prices, and ten bills and purchases from the last 60 days.
//
// Every name is made up: domains are under example.com and numbers are 555-01xx. Every row has a
// fixed id (uuid v5 of the Sandbox's id and the record's key) and is inserted only when missing, so
// a second run adds nothing and never changes or duplicates a record the operator has edited. It
// runs in the operator's transaction, in the Sandbox only (the route checks), and writes nothing
// to any tool.
//
// Here and not in packages/db (where the demo seed is) because the master items and vendor items
// are the Materials pack's tables, which only apps/api may wire to the platform (invariant 2).

import {
  addDays,
  dec,
  normalizeSignupPhone,
  normalizeVendorName,
  qboTransactionExternalId,
  type Relationship,
  relationshipChannelsFor,
  type SampleCompanyCounts,
  type SampleCompanyExample,
  type SampleCompanyPerson,
  type SampleCompanyYou,
  toNumeric,
  uuidv5,
} from "@countersign/core";
import {
  connection,
  contact,
  contactChange,
  type LedgerClassification,
  type LedgerKind,
  ledgerAccount,
  ledgerAccountNote,
  organization,
  organizationChange,
  type Tx,
  tenant,
  transaction,
  transactionLine,
  vendor,
} from "@countersign/db";
import {
  canonicalName,
  catalogItem,
  keySignature,
  parseLine,
  vendorItem,
} from "@countersign/pack-materials";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { HttpError, type Services } from "../http";
import { switchOnPacks } from "../routes/packs";

/** The namespace of the sample company's ids (with the Sandbox's id in every name). */
const SAMPLE_NAMESPACE = "3a1ee939-a9bd-49a3-b7fc-5d2b1779678e";

export const SAMPLE_COMPANY = {
  name: "Ridgeline Builders",
  domain: "ridgeline.example.com",
  phone: "+15125550100",
} as const;

/** Where consent on the sample people's addresses came from, as the directory records it. */
const CONSENT_SOURCE = "Sample company";

// ── The records ──────────────────────────────────────────────────────────────────────────────────

interface VendorSpec {
  key: string;
  name: string;
  aliases: string[];
  qbo: string;
  domain: string;
  taxId: string | null;
  phone: string;
  rep: { name: string; title: string; email: string; phone: string };
}

const VENDORS: VendorSpec[] = [
  {
    key: "northfork",
    name: "Northfork Lumber Co.",
    aliases: ["Northfork Lumber Yard", "NFL Co"],
    qbo: "9101",
    domain: "northforklumber.example.com",
    taxId: "84-2913501",
    phone: "+15125550120",
    rep: { name: "Gail Brennan", title: "Inside sales", email: "gail", phone: "+15125550121" },
  },
  {
    key: "cascade",
    name: "Cascade Panel Supply",
    aliases: ["Cascade Panel"],
    qbo: "9102",
    domain: "cascadepanel.example.com",
    taxId: "91-4471022",
    phone: "+15125550130",
    rep: { name: "Owen Pike", title: "Account manager", email: "owen", phone: "+15125550131" },
  },
  {
    key: "summit",
    name: "Summit Cabinet Hardware",
    aliases: ["Summit Hardware"],
    qbo: "9103",
    domain: "summithardware.example.com",
    taxId: null,
    phone: "+15125550140",
    rep: { name: "Lena Ortiz", title: "Sales rep", email: "lena", phone: "+15125550141" },
  },
  {
    key: "bayline",
    name: "Bayline Building Supply",
    aliases: ["Bayline Supply", "Bayline BSI"],
    qbo: "9104",
    domain: "baylinesupply.example.com",
    taxId: "47-3308114",
    phone: "+15125550150",
    rep: { name: "Curtis Hale", title: "Contractor desk", email: "curtis", phone: "+15125550151" },
  },
  {
    key: "pinecrest",
    name: "Pinecrest Millwork",
    aliases: ["Pinecrest Mouldings"],
    qbo: "9105",
    domain: "pinecrestmillwork.example.com",
    taxId: null,
    phone: "+15125550160",
    rep: { name: "Ada Lindqvist", title: "Estimator", email: "ada", phone: "+15125550161" },
  },
  {
    key: "westgate",
    name: "Westgate Fuel & Fleet",
    aliases: ["Westgate Fuel"],
    qbo: "9106",
    domain: "westgatefuel.example.com",
    taxId: null,
    phone: "+15125550170",
    rep: { name: "Ray Dunn", title: "Fleet accounts", email: "ray", phone: "+15125550171" },
  },
  {
    key: "granite",
    name: "Granite Tool Rental",
    aliases: ["Granite Rentals"],
    qbo: "9107",
    domain: "granitetool.example.com",
    taxId: "26-5519087",
    phone: "+15125550180",
    rep: { name: "Mia Chen", title: "Rental counter", email: "mia", phone: "+15125550181" },
  },
  {
    key: "copperline",
    name: "Copperline Electric LLC",
    aliases: ["Copperline Electrical"],
    qbo: "9108",
    domain: "copperline-electric.example.com",
    taxId: "88-1024675",
    phone: "+15125550190",
    rep: { name: "Jesse Moreno", title: "Owner", email: "jesse", phone: "+15125550191" },
  },
];

interface PersonSpec {
  key: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  roles: string[];
}

const EMPLOYEES: PersonSpec[] = [
  {
    key: "dana",
    name: "Dana Whitfield",
    title: "Owner",
    email: `dana@${SAMPLE_COMPANY.domain}`,
    phone: "+15125550101",
    roles: ["owner", "approver", "cardholder"],
  },
  {
    key: "marco",
    name: "Marco Alvarez",
    title: "Project manager",
    email: `marco@${SAMPLE_COMPANY.domain}`,
    phone: "+15125550102",
    roles: ["purchaser", "cardholder"],
  },
  {
    key: "priya",
    name: "Priya Natarajan",
    title: "Office manager",
    email: `priya@${SAMPLE_COMPANY.domain}`,
    phone: "+15125550103",
    roles: ["bookkeeper"],
  },
  {
    key: "tom",
    name: "Tom Becker",
    title: "Lead carpenter",
    email: `tom@${SAMPLE_COMPANY.domain}`,
    phone: "+15125550104",
    roles: ["cardholder"],
  },
];

interface CustomerSpec {
  key: string;
  name: string;
  project: string;
  person: Omit<PersonSpec, "key" | "roles">;
}

const CUSTOMERS: CustomerSpec[] = [
  {
    key: "hollis",
    name: "Hollis Family",
    project: "Hollis kitchen remodel, 418 Birch Lane",
    person: {
      name: "Evan Hollis",
      title: "Homeowner",
      email: "evan.hollis@mail.example.com",
      phone: "+15125550201",
    },
  },
  {
    key: "maplecourt",
    name: "Maple Court Townhomes",
    project: "Maple Court, kitchens and trim in 12 townhomes",
    person: {
      name: "Rachel Kim",
      title: "Property manager",
      email: "rachel@maplecourt.example.com",
      phone: "+15125550202",
    },
  },
  {
    key: "lakeview",
    name: "Lakeview Dental",
    project: "Lakeview Dental, front office cabinets and reception desk",
    person: {
      name: "Sam Patel",
      title: "Office manager",
      email: "sam@lakeviewdental.example.com",
      phone: "+15125550203",
    },
  },
];

interface AccountSpec {
  id: string;
  number: string;
  name: string;
  kind: LedgerKind;
  classification: LedgerClassification;
  type: string;
  subType: string;
  note?: string;
}

/** The chart of accounts, as QuickBooks would hold it (its types and sub-types). */
const ACCOUNTS: AccountSpec[] = [
  {
    id: "9201",
    number: "1000",
    name: "Operating checking",
    kind: "bank",
    classification: "asset",
    type: "Bank",
    subType: "Checking",
  },
  {
    id: "9202",
    number: "1010",
    name: "Savings",
    kind: "bank",
    classification: "asset",
    type: "Bank",
    subType: "Savings",
  },
  {
    id: "9203",
    number: "1200",
    name: "Accounts receivable",
    kind: "receivable",
    classification: "asset",
    type: "Accounts Receivable",
    subType: "AccountsReceivable",
  },
  {
    id: "9204",
    number: "1500",
    name: "Tools and equipment",
    kind: "fixed_asset",
    classification: "asset",
    type: "Fixed Asset",
    subType: "MachineryAndEquipment",
  },
  {
    id: "9205",
    number: "2000",
    name: "Accounts payable",
    kind: "payable",
    classification: "liability",
    type: "Accounts Payable",
    subType: "AccountsPayable",
  },
  {
    id: "9206",
    number: "2100",
    name: "Company Visa",
    kind: "card",
    classification: "liability",
    type: "Credit Card",
    subType: "CreditCard",
    note: "Dana's, Marco's and Tom's company Visa. Each statement is reconciled by the 10th.",
  },
  {
    id: "9207",
    number: "2110",
    name: "Fuel card",
    kind: "card",
    classification: "liability",
    type: "Credit Card",
    subType: "CreditCard",
  },
  {
    id: "9208",
    number: "2200",
    name: "Sales tax payable",
    kind: "other_current_liability",
    classification: "liability",
    type: "Other Current Liability",
    subType: "SalesTaxPayable",
  },
  {
    id: "9209",
    number: "3000",
    name: "Owner's equity",
    kind: "equity",
    classification: "equity",
    type: "Equity",
    subType: "OwnersEquity",
  },
  {
    id: "9210",
    number: "4000",
    name: "Construction income",
    kind: "income",
    classification: "revenue",
    type: "Income",
    subType: "ServiceFeeIncome",
  },
  {
    id: "9211",
    number: "4100",
    name: "Change orders",
    kind: "income",
    classification: "revenue",
    type: "Income",
    subType: "ServiceFeeIncome",
  },
  {
    id: "9212",
    number: "5000",
    name: "Lumber and sheet goods",
    kind: "cost_of_goods",
    classification: "expense",
    type: "Cost of Goods Sold",
    subType: "SuppliesMaterialsCogs",
    note: "Plywood, MDF, melamine and hardwood bought for a job. Small tools and shop supplies go to Small tools.",
  },
  {
    id: "9213",
    number: "5010",
    name: "Cabinet hardware",
    kind: "cost_of_goods",
    classification: "expense",
    type: "Cost of Goods Sold",
    subType: "SuppliesMaterialsCogs",
  },
  {
    id: "9214",
    number: "5020",
    name: "Trim and mouldings",
    kind: "cost_of_goods",
    classification: "expense",
    type: "Cost of Goods Sold",
    subType: "SuppliesMaterialsCogs",
  },
  {
    id: "9215",
    number: "5100",
    name: "Subcontractors",
    kind: "cost_of_goods",
    classification: "expense",
    type: "Cost of Goods Sold",
    subType: "CostOfLaborCos",
    note: "Electricians and other trades we hire for one job. Name the project in the memo.",
  },
  {
    id: "9216",
    number: "5200",
    name: "Equipment rental",
    kind: "cost_of_goods",
    classification: "expense",
    type: "Cost of Goods Sold",
    subType: "EquipmentRentalCos",
  },
  {
    id: "9217",
    number: "6000",
    name: "Fuel",
    kind: "expense",
    classification: "expense",
    type: "Expense",
    subType: "Auto",
    note: "Fuel for the two trucks, paid on the fuel card.",
  },
  {
    id: "9218",
    number: "6100",
    name: "Meals",
    kind: "expense",
    classification: "expense",
    type: "Expense",
    subType: "EntertainmentMeals",
    note: "Crew meals on long days and lunches with clients. Keep the receipt and say who was there.",
  },
  {
    id: "9219",
    number: "6200",
    name: "Small tools",
    kind: "expense",
    classification: "expense",
    type: "Expense",
    subType: "SuppliesMaterials",
  },
  {
    id: "9220",
    number: "6300",
    name: "Office supplies",
    kind: "expense",
    classification: "expense",
    type: "Expense",
    subType: "OfficeGeneralAdministrativeExpenses",
  },
  {
    id: "9221",
    number: "6400",
    name: "Insurance",
    kind: "expense",
    classification: "expense",
    type: "Expense",
    subType: "Insurance",
  },
  {
    id: "9222",
    number: "6500",
    name: "Bank fees",
    kind: "expense",
    classification: "expense",
    type: "Expense",
    subType: "BankCharges",
  },
];

/** Master items, as the catalog's parsers read them. */
const ITEMS: Record<string, string> = {
  bb34: '3/4" BB/BB BALTIC BIRCH 5X5',
  bb12: '1/2" BB/BB BALTIC BIRCH 5X5',
  mdf34: '3/4" MDF 4X8',
  maple34: '3/4" MAPLE PLY 4X8 PREFINISHED',
  mel34: '3/4" WHITE MELAMINE 4X8',
  oak44: "4/4 RED OAK FAS ROUGH",
  maple84: "8/4 HARD MAPLE FAS ROUGH",
  poplar44: "4/4 POPLAR FAS S2S",
  casing: "WM366 PRIMED MDF CASING 16FT",
  base: "WM623 PRIMED MDF BASE 16FT",
  edge: "15/16 X .5MM WHITE PVC EDGEBANDING 600FT",
  hinge: "BLUM 71B3550 CLIP TOP HINGE",
  tandem: "BLUM TANDEM 563H5330B 21IN SLIDE",
  accuride: "ACCURIDE 3832 22IN FULL EXT SLIDE",
  glue: "TITEBOND III WOOD GLUE 1 GAL",
};

interface VendorItemSpec {
  vendor: string;
  item: keyof typeof ITEMS;
  sku: string;
  name: string;
  /** The unit the vendor prices in, and how many of the item's standard unit it holds. */
  uom: string;
  perUom: string;
  /** Per vendor unit, as last invoiced. */
  price: string;
  pack?: string;
}

const VENDOR_ITEMS: VendorItemSpec[] = [
  // Northfork Lumber: hardwood and Baltic birch.
  {
    vendor: "northfork",
    item: "bb34",
    sku: "NF-BB34",
    name: "Baltic birch 3/4 BB/BB 5x5",
    uom: "sheet",
    perUom: "1",
    price: "64.80",
  },
  {
    vendor: "northfork",
    item: "bb12",
    sku: "NF-BB12",
    name: "Baltic birch 1/2 BB/BB 5x5",
    uom: "sheet",
    perUom: "1",
    price: "49.25",
  },
  {
    vendor: "northfork",
    item: "oak44",
    sku: "NF-RO44",
    name: "Red oak 4/4 FAS rough",
    uom: "bf",
    perUom: "1",
    price: "4.95",
  },
  {
    vendor: "northfork",
    item: "maple84",
    sku: "NF-HM84",
    name: "Hard maple 8/4 FAS rough",
    uom: "bf",
    perUom: "1",
    price: "7.55",
  },
  {
    vendor: "northfork",
    item: "poplar44",
    sku: "NF-PO44",
    name: "Poplar 4/4 FAS S2S",
    uom: "bf",
    perUom: "1",
    price: "3.10",
  },
  // Cascade Panel: sheet goods and edgebanding.
  {
    vendor: "cascade",
    item: "bb34",
    sku: "CP-1034BB",
    name: "3/4 Baltic birch BB/BB 60x60",
    uom: "sheet",
    perUom: "1",
    price: "62.40",
  },
  {
    vendor: "cascade",
    item: "mdf34",
    sku: "CP-MDF34",
    name: "3/4 MDF 49x97",
    uom: "sheet",
    perUom: "1",
    price: "39.10",
  },
  {
    vendor: "cascade",
    item: "maple34",
    sku: "CP-MPL34PF",
    name: "3/4 maple plywood prefinished 4x8",
    uom: "sheet",
    perUom: "1",
    price: "89.50",
  },
  {
    vendor: "cascade",
    item: "mel34",
    sku: "CP-MEL34W",
    name: "3/4 white melamine 4x8",
    uom: "sheet",
    perUom: "1",
    price: "45.75",
  },
  {
    vendor: "cascade",
    item: "edge",
    sku: "CP-EB1516W",
    name: "White PVC edgebanding 15/16 x .5mm, 600 ft roll",
    uom: "roll",
    perUom: "600",
    price: "38.00",
    pack: "600 ft roll",
  },
  // Summit Cabinet Hardware: hinges and slides.
  {
    vendor: "summit",
    item: "hinge",
    sku: "71B3550",
    name: "Blum clip top hinge 110 deg",
    uom: "each",
    perUom: "1",
    price: "4.15",
  },
  {
    vendor: "summit",
    item: "tandem",
    sku: "563H5330B",
    name: "Blum Tandem 21 in full extension slide",
    uom: "each",
    perUom: "1",
    price: "32.40",
  },
  {
    vendor: "summit",
    item: "accuride",
    sku: "3832-22",
    name: "Accuride 3832 22 in full extension slide",
    uom: "each",
    perUom: "1",
    price: "18.90",
  },
  // Bayline Building Supply: a bit of everything.
  {
    vendor: "bayline",
    item: "mdf34",
    sku: "BBS-20417",
    name: "MDF panel 3/4 in 4x8",
    uom: "sheet",
    perUom: "1",
    price: "41.25",
  },
  {
    vendor: "bayline",
    item: "mel34",
    sku: "BBS-30551",
    name: "Melamine white 3/4 4x8",
    uom: "sheet",
    perUom: "1",
    price: "47.10",
  },
  {
    vendor: "bayline",
    item: "glue",
    sku: "BBS-88120",
    name: "Titebond III wood glue, gallon",
    uom: "gallon",
    perUom: "1",
    price: "22.40",
  },
  {
    vendor: "bayline",
    item: "hinge",
    sku: "BBS-61233",
    name: "Blum 71B3550 hinge, box of 50",
    uom: "box",
    perUom: "50",
    price: "199.00",
    pack: "box of 50",
  },
  // Pinecrest Millwork: mouldings and oak.
  {
    vendor: "pinecrest",
    item: "casing",
    sku: "PM-WM366-16",
    name: "WM366 primed MDF casing, 16 ft",
    uom: "piece",
    perUom: "16",
    price: "19.20",
    pack: "16 ft piece",
  },
  {
    vendor: "pinecrest",
    item: "base",
    sku: "PM-WM623-16",
    name: "WM623 primed MDF base, 16 ft",
    uom: "piece",
    perUom: "16",
    price: "24.00",
    pack: "16 ft piece",
  },
  {
    vendor: "pinecrest",
    item: "oak44",
    sku: "PM-RO44",
    name: "Red oak 4/4 FAS rough",
    uom: "bf",
    perUom: "1",
    price: "5.05",
  },
];

/** A line of a bill or purchase: a vendor item and how many, or an amount on an account. */
type LineSpec =
  | { sku: string; qty: string; account: string }
  | { text: string; amount: string; account: string };

interface TxnSpec {
  id: string;
  kind: "bill" | "purchase";
  vendor: string;
  daysAgo: number;
  docNumber: string;
  memo: string;
  /** A purchase's card, by its account id. */
  paidFrom?: string;
  lines: LineSpec[];
}

const TRANSACTIONS: TxnSpec[] = [
  {
    id: "9301",
    kind: "bill",
    vendor: "northfork",
    daysAgo: 52,
    docNumber: "NF-44817",
    memo: "Hollis kitchen: boxes and face frames",
    lines: [
      { sku: "NF-BB34", qty: "20", account: "9212" },
      { sku: "NF-RO44", qty: "150", account: "9212" },
    ],
  },
  {
    id: "9302",
    kind: "bill",
    vendor: "cascade",
    daysAgo: 45,
    docNumber: "CP-210583",
    memo: "Maple Court units 1-4",
    lines: [
      { sku: "CP-MDF34", qty: "30", account: "9212" },
      { sku: "CP-MEL34W", qty: "10", account: "9212" },
      { sku: "CP-EB1516W", qty: "2", account: "9212" },
    ],
  },
  {
    id: "9303",
    kind: "bill",
    vendor: "summit",
    daysAgo: 40,
    docNumber: "SCH-7731",
    memo: "Maple Court units 1-4: hinges and slides",
    lines: [
      { sku: "71B3550", qty: "200", account: "9213" },
      { sku: "563H5330B", qty: "40", account: "9213" },
    ],
  },
  {
    id: "9304",
    kind: "purchase",
    vendor: "westgate",
    daysAgo: 33,
    docNumber: "WF-118204",
    memo: "Fuel, truck 2",
    paidFrom: "9207",
    lines: [{ text: "Diesel, 46.2 gal", amount: "186.42", account: "9217" }],
  },
  {
    id: "9305",
    kind: "bill",
    vendor: "pinecrest",
    daysAgo: 28,
    docNumber: "PM-5520",
    memo: "Hollis kitchen: casing and base",
    lines: [
      { sku: "PM-WM366-16", qty: "24", account: "9214" },
      { sku: "PM-WM623-16", qty: "18", account: "9214" },
    ],
  },
  {
    id: "9306",
    kind: "purchase",
    vendor: "bayline",
    daysAgo: 21,
    docNumber: "BBS-990142",
    memo: "Lakeview Dental: glue and hinges",
    paidFrom: "9206",
    lines: [
      { sku: "BBS-88120", qty: "2", account: "9212" },
      { sku: "BBS-61233", qty: "1", account: "9213" },
    ],
  },
  {
    id: "9307",
    kind: "bill",
    vendor: "granite",
    daysAgo: 17,
    docNumber: "GTR-3087",
    memo: "Drum sander, 3 days",
    lines: [{ text: "Drum sander rental, 3 days", amount: "285.00", account: "9216" }],
  },
  {
    id: "9308",
    kind: "bill",
    vendor: "copperline",
    daysAgo: 12,
    docNumber: "CE-2026-114",
    memo: "Hollis kitchen: under-cabinet lighting and outlets",
    lines: [
      { text: "Under-cabinet lighting, labor and fixtures", amount: "1850.00", account: "9215" },
      { text: "Four new outlets", amount: "600.00", account: "9215" },
    ],
  },
  {
    id: "9309",
    kind: "bill",
    vendor: "northfork",
    daysAgo: 6,
    docNumber: "NF-45230",
    memo: "Lakeview Dental: reception desk",
    lines: [
      { sku: "NF-BB12", qty: "12", account: "9212" },
      { sku: "NF-HM84", qty: "80", account: "9212" },
      { sku: "NF-PO44", qty: "120", account: "9212" },
    ],
  },
  {
    id: "9310",
    kind: "purchase",
    vendor: "westgate",
    daysAgo: 3,
    docNumber: "WF-119377",
    memo: "Fuel, truck 1",
    paidFrom: "9207",
    lines: [{ text: "Regular, 41.8 gal", amount: "142.18", account: "9217" }],
  },
];

// ── The seed ─────────────────────────────────────────────────────────────────────────────────────

export interface SampleCompanySeed {
  counts: SampleCompanyCounts;
  added: SampleCompanyCounts;
  employees: SampleCompanyPerson[];
  switchedOn: string[];
  examples: SampleCompanyExample[];
}

const KINDS = [
  "vendors",
  "organizations",
  "contacts",
  "ledgerAccounts",
  "ledgerNotes",
  "masterItems",
  "vendorItems",
  "transactions",
] as const satisfies readonly (keyof SampleCompanyCounts)[];
type Kind = (typeof KINDS)[number];

const zero = (): SampleCompanyCounts =>
  Object.fromEntries(KINDS.map((k) => [k, 0])) as SampleCompanyCounts;

/** Inserts the rows that are missing (any unique key already taken skips a row): the ids added. */
async function insertMissing<T extends PgTable & { id: PgColumn }>(
  tx: Tx,
  table: T,
  rows: T["$inferInsert"][],
): Promise<string[]> {
  if (rows.length === 0) return [];
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's insert is typed per concrete table
  const inserted: { id: string }[] = await (tx.insert(table) as any)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: table.id });
  return inserted.map((r) => r.id);
}

type Keyed = PgTable & { id: PgColumn; tenantId: PgColumn };

/**
 * The id a seeded record has in the client: its own fixed id, or, where another record already
 * held its unique key when it was first seeded (a vendor of that name), that record's.
 */
async function resolve(
  tx: Tx,
  table: Keyed,
  tenantId: string,
  id: string,
  sameKey?: SQL | undefined,
): Promise<string | null> {
  const first = async (where: SQL | undefined) =>
    (
      await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.tenantId, tenantId), where))
        .limit(1)
    )[0]?.id as string | undefined;
  return (await first(eq(table.id, id))) ?? (sameKey ? await first(sameKey) : undefined) ?? null;
}

/** Which of these ids the client has. */
async function present(
  tx: Tx,
  table: Keyed,
  tenantId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), inArray(table.id, [...new Set(ids)])));
  return new Set(rows.map((r) => r.id as string));
}

const must = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new Error(`sample company: ${what} missing`);
  return v;
};

/** Consent on the addresses they gave the company for work (the directory's relationship basis). */
function relationshipConsent(p: { phone: string | null; email: string | null }, at: Date) {
  return Object.fromEntries(
    relationshipChannelsFor(p).map((ch) => [
      ch,
      { grantedAt: at.toISOString(), source: CONSENT_SOURCE, basis: "relationship" as const },
    ]),
  );
}

/** The operator's own details as the directory keeps them: email lower case, phone E.164. */
export function yourAddresses(you: SampleCompanyYou): {
  name: string;
  email: string | null;
  phone: string | null;
} {
  const email = you.email?.trim().toLowerCase() || null;
  let phone: string | null = null;
  if (you.phone) {
    phone = normalizeSignupPhone(you.phone);
    if (!phone) {
      throw new HttpError(
        422,
        "invalid_phone",
        "Your phone: give it in international form (+15551234567) or as a 10-digit US number",
      );
    }
  }
  return { name: you.name.trim(), email, phone };
}

export async function seedSampleCompany(
  tx: Tx,
  services: Services,
  input: { tenantId: string; userId: string; you?: SampleCompanyYou | undefined; now?: Date },
): Promise<SampleCompanySeed> {
  const { tenantId, userId } = input;
  const now = input.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const id = (name: string) => uuidv5(`sample-company:${tenantId}:${name}`, SAMPLE_NAMESPACE);
  const added = zero();
  const ids: Record<Kind, string[]> = Object.fromEntries(KINDS.map((k) => [k, []])) as never;
  const add = (kind: Kind, rows: readonly string[]) => {
    added[kind] += rows.length;
  };

  // The Purchasing area, for the master items and vendor items to be read through its tools and
  // screens: switched on as the Areas tab does it (its template installed), the first time only.
  const packs = await switchOnPacks(tx, services, tenantId, ["materials"], userId);

  // ── Vendors, their organizations and reps ──
  const vendorIds: Record<string, string> = {};
  const vendorRows: (typeof vendor.$inferInsert)[] = [];
  for (const v of VENDORS) {
    const normalized = normalizeVendorName(v.name);
    vendorRows.push({
      id: await id(`vendor:${v.key}`),
      tenantId,
      name: v.name,
      normalizedName: normalized,
      aliases: [
        ...new Set(v.aliases.map(normalizeVendorName).filter((a) => a && a !== normalized)),
      ],
      externalRefs: { qbo: v.qbo },
      ext: { domains: [v.domain], ...(v.taxId ? { taxId: v.taxId } : {}), sample: true },
      createdAt: now,
    });
  }
  add("vendors", await insertMissing(tx, vendor, vendorRows));
  for (const [i, v] of VENDORS.entries()) {
    const own = must(vendorRows[i]?.id, v.key);
    const found = await resolve(
      tx,
      vendor,
      tenantId,
      own,
      eq(vendor.normalizedName, must(vendorRows[i]?.normalizedName, v.key)),
    );
    vendorIds[v.key] = must(found, `vendor ${v.name}`);
    ids.vendors.push(vendorIds[v.key] as string);
  }

  const ownOrg = await id("organization:own");
  const orgRows: (typeof organization.$inferInsert)[] = [
    {
      id: ownOrg,
      tenantId,
      name: SAMPLE_COMPANY.name,
      kinds: ["own"],
      website: `https://${SAMPLE_COMPANY.domain}`,
      email: `office@${SAMPLE_COMPANY.domain}`,
      phone: SAMPLE_COMPANY.phone,
      address: {
        line1: "1200 Quarry Road",
        city: "Austin",
        region: "TX",
        postalCode: "78701",
        country: "US",
      },
      notes: "Sample company: invented for the Sandbox.",
      source: "manual",
      createdBy: userId,
      createdAt: now,
    },
  ];
  for (const v of VENDORS) {
    orgRows.push({
      id: await id(`organization:${v.key}`),
      tenantId,
      name: v.name,
      kinds: ["vendor"],
      website: `https://${v.domain}`,
      email: `ar@${v.domain}`,
      phone: v.phone,
      externalRefs: { qbo: v.qbo },
      vendorId: vendorIds[v.key] ?? null,
      source: "manual",
      createdBy: userId,
      createdAt: now,
    });
  }
  for (const c of CUSTOMERS) {
    orgRows.push({
      id: await id(`organization:${c.key}`),
      tenantId,
      name: c.name,
      kinds: ["customer"],
      email: c.person.email,
      phone: c.person.phone,
      notes: `Project: ${c.project}`,
      source: "manual",
      createdBy: userId,
      createdAt: now,
    });
  }
  add("organizations", await insertMissing(tx, organization, orgRows));
  const orgIds: Record<string, string | null> = {};
  for (const o of orgRows) {
    const found = await resolve(
      tx,
      organization,
      tenantId,
      o.id as string,
      o.vendorId ? eq(organization.vendorId, o.vendorId) : undefined,
    );
    orgIds[o.id as string] = found;
    if (found) ids.organizations.push(found);
  }
  // Each organization the sample made is logged once, as the directory logs one it creates.
  const orgChanges: (typeof organizationChange.$inferInsert)[] = [];
  for (const o of orgRows) {
    if (orgIds[o.id as string] !== o.id) continue;
    orgChanges.push({
      id: await id(`organization-change:${o.id}`),
      tenantId,
      organizationId: o.id as string,
      actorId: userId,
      change: { kind: "created", from: "manual", sample: true },
      createdAt: now,
    });
  }
  await insertMissing(tx, organizationChange, orgChanges);
  const orgOf = async (key: string) => orgIds[await id(`organization:${key}`)] ?? null;

  // ── People: the company's own, its vendors' reps and its customers ──
  type ContactRow = typeof contact.$inferInsert & { id: string };
  const people: ContactRow[] = [];
  for (const e of EMPLOYEES) {
    people.push({
      id: await id(`contact:${e.key}`),
      tenantId,
      name: e.name,
      email: e.email,
      phone: e.phone,
      title: e.title,
      roles: e.roles,
      relationship: "employee",
      organizationId: await orgOf("own"),
      preferredChannels: ["email"],
      consent: relationshipConsent(e, now),
      source: "manual",
      createdBy: userId,
      createdAt: now,
    });
  }
  for (const v of VENDORS) {
    const rep = { email: `${v.rep.email}@${v.domain}`, phone: v.rep.phone };
    people.push({
      id: await id(`contact:rep:${v.key}`),
      tenantId,
      name: v.rep.name,
      email: rep.email,
      phone: rep.phone,
      title: v.rep.title,
      roles: ["vendor rep"],
      relationship: "vendor",
      organizationId: await orgOf(v.key),
      preferredChannels: ["email"],
      consent: relationshipConsent(rep, now),
      source: "manual",
      createdBy: userId,
      createdAt: now,
    });
  }
  for (const c of CUSTOMERS) {
    people.push({
      id: await id(`contact:customer:${c.key}`),
      tenantId,
      name: c.person.name,
      email: c.person.email,
      phone: c.person.phone,
      title: c.person.title,
      roles: [],
      notes: `Project: ${c.project}`,
      relationship: "customer",
      organizationId: await orgOf(c.key),
      preferredChannels: ["email"],
      consent: relationshipConsent(c.person, now),
      source: "manual",
      createdBy: userId,
      createdAt: now,
    });
  }
  add("contacts", await insertMissing(tx, contact, people));
  const peopleThere = await present(
    tx,
    contact,
    tenantId,
    people.map((p) => p.id),
  );
  ids.contacts.push(...peopleThere);
  const contactChanges: (typeof contactChange.$inferInsert)[] = [];
  for (const p of people) {
    if (!peopleThere.has(p.id)) continue;
    contactChanges.push({
      id: await id(`contact-change:${p.id}`),
      tenantId,
      contactId: p.id,
      actorId: userId,
      change: {
        kind: "created",
        consent: Object.keys(p.consent ?? {}),
        source: CONSENT_SOURCE,
        basis: "relationship",
        from: "manual",
        sample: true,
      },
      createdAt: now,
    });
  }
  await insertMissing(tx, contactChange, contactChanges);

  // The operator as one of the company's employees, with their real address and number.
  let youId: string | null = null;
  if (input.you) {
    const r = await addYou(tx, {
      tenantId,
      userId,
      you: yourAddresses(input.you),
      organizationId: await orgOf("own"),
      id,
      now,
    });
    youId = r.id;
    if (r.created) added.contacts += 1;
  }

  // ── The chart of accounts, on the sample books ──
  // DECISION: the accounts need an accounting connection (one ledger per connection). It is a
  // QuickBooks connection that is disconnected, with no company id and no credentials, named
  // "Sample books": no sync ever reads it, and nothing can write through it. It is dated with the
  // Sandbox's own creation, so a QuickBooks the operator connects in the Sandbox (before or
  // after) is always the newer one a sign-in finds; with none, a sign-in takes this row over as
  // any reconnect does, and the sample accounts stay beside the real company's (ids 9201 on).
  const booksId = await id("connection:books");
  const [client] = await tx
    .select({ createdAt: tenant.createdAt })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  await insertMissing(tx, connection, [
    {
      id: booksId,
      tenantId,
      connector: "qbo",
      status: "disconnected",
      externalAccountId: null,
      credentialsEncrypted: null,
      config: { accountName: "Sample books (Ridgeline Builders)", sample: true },
      createdAt: client?.createdAt ?? now,
    },
  ]);
  const accountIds: Record<string, string> = {};
  const accountRows: (typeof ledgerAccount.$inferInsert)[] = [];
  for (const a of ACCOUNTS) {
    accountIds[a.id] = await id(`ledger:${a.id}`);
    accountRows.push({
      id: accountIds[a.id] as string,
      tenantId,
      connectionId: booksId,
      connector: "qbo",
      externalId: a.id,
      name: a.name,
      fullName: a.name,
      number: a.number,
      classification: a.classification,
      kind: a.kind,
      accountType: a.type,
      accountSubType: a.subType,
      active: true,
    });
  }
  add("ledgerAccounts", await insertMissing(tx, ledgerAccount, accountRows));
  ids.ledgerAccounts.push(...Object.values(accountIds));
  const noteRows: (typeof ledgerAccountNote.$inferInsert)[] = [];
  for (const a of ACCOUNTS) {
    if (!a.note) continue;
    noteRows.push({
      id: await id(`ledger-note:${a.id}`),
      tenantId,
      ledgerAccountId: accountIds[a.id] as string,
      note: a.note,
      source: "operator",
      userId,
      createdAt: now,
    });
  }
  // A note only on an account that is still the sample's own.
  const accountsThere = await present(tx, ledgerAccount, tenantId, Object.values(accountIds));
  add(
    "ledgerNotes",
    await insertMissing(
      tx,
      ledgerAccountNote,
      noteRows.filter((n) => accountsThere.has(n.ledgerAccountId)),
    ),
  );
  ids.ledgerNotes.push(...noteRows.map((n) => n.id as string));

  // ── Master items and the vendors' items ──
  const itemIds: Record<string, string> = {};
  const itemRows: (typeof catalogItem.$inferInsert)[] = [];
  const signatures: Record<string, string | null> = {};
  for (const [key, description] of Object.entries(ITEMS)) {
    const parsed = parseLine(description);
    const signature = keySignature(parsed.category, parsed.attributes);
    signatures[key] = signature;
    itemRows.push({
      id: await id(`item:${key}`),
      tenantId,
      category: parsed.category,
      canonicalName: canonicalName(parsed.category, parsed.attributes, parsed.normalized),
      attributes: parsed.attributes,
      standardUom: parsed.standardUom,
      keySignature: signature,
      createdByUserId: userId,
      ext: { parsedBy: parsed.parsedBy, firstDescription: parsed.normalized, sample: true },
    });
  }
  add("masterItems", await insertMissing(tx, catalogItem, itemRows));
  for (const [i, key] of Object.keys(ITEMS).entries()) {
    const own = must(itemRows[i]?.id, key);
    const signature = signatures[key];
    const found = await resolve(
      tx,
      catalogItem,
      tenantId,
      own,
      signature
        ? and(eq(catalogItem.keySignature, signature), isNull(catalogItem.mergedIntoId))
        : undefined,
    );
    itemIds[key] = must(found, `master item ${key}`);
    ids.masterItems.push(itemIds[key] as string);
  }

  const vendorItemIds: Record<string, string> = {};
  const vendorItemRows: (typeof vendorItem.$inferInsert)[] = [];
  const priceOn = addDays(today, -6);
  for (const vi of VENDOR_ITEMS) {
    // Upper case, as matching reads a SKU; each names one item (the pack's `identifyingSku`).
    const sku = vi.sku.trim().toUpperCase();
    vendorItemRows.push({
      id: await id(`vendor-item:${vi.vendor}:${sku}`),
      tenantId,
      vendorId: must(vendorIds[vi.vendor], vi.vendor),
      catalogItemId: must(itemIds[vi.item], vi.item),
      sku,
      name: vi.name,
      packSize: vi.pack ?? null,
      vendorUom: vi.uom,
      stdPerVendorUom: toNumeric(vi.perUom),
      lastPrice: toNumeric(vi.price),
      lastPriceStd: toNumeric(dec(vi.price).dividedBy(vi.perUom)),
      lastPriceOn: priceOn,
      lastPriceSource: "import",
      currency: "USD",
      createdByUserId: userId,
      ext: { sample: true },
    });
  }
  add("vendorItems", await insertMissing(tx, vendorItem, vendorItemRows));
  for (const [i, vi] of VENDOR_ITEMS.entries()) {
    const row = must(vendorItemRows[i], vi.sku);
    const found = await resolve(
      tx,
      vendorItem,
      tenantId,
      row.id as string,
      and(eq(vendorItem.vendorId, row.vendorId), eq(vendorItem.sku, row.sku as string)),
    );
    vendorItemIds[vi.sku] = must(found, `vendor item ${vi.sku}`);
    ids.vendorItems.push(vendorItemIds[vi.sku] as string);
  }

  // ── Bills and purchases ──
  const txnRows: (typeof transaction.$inferInsert)[] = [];
  const lineRows: (typeof transactionLine.$inferInsert)[] = [];
  for (const t of TRANSACTIONS) {
    const txnId = await id(`transaction:${t.id}`);
    let total = dec("0");
    for (const [n, line] of t.lines.entries()) {
      let amount: string;
      let description: string;
      let qty: string | null = null;
      let unitPrice: string | null = null;
      if ("sku" in line) {
        const spec = must(
          VENDOR_ITEMS.find((v) => v.vendor === t.vendor && v.sku === line.sku),
          line.sku,
        );
        amount = toNumeric(dec(spec.price).times(line.qty).toDecimalPlaces(2));
        description = `${spec.sku} ${spec.name}`;
        qty = toNumeric(line.qty);
        unitPrice = toNumeric(spec.price);
      } else {
        amount = toNumeric(line.amount);
        description = line.text;
      }
      total = total.plus(amount);
      lineRows.push({
        tenantId,
        transactionId: txnId,
        lineNo: n + 1,
        detailType: "account",
        accountRef: line.account,
        description,
        qty,
        unitPrice,
        amount,
      });
    }
    const entity = t.kind === "bill" ? "Bill" : "Purchase";
    const card = t.paidFrom ? ACCOUNTS.find((a) => a.id === t.paidFrom) : undefined;
    txnRows.push({
      id: txnId,
      tenantId,
      kind: t.kind,
      connector: "qbo",
      vendorId: must(vendorIds[t.vendor], t.vendor),
      txnDate: addDays(today, -t.daysAgo),
      total: toNumeric(total),
      currency: "USD",
      purchaserRef: card?.name ?? null,
      paymentType: card ? "CreditCard" : null,
      memo: t.memo,
      externalId: qboTransactionExternalId(entity, t.id),
      ext: {
        qbo: {
          entity,
          id: t.id,
          syncToken: null,
          docNumber: t.docNumber,
          dueDate: t.kind === "bill" ? addDays(today, 30 - t.daysAgo) : null,
          tax: null,
          accountId: card?.id ?? null,
        },
        sample: true,
      },
      createdAt: now,
    });
  }
  const newTxns = new Set(await insertMissing(tx, transaction, txnRows));
  add("transactions", [...newTxns]);
  ids.transactions.push(...txnRows.map((t) => t.id as string));
  // A bill's lines go in with it, never later: one the operator has changed keeps its lines.
  const newLines = lineRows.filter((l) => newTxns.has(l.transactionId));
  if (newLines.length > 0) await tx.insert(transactionLine).values(newLines);

  // ── What is there now ──
  if (youId) ids.contacts.push(youId);
  const tables: Record<Kind, Keyed> = {
    vendors: vendor,
    organizations: organization,
    contacts: contact,
    ledgerAccounts: ledgerAccount,
    ledgerNotes: ledgerAccountNote,
    masterItems: catalogItem,
    vendorItems: vendorItem,
    transactions: transaction,
  };
  const counts = zero();
  for (const k of KINDS) counts[k] = (await present(tx, tables[k], tenantId, ids[k])).size;

  const employeeIds = [
    ...(await Promise.all(EMPLOYEES.map((e) => id(`contact:${e.key}`)))),
    ...(youId ? [youId] : []),
  ];
  const employeeRows = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), inArray(contact.id, employeeIds)));
  const employees = employeeIds.flatMap((cid) => {
    const c = employeeRows.find((r) => r.id === cid);
    return c
      ? [
          {
            contactId: c.id,
            name: c.name,
            email: c.email,
            phone: c.phone,
            title: c.title,
            you: c.id === youId,
          },
        ]
      : [];
  });

  const northfork = must(VENDORS[0], "vendor");
  return {
    counts,
    added,
    employees,
    switchedOn: packs.switchedOn,
    examples: [
      { what: "A vendor by name", value: "Northfork Lumber" },
      { what: "A vendor by email address", value: `${northfork.rep.email}@${northfork.domain}` },
      { what: "A vendor by accounting id", value: northfork.qbo },
      { what: "A vendor by tax id", value: northfork.taxId ?? "" },
      { what: "A SKU at Northfork Lumber", value: "NF-BB34" },
      { what: "A master item", value: '3/4" Baltic birch BB/BB 5x5' },
      { what: "An account", value: "6000 Fuel" },
    ],
  };
}

/**
 * The operator as an employee of the sample company: their contact if the Sandbox already has one
 * with this email or number (made an employee if it wasn't one), else a new one.
 */
async function addYou(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    you: { name: string; email: string | null; phone: string | null };
    organizationId: string | null;
    id: (name: string) => Promise<string>;
    now: Date;
  },
): Promise<{ id: string; created: boolean }> {
  const { you } = input;
  return addSandboxPerson(tx, {
    tenantId: input.tenantId,
    userId: input.userId,
    person: you,
    relationship: "employee",
    always: true,
    organizationId: input.organizationId,
    id: await input.id(`contact:you:${input.userId}:${you.email ?? you.phone ?? you.name}`),
    now: input.now,
    entry: {
      title: "Operator (you)",
      roles: ["operator"],
      notes:
        "You, added to the sample company so your own email and texts arrive as an employee's.",
    },
    conflict: (email, phone) =>
      `Your email is ${email}'s and your phone is ${phone}'s in the Sandbox's directory. Give one of them, or change those contacts first.`,
    mark: { sample: true },
  });
}

/**
 * Someone in the Sandbox's directory by email or number (the operator in the sample company, or a
 * test message's sender typed in Try it): the contact that has either already (given the
 * relationship and the address it lacks), else a new one with consent on the addresses given, as
 * the sample company's people have. Email lower case and phone E.164, as the caller gives them.
 */
export async function addSandboxPerson(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    person: { name: string; email: string | null; phone: string | null };
    relationship: Relationship | null;
    /** Make a contact found with another relationship this one (else only one that has none). */
    always?: boolean;
    /** Labels the contact needs (`contact.roles`), added where missing. */
    tags?: readonly string[];
    organizationId: string | null;
    /** The new contact's id. */
    id: string;
    now: Date;
    entry: { title: string | null; roles: string[]; notes: string };
    /** The 409's words when the email and the number are two different contacts'. */
    conflict(emailOf: string, phoneOf: string): string;
    /** What the directory's history notes on the change. */
    mark: Record<string, unknown>;
  },
): Promise<{ id: string; created: boolean }> {
  const { tenantId, userId, person, now } = input;
  const byEmail = person.email
    ? (
        await tx
          .select()
          .from(contact)
          .where(and(eq(contact.tenantId, tenantId), eq(contact.email, person.email)))
      )[0]
    : undefined;
  const byPhone = person.phone
    ? (
        await tx
          .select()
          .from(contact)
          .where(
            and(
              eq(contact.tenantId, tenantId),
              or(eq(contact.phone, person.phone), eq(contact.whatsapp, person.phone)),
            ),
          )
      )[0]
    : undefined;
  if (byEmail && byPhone && byEmail.id !== byPhone.id) {
    throw new HttpError(409, "contact_conflict", input.conflict(byEmail.name, byPhone.name));
  }
  const tags = input.tags ?? [];
  const found = byEmail ?? byPhone;
  if (found) {
    const set: Partial<typeof contact.$inferInsert> = {};
    if (
      input.relationship &&
      found.relationship !== input.relationship &&
      (input.always || !found.relationship)
    ) {
      set.relationship = input.relationship;
    }
    const missing = tags.filter((t) => !found.roles.includes(t));
    if (missing.length > 0) set.roles = [...found.roles, ...missing];
    if (person.email && !found.email) set.email = person.email;
    if (person.phone && !found.phone) set.phone = person.phone;
    if (
      person.phone &&
      !found.whatsapp &&
      !(await numberTaken(tx, tenantId, person.phone, found.id))
    ) {
      set.whatsapp = person.phone;
    }
    if (!found.organizationId && input.organizationId) set.organizationId = input.organizationId;
    if (Object.keys(set).length > 0) {
      await tx
        .update(contact)
        .set(set)
        .where(and(eq(contact.id, found.id), eq(contact.tenantId, tenantId)));
      await tx.insert(contactChange).values({
        tenantId,
        contactId: found.id,
        actorId: userId,
        change: {
          kind: "edited",
          fields: Object.keys(set),
          ...(set.relationship
            ? { relationship: { from: found.relationship, to: set.relationship } }
            : {}),
          ...input.mark,
        },
      });
    }
    return { id: found.id, created: false };
  }
  const cid = input.id;
  const whatsapp =
    person.phone && !(await numberTaken(tx, tenantId, person.phone, cid)) ? person.phone : null;
  const consent = relationshipConsent(person, now);
  const [made] = await insertMissing(tx, contact, [
    {
      id: cid,
      tenantId,
      name: person.name,
      email: person.email,
      phone: person.phone,
      whatsapp,
      title: input.entry.title,
      roles: [...input.entry.roles, ...tags.filter((t) => !input.entry.roles.includes(t))],
      relationship: input.relationship,
      organizationId: input.organizationId,
      preferredChannels: person.email ? ["email"] : [],
      consent,
      notes: input.entry.notes,
      source: "manual",
      createdBy: userId,
      createdAt: now,
    },
  ]);
  if (made) {
    await tx.insert(contactChange).values({
      tenantId,
      contactId: cid,
      actorId: userId,
      change: {
        kind: "created",
        consent: Object.keys(consent),
        source: CONSENT_SOURCE,
        basis: "relationship",
        from: "manual",
        ...input.mark,
      },
    });
  }
  return { id: cid, created: !!made };
}

/** Whether another of the client's contacts has this number as its WhatsApp number. */
async function numberTaken(tx: Tx, tenantId: string, phone: string, except: string) {
  const [row] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(contact.whatsapp, phone)))
    .limit(1);
  return !!row && row.id !== except;
}
