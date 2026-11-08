// P-2: QuickBooks ingredients (docs/plan.md §1.64, M35), against the fake QuickBooks: the account
// and class reads; a class and a customer on bill lines (validated, sent, named on the card and in
// the before state, read back); a new vendor and a new purchase order (inputs validated, totals
// checked, duplicates refused when proposed and again before writing, written once across a
// retry); the purchase order read; and how the permission gate decides each new tool, per entity.

import {
  DEFAULT_PERMISSIONS,
  decideToolCall,
  type JsonObject,
  type PermissionMatrix,
  ToolDisplay,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { SyncedRecordServices, ToolContext, WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode } from "../http";
import { captureBefore, executeWrite, runReadTool, ToolCallError } from "../invoke";
import { memoryLogger } from "../logger";
import { connectionLevel } from "../permissions";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "../testing";
import { createQboConnector, normalizeVendorName, QBO_TOOLS } from "./index";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const user = "0190f0c8-0000-7000-8000-0000000000a1";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";
const REDIRECT = "https://staging.mezonas.com/api/connections/qbo/callback";
const SHOP = "5000000000000301";
const PORTLAND = "5000000000000303";
const OLD_SHOP = "5000000000000304";

const queryOf = (url: string) => formDecode(url.split("?")[1] ?? "");

const noSyncedBills: SyncedRecordServices = {
  async syncedBills() {
    return [];
  },
  async receivableIds() {
    return {};
  },
};

async function setup(permissions: PermissionMatrix = DEFAULT_PERMISSIONS) {
  const qbo = fakeQbo({ now: () => NOW });
  const connector = createQboConnector({
    ...FAKE_QBO_CLIENT,
    environment: "sandbox",
    fetch: qbo.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const grant = await connector.handleCallback?.(
    { code: "fixture-code", realmId: FAKE_QBO_REALM, state: "x" },
    { tenantId: tenant, userId: user, redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  const store = memoryCredentials(grant.credentials as JsonObject);
  const ctx = (key = "run-1:step-1:0"): WriteContext => ({
    tenantId: tenant,
    connection: {
      id: connectionId,
      tenantId: tenant,
      connector: "qbo",
      status: "connected",
      externalAccountId: FAKE_QBO_REALM,
      config: {},
      permissions,
    },
    credentials: store,
    logger: memoryLogger(),
    now: () => NOW,
    idempotencyKey: key,
    services: { records: noSyncedBills },
  });
  /** A proposal's context, as the runtime gives it: no action key yet. */
  const propose = (): ToolContext => {
    const { idempotencyKey: _key, ...rest } = ctx();
    return rest;
  };
  const read = async (tool: string, input: unknown) =>
    // biome-ignore lint/suspicious/noExplicitAny: outputs are read loosely in tests.
    (await runReadTool(connector, tool, input, ctx())).output as any;
  return { qbo, connector, ctx, propose, read };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("it was not refused");
}

async function invalid(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ToolCallError && error.code === "invalid_input") {
      return (error.issues ?? []).map((i) => i.message).join("; ");
    }
    throw error;
  }
  throw new Error("the input was accepted");
}

describe("qbo.account.query", () => {
  it("lists active accounts by type or name, with their full name, subtype and currency", async () => {
    const s = await setup();
    const all = await s.read(QBO_TOOLS.accountQuery, {});
    expect(all.accounts.map((a: { id: string }) => a.id).sort()).toEqual([
      "33",
      "80",
      "81",
      "84",
      "90",
    ]);
    const costs = await s.read(QBO_TOOLS.accountQuery, {
      types: ["Expense", "Cost of Goods Sold"],
    });
    expect(costs.accounts.map((a: { name: string }) => a.name)).toEqual([
      "Freight In",
      "Job Materials",
      "Shop Supplies",
    ]);
    expect(costs.accounts[0]).toEqual({
      id: "81",
      name: "Freight In",
      fullyQualifiedName: "Job Materials:Freight In",
      accountType: "Cost of Goods Sold",
      accountSubType: "ShippingFreightDeliveryCos",
      active: true,
      currency: "USD",
    });
    const liabilities = await s.read(QBO_TOOLS.accountQuery, {
      types: ["Other Current Liability"],
    });
    expect(liabilities.accounts.map((a: { id: string }) => a.id)).toEqual(["90"]);
    const named = await s.read(QBO_TOOLS.accountQuery, { nameContains: "freight" });
    expect(named.accounts.map((a: { id: string }) => a.id)).toEqual(["81"]);
    const inactive = await s.read(QBO_TOOLS.accountQuery, { active: false });
    expect(inactive.accounts).toMatchObject([{ id: "85", name: "Old Freight", active: false }]);
    const first = await s.read(QBO_TOOLS.accountQuery, { limit: 2 });
    expect(first.accounts).toHaveLength(2);
    expect(first.more).toBe(true);
    // What an agent types is a literal, quotes escaped.
    await s.read(QBO_TOOLS.accountQuery, { nameContains: "O'Brien" });
    const q = queryOf(s.qbo.apiCalls("GET", "query").at(-1)?.url ?? "").query ?? "";
    expect(q).toContain("Active = true");
    expect(q).toContain("Name like '%O\\'Brien%'");
    expect(await invalid(s.read(QBO_TOOLS.accountQuery, { types: [] }))).toMatch(/1/);
  });
});

describe("qbo.class.query", () => {
  it("lists active classes by name, with parents, by id, and inactive ones when asked", async () => {
    const s = await setup();
    const all = await s.read(QBO_TOOLS.classQuery, {});
    expect(all.classes).toEqual([
      { id: "5000000000000302", name: "Install", fullyQualifiedName: "Install", active: true },
      {
        id: PORTLAND,
        name: "Portland",
        fullyQualifiedName: "Install:Portland",
        active: true,
      },
      { id: SHOP, name: "Shop", fullyQualifiedName: "Shop", active: true },
    ]);
    expect(all.more).toBe(false);
    const byId = await s.read(QBO_TOOLS.classQuery, { ids: [SHOP] });
    expect(byId.classes.map((c: { name: string }) => c.name)).toEqual(["Shop"]);
    const old = await s.read(QBO_TOOLS.classQuery, { active: false });
    expect(old.classes.map((c: { id: string }) => c.id)).toEqual([OLD_SHOP]);
  });
});

describe("class and customer on bill lines", () => {
  const bill = {
    vendorId: "58",
    docNumber: "PHF-3302",
    txnDate: "2026-11-04",
    expectedTotal: "212.50",
    lines: [
      {
        itemId: "23",
        description: "Euro hinge 110",
        qty: "50",
        unitPrice: "3.25",
        amount: "162.50",
        classId: PORTLAND,
        customerId: "7",
        billable: true,
      },
      { accountId: "81", description: "Freight", amount: "50.00", customerId: "8" },
    ],
  };

  it("sends them, names them on the card, and reads them back", async () => {
    const s = await setup();
    const proposed = await captureBefore(s.connector, QBO_TOOLS.billCreate, bill, s.propose());
    expect(proposed.before).toEqual({
      vendor: { id: "58", name: "Pacific Hardware & Finishes" },
      names: {
        items: { "23": "Euro hinge 110 degree" },
        accounts: { "81": "Job Materials:Freight In" },
        classes: { [PORTLAND]: "Install:Portland" },
        customers: { "7": "Henderson kitchen", "8": "Lakeside Builders" },
      },
    });
    const written = await executeWrite(s.connector, QBO_TOOLS.billCreate, bill, s.ctx());
    const body = JSON.parse(s.qbo.apiCalls("POST", "bill")[0]?.body ?? "{}");
    expect(body.Line[0].ItemBasedExpenseLineDetail).toMatchObject({
      ItemRef: { value: "23" },
      ClassRef: { value: PORTLAND },
      CustomerRef: { value: "7" },
      BillableStatus: "Billable",
    });
    // A customer without `billable` is not billed.
    expect(body.Line[1].AccountBasedExpenseLineDetail).toEqual({
      AccountRef: { value: "81" },
      CustomerRef: { value: "8" },
      BillableStatus: "NotBillable",
    });
    const id = (written.output as { id: string }).id;
    const back = await s.read(QBO_TOOLS.billQuery, { ids: [id] });
    expect(back.bills[0].lines).toMatchObject([
      { class: { id: PORTLAND }, customer: { id: "7" }, billable: "Billable" },
      { class: null, customer: { id: "8" }, billable: "NotBillable" },
    ]);
    // The card shows them by name, with what each line is booked to.
    const display = ToolDisplay.parse(
      s.connector.manifest.tools.find((t) => t.id === QBO_TOOLS.billCreate)?.display,
    );
    expect(display.fields.find((f) => f.kind === "lines")?.columns?.tags).toEqual([
      { key: "customerId", names: "customers" },
      { key: "classId", names: "classes" },
    ]);
  });

  it("validates them: billable needs a customer, ids are QuickBooks ids", async () => {
    const s = await setup();
    const line = bill.lines[1] as Record<string, unknown>;
    const withLine = (l: Record<string, unknown>) => ({
      ...bill,
      expectedTotal: "50.00",
      lines: [l],
    });
    expect(
      await invalid(
        captureBefore(
          s.connector,
          QBO_TOOLS.billCreate,
          withLine({ ...line, customerId: undefined, billable: true }),
          s.propose(),
        ),
      ),
    ).toMatch(/billable needs a customerId/);
    expect(
      await invalid(
        captureBefore(
          s.connector,
          QBO_TOOLS.billCreate,
          withLine({ ...line, classId: "Shop" }),
          s.propose(),
        ),
      ),
    ).toMatch(/QuickBooks id/);
  });

  it("refuses a class or customer the company doesn't have, or has made inactive, at both ends", async () => {
    const s = await setup();
    const withClass = (classId: string) => ({
      ...bill,
      lines: [{ ...bill.lines[0], classId }, bill.lines[1]],
    });
    expect(
      await refusal(
        captureBefore(s.connector, QBO_TOOLS.billCreate, withClass("777"), s.propose()),
      ),
    ).toMatch(/class 777 isn't one of this company's/);
    expect(
      await refusal(executeWrite(s.connector, QBO_TOOLS.billCreate, withClass(OLD_SHOP), s.ctx())),
    ).toMatch(/inactive/);
    const unknownJob = { ...bill, lines: [bill.lines[0], { ...bill.lines[1], customerId: "70" }] };
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.billCreate, unknownJob, s.propose())),
    ).toMatch(/customer 70 isn't one of this company's/);
    expect(s.qbo.apiCalls("POST", "bill")).toHaveLength(0);
  });

  it("itemizing keeps the replaced line's job unless a new line names its own", async () => {
    const s = await setup();
    const itemize = {
      id: "145",
      syncToken: "0",
      expectedTotal: "1352.75",
      replaceLineIds: ["1"],
      lines: [
        { itemId: "21", qty: "18", unitPrice: "64.00", amount: "1152.00", classId: SHOP },
        { itemId: "23", qty: "50", unitPrice: "3.2", amount: "160.00" },
        { accountId: "81", amount: "40.75", customerId: "8", billable: true },
      ],
    };
    const proposed = await captureBefore(
      s.connector,
      QBO_TOOLS.billUpdateLines,
      itemize,
      s.propose(),
    );
    // The record's line is named with its job; the new lines' class and customer by name.
    expect(proposed.before).toMatchObject({
      lines: [{ id: "1", customer: { id: "7", name: "Henderson kitchen" }, billable: "Billable" }],
      names: { classes: { [SHOP]: "Shop" }, customers: { "8": "Lakeside Builders" } },
    });
    await executeWrite(s.connector, QBO_TOOLS.billUpdateLines, itemize, s.ctx());
    const after = await s.read(QBO_TOOLS.billQuery, { ids: ["145"] });
    expect(
      after.bills[0].lines.map(
        (l: {
          class: { id: string } | null;
          customer: { id: string } | null;
          billable: string;
        }) => [l.class?.id ?? null, l.customer?.id ?? null, l.billable],
      ),
    ).toEqual([
      [SHOP, "7", "Billable"],
      [null, "7", "Billable"],
      [null, "8", "Billable"],
    ]);
    // A retry finds the lines it wrote, class and customer included: nothing written twice.
    const again = await executeWrite(s.connector, QBO_TOOLS.billUpdateLines, itemize, s.ctx());
    expect(again.output).toMatchObject({ alreadyDone: true });
    expect(s.qbo.apiCalls("POST", "bill")).toHaveLength(1);
  });

  it("purchases take them too, and refuse a class the company doesn't have", async () => {
    const s = await setup();
    const purchase = (await s.read(QBO_TOOLS.purchaseQuery, { limit: 1 })).purchases[0] as {
      id: string;
      syncToken: string;
      total: string;
      lines: { id: string; amount: string }[];
    };
    const line = purchase.lines[0];
    if (!line) throw new Error("no purchase line");
    const input = (classId: string) => ({
      id: purchase.id,
      syncToken: purchase.syncToken,
      expectedTotal: purchase.total,
      replaceLineIds: [line.id],
      lines: [{ accountId: "84", amount: line.amount, classId }],
    });
    expect(
      await refusal(
        captureBefore(s.connector, QBO_TOOLS.purchaseUpdateLines, input("777"), s.propose()),
      ),
    ).toMatch(/class 777/);
    await executeWrite(s.connector, QBO_TOOLS.purchaseUpdateLines, input(SHOP), s.ctx());
    const body = JSON.parse(s.qbo.apiCalls("POST", "purchase")[0]?.body ?? "{}");
    expect(body.Line.at(-1).AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: SHOP });
  });
});

describe("qbo.vendor.create", () => {
  const vendor = {
    displayName: "Rogue Valley Veneers",
    companyName: "Rogue Valley Veneers LLC",
    email: "ap@roguevalley.example",
    phone: "(541) 555-0190",
    billingAddress: {
      line1: "88 Mill St",
      city: "Medford",
      region: "OR",
      postalCode: "97501",
      country: "US",
    },
    termsId: "3",
  };

  it("names on the card that nothing existed, creates the vendor once, and gives its id", async () => {
    const s = await setup();
    const proposed = await captureBefore(s.connector, QBO_TOOLS.vendorCreate, vendor, s.propose());
    expect(proposed.before).toEqual({
      existing: null,
      billingAddress: "88 Mill St, Medford, OR 97501, US",
      terms: { id: "3", name: "Net 30" },
    });
    const written = await executeWrite(s.connector, QBO_TOOLS.vendorCreate, vendor, s.ctx());
    expect(written.output).toMatchObject({
      displayName: "Rogue Valley Veneers",
      syncToken: "0",
      alreadyDone: false,
    });
    expect(written.before).toMatchObject({ existing: null });
    expect(written.summary).toBe("Added vendor Rogue Valley Veneers to QuickBooks");
    const id = (written.output as { id: string }).id;
    const posts = s.qbo.apiCalls("POST", "vendor");
    expect(posts).toHaveLength(1);
    expect(queryOf(posts[0]?.url ?? "").requestid).toMatch(/^[0-9a-f]{36}$/);
    expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({
      DisplayName: "Rogue Valley Veneers",
      CompanyName: "Rogue Valley Veneers LLC",
      PrimaryEmailAddr: { Address: "ap@roguevalley.example" },
      PrimaryPhone: { FreeFormNumber: "(541) 555-0190" },
      BillAddr: {
        Line1: "88 Mill St",
        City: "Medford",
        CountrySubDivisionCode: "OR",
        PostalCode: "97501",
        Country: "US",
      },
      TermRef: { value: "3" },
    });
    expect(s.qbo.get("Vendor", id)).toMatchObject({ DisplayName: "Rogue Valley Veneers" });

    // The same action again (a retried step): the vendor is found, not created twice.
    const again = await executeWrite(s.connector, QBO_TOOLS.vendorCreate, vendor, s.ctx());
    expect(again.output).toMatchObject({ id, alreadyDone: true });
    expect(s.qbo.apiCalls("POST", "vendor")).toHaveLength(1);
    // A later step can use the new vendor's id: a bill for it.
    const bill = await captureBefore(
      s.connector,
      QBO_TOOLS.billCreate,
      {
        vendorId: id,
        docNumber: "RVV-1",
        txnDate: "2026-11-05",
        expectedTotal: "50.00",
        lines: [{ accountId: "84", amount: "50.00" }],
      },
      s.propose(),
    );
    expect(bill.before).toMatchObject({ vendor: { id, name: "Rogue Valley Veneers" } });
    // And the name is taken for any other proposal.
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.vendorCreate, vendor, s.propose())),
    ).toMatch(/already has a vendor named "Rogue Valley Veneers"/);
  });

  it("refuses a name that is there, whatever its case and spacing, when proposed and before writing", async () => {
    const s = await setup();
    expect(normalizeVendorName("  Pacific   HARDWARE & finishes ")).toBe(
      normalizeVendorName("Pacific Hardware & Finishes"),
    );
    const taken = { displayName: "  pacific   hardware & FINISHES " };
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.vendorCreate, taken, s.propose())),
    ).toMatch(/already has a vendor named "Pacific Hardware & Finishes" \(id 58\)/);
    // An inactive vendor holds its name too.
    s.qbo.put("Vendor", {
      Id: "61",
      SyncToken: "3",
      DisplayName: "Old Mill Lumber",
      Active: false,
    });
    expect(
      await refusal(
        captureBefore(
          s.connector,
          QBO_TOOLS.vendorCreate,
          { displayName: "old mill lumber" },
          s.propose(),
        ),
      ),
    ).toMatch(/an inactive vendor named "Old Mill Lumber"/);
    // Someone adds the vendor in QuickBooks after it was proposed: refused before writing.
    const proposed = await captureBefore(s.connector, QBO_TOOLS.vendorCreate, vendor, s.propose());
    expect(proposed.before).toMatchObject({ existing: null });
    s.qbo.put("Vendor", {
      Id: "62",
      SyncToken: "0",
      DisplayName: "Rogue Valley Veneers",
      PrimaryEmailAddr: { Address: "billing@other.example" },
      Active: true,
    });
    expect(
      await refusal(executeWrite(s.connector, QBO_TOOLS.vendorCreate, vendor, s.ctx())),
    ).toMatch(/already has a vendor named "Rogue Valley Veneers" \(id 62\)/);
    expect(s.qbo.apiCalls("POST", "vendor")).toHaveLength(0);
  });

  it("refuses unknown terms, a name a customer has, and input that isn't valid", async () => {
    const s = await setup();
    expect(
      await refusal(
        captureBefore(
          s.connector,
          QBO_TOOLS.vendorCreate,
          { ...vendor, termsId: "99" },
          s.propose(),
        ),
      ),
    ).toMatch(/terms 99 aren't one of this company's/);
    // Names are unique across customers and vendors in QuickBooks: its refusal is a duplicate.
    const customer = { displayName: "Lakeside Builders" };
    expect(
      await refusal(executeWrite(s.connector, QBO_TOOLS.vendorCreate, customer, s.ctx())),
    ).toMatch(/already has a customer, vendor or employee named "Lakeside Builders"/);
    expect(
      await invalid(
        captureBefore(
          s.connector,
          QBO_TOOLS.vendorCreate,
          { ...vendor, email: "not an email" },
          s.propose(),
        ),
      ),
    ).toMatch(/email/i);
    expect(
      await invalid(
        captureBefore(s.connector, QBO_TOOLS.vendorCreate, { displayName: " " }, s.propose()),
      ),
    ).toMatch(/1/);
  });
});

describe("qbo.purchaseorder.create", () => {
  const po = {
    vendorId: "57",
    docNumber: "PO-1002",
    txnDate: "2026-11-05",
    dueDate: "2026-11-19",
    expectedTotal: "1125.00",
    memo: "Walnut for the Lakeside lobby",
    shipTo: { line1: "410 Shop Rd", city: "Portland", region: "OR", postalCode: "97217" },
    lines: [
      {
        itemId: "22",
        description: "White oak 4/4 FAS, 120 bf",
        qty: "120",
        unitPrice: "8.75",
        amount: "1050.00",
        classId: SHOP,
        customerId: "8",
        billable: true,
      },
      { accountId: "81", description: "Delivery", amount: "75.00" },
    ],
  };

  it("names the vendor and the lines for the card, creates the order once, open", async () => {
    const s = await setup();
    const proposed = await captureBefore(
      s.connector,
      QBO_TOOLS.purchaseOrderCreate,
      po,
      s.propose(),
    );
    expect(proposed.before).toEqual({
      vendor: { id: "57", name: "Cascade Hardwoods" },
      names: {
        items: { "22": "White oak 4/4 FAS" },
        accounts: { "81": "Job Materials:Freight In" },
        classes: { [SHOP]: "Shop" },
        customers: { "8": "Lakeside Builders" },
      },
      shipTo: "410 Shop Rd, Portland, OR 97217",
    });
    const written = await executeWrite(s.connector, QBO_TOOLS.purchaseOrderCreate, po, s.ctx());
    expect(written.output).toMatchObject({
      docNumber: "PO-1002",
      total: "1125.0000",
      status: "Open",
      lineCount: 2,
      syncToken: "0",
      alreadyDone: false,
    });
    expect(written.summary).toBe("Created purchase order PO-1002 for 1125.00");
    const posts = s.qbo.apiCalls("POST", "purchaseorder");
    expect(posts).toHaveLength(1);
    expect(queryOf(posts[0]?.url ?? "").requestid).toMatch(/^[0-9a-f]{36}$/);
    const body = JSON.parse(posts[0]?.body ?? "{}");
    expect(body).toMatchObject({
      VendorRef: { value: "57" },
      APAccountRef: { value: "33" },
      DocNumber: "PO-1002",
      TxnDate: "2026-11-05",
      DueDate: "2026-11-19",
      PrivateNote: "Walnut for the Lakeside lobby",
      ShipAddr: { Line1: "410 Shop Rd", City: "Portland", CountrySubDivisionCode: "OR" },
    });
    expect(body.Line[0].ItemBasedExpenseLineDetail).toMatchObject({
      ClassRef: { value: SHOP },
      CustomerRef: { value: "8" },
      BillableStatus: "Billable",
    });
    // Amounts went out as JSON numbers written from their decimal text.
    expect(posts[0]?.body).toContain('"Amount":1050');

    // The same action again (a retried step): the order is found, not created twice.
    const id = (written.output as { id: string }).id;
    const again = await executeWrite(s.connector, QBO_TOOLS.purchaseOrderCreate, po, s.ctx());
    expect(again.output).toMatchObject({ id, alreadyDone: true });
    expect(s.qbo.apiCalls("POST", "purchaseorder")).toHaveLength(1);
    // And it is now a duplicate for any other proposal.
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.purchaseOrderCreate, po, s.propose())),
    ).toMatch(/purchase order PO-1002 from this vendor is already in QuickBooks/);
  });

  it("refuses a number the vendor already has (compared on letters and digits), at both ends", async () => {
    const s = await setup();
    const taken = { ...po, docNumber: "po 1001" };
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.purchaseOrderCreate, taken, s.propose())),
    ).toMatch(/already in QuickBooks/);
    // The number is per vendor: another vendor's PO-1001 is fine.
    const other = { ...po, vendorId: "58", docNumber: "PO-1001" };
    await captureBefore(s.connector, QBO_TOOLS.purchaseOrderCreate, other, s.propose());
    // Someone enters the order in QuickBooks after it was proposed: refused before writing.
    s.qbo.put("PurchaseOrder", {
      ...(s.qbo.get("PurchaseOrder", "171") as { Id: string }),
      Id: "172",
      VendorRef: { value: "58", name: "Pacific Hardware & Finishes" },
      TotalAmt: 10,
    });
    expect(
      await refusal(executeWrite(s.connector, QBO_TOOLS.purchaseOrderCreate, other, s.ctx())),
    ).toMatch(/already in QuickBooks/);
    expect(s.qbo.apiCalls("POST", "purchaseorder")).toHaveLength(0);
  });

  it("refuses lines that don't add up, a zero order, a vendor not the company's", async () => {
    const s = await setup();
    const off = { ...po, expectedTotal: "1100.00" };
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.purchaseOrderCreate, off, s.propose())),
    ).toMatch(/add up to 1125.0000, not the 1100.00 expected/);
    expect(
      await refusal(executeWrite(s.connector, QBO_TOOLS.purchaseOrderCreate, off, s.ctx())),
    ).toMatch(/add up/);
    const zero = {
      ...po,
      expectedTotal: "0.00",
      lines: [{ accountId: "81", amount: "0.00" }],
    };
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.purchaseOrderCreate, zero, s.propose())),
    ).toMatch(/more than zero/);
    // The same rule now holds for a new bill (decimal.js counts zero as positive).
    const { memo: _m, shipTo: _s, dueDate: _d, ...billLike } = zero;
    expect(
      await refusal(
        captureBefore(
          s.connector,
          QBO_TOOLS.billCreate,
          { ...billLike, vendorId: "58", docNumber: "Z-1" },
          s.propose(),
        ),
      ),
    ).toMatch(/more than zero/);
    expect(
      await refusal(
        captureBefore(
          s.connector,
          QBO_TOOLS.purchaseOrderCreate,
          { ...po, vendorId: "999" },
          s.propose(),
        ),
      ),
    ).toMatch(/isn't one of this company's vendors/);
    expect(
      await refusal(
        captureBefore(
          s.connector,
          QBO_TOOLS.purchaseOrderCreate,
          { ...po, lines: [{ ...po.lines[0], classId: OLD_SHOP }, po.lines[1]] },
          s.propose(),
        ),
      ),
    ).toMatch(/inactive/);
    expect(s.qbo.apiCalls("POST", "purchaseorder")).toHaveLength(0);
  });

  it("validates its input: item lines are qty × unit price, the expected date follows the order", async () => {
    const s = await setup();
    expect(
      await invalid(
        captureBefore(
          s.connector,
          QBO_TOOLS.purchaseOrderCreate,
          { ...po, lines: [{ itemId: "22", qty: "120", unitPrice: "8.75", amount: "1000.00" }] },
          s.propose(),
        ),
      ),
    ).toMatch(/not qty × unitPrice/);
    expect(
      await invalid(
        captureBefore(
          s.connector,
          QBO_TOOLS.purchaseOrderCreate,
          { ...po, dueDate: "2026-11-01" },
          s.propose(),
        ),
      ),
    ).toMatch(/expected date can't be before/);
  });

  it("without a number, QuickBooks' request id keeps a retry from writing twice", async () => {
    const s = await setup();
    const { docNumber: _n, ...unnumbered } = po;
    const first = await executeWrite(
      s.connector,
      QBO_TOOLS.purchaseOrderCreate,
      unnumbered,
      s.ctx("run-2:step-1:0"),
    );
    const retry = await executeWrite(
      s.connector,
      QBO_TOOLS.purchaseOrderCreate,
      unnumbered,
      s.ctx("run-2:step-1:0"),
    );
    expect((retry.output as { id: string }).id).toBe((first.output as { id: string }).id);
    // Another action is another order: no number, no duplicate to find.
    const second = await executeWrite(
      s.connector,
      QBO_TOOLS.purchaseOrderCreate,
      unnumbered,
      s.ctx("run-3:step-1:0"),
    );
    expect((second.output as { id: string }).id).not.toBe((first.output as { id: string }).id);
  });
});

describe("qbo.purchaseorder.query", () => {
  it("finds orders by status, vendor, number and date, with their lines' class and job", async () => {
    const s = await setup();
    const open = await s.read(QBO_TOOLS.purchaseOrderQuery, { status: "Open" });
    expect(open.purchaseOrders).toHaveLength(1);
    expect(open.purchaseOrders[0]).toMatchObject({
      id: "171",
      docNumber: "PO-1001",
      status: "Open",
      dueDate: "2026-11-16",
      vendor: { id: "57", name: "Cascade Hardwoods" },
      total: "1125.0000",
      lines: [
        {
          item: { id: "22", name: "White oak 4/4 FAS" },
          qty: "120.0000",
          unitPrice: "8.7500",
          class: { id: SHOP, name: "Shop" },
          customer: null,
        },
        { account: { id: "81", name: "Freight In" }, amount: "75.0000" },
      ],
    });
    const closed = await s.read(QBO_TOOLS.purchaseOrderQuery, { vendorId: "56" });
    expect(closed.purchaseOrders).toMatchObject([
      {
        id: "170",
        status: "Closed",
        memo: "Sheet goods for the Henderson kitchen",
        lines: [{ customer: { id: "7", name: "Henderson kitchen" }, billable: "Billable" }],
      },
    ]);
    const numbered = await s.read(QBO_TOOLS.purchaseOrderQuery, { docNumber: "PO-1000" });
    expect(numbered.purchaseOrders.map((p: { id: string }) => p.id)).toEqual(["170"]);
    const october = await s.read(QBO_TOOLS.purchaseOrderQuery, {
      from: "2026-10-01",
      to: "2026-11-30",
    });
    expect(october.purchaseOrders.map((p: { id: string }) => p.id)).toEqual(["171"]);
    expect(await invalid(s.read(QBO_TOOLS.purchaseOrderQuery, { status: "Pending" }))).toMatch(
      /Open|Closed/,
    );
  });
});

describe("the permission gate for the new tools", () => {
  const manifest = createQboConnector().manifest;
  const spec = (id: string) => {
    const t = manifest.tools.find((x) => x.id === id);
    if (!t) throw new Error(id);
    return t;
  };
  const decide = (
    id: string,
    matrix: PermissionMatrix,
    step?: "required" | "not_required",
    mode: "act" | "suggest_only" = "act",
  ) => {
    const t = spec(id);
    return decideToolCall({
      sideEffect: t.sideEffect,
      verb: t.verb,
      matrix,
      agentMode: mode,
      ...(step ? { stepApproval: step } : {}),
      entity: {
        tool: { id: t.id, ...(t.entity ? { entity: t.entity } : {}) },
        input: {},
        declared: manifest.permissionEntities,
      },
    });
  };
  const writes = [QBO_TOOLS.vendorCreate, QBO_TOOLS.purchaseOrderCreate];
  const reads = [QBO_TOOLS.accountQuery, QBO_TOOLS.classQuery, QBO_TOOLS.purchaseOrderQuery];

  it("names each tool's record type", () => {
    expect(
      [...writes, ...reads].map((id) => [id, spec(id).entity, spec(id).sideEffect, spec(id).verb]),
    ).toEqual([
      [QBO_TOOLS.vendorCreate, "vendor", "external", "create"],
      [QBO_TOOLS.purchaseOrderCreate, "purchase_order", "external", "create"],
      [QBO_TOOLS.accountQuery, "account", "none", "read"],
      [QBO_TOOLS.classQuery, "class", "none", "read"],
      [QBO_TOOLS.purchaseOrderQuery, "purchase_order", "none", "read"],
    ]);
    expect(spec(QBO_TOOLS.purchaseOrderCreate).amount).toEqual({
      path: "expectedTotal",
      currencyPath: "currency",
      currency: "USD",
    });
  });

  it("a write is proposed and waits, unless the matrix and the step both allow it on its own", () => {
    for (const id of writes) {
      expect(connectionLevel(manifest, spec(id), DEFAULT_PERMISSIONS)).toBe("approval");
      expect(decide(id, DEFAULT_PERMISSIONS)).toBe("approval");
      expect(decide(id, DEFAULT_PERMISSIONS, "not_required")).toBe("approval");
      const auto = { ...DEFAULT_PERMISSIONS, create: "auto" as const };
      expect(decide(id, auto)).toBe("approval");
      expect(decide(id, auto, "not_required", "suggest_only")).toBe("approval");
      expect(decide(id, auto, "not_required")).toBe("run");
    }
    for (const id of reads) expect(decide(id, DEFAULT_PERMISSIONS)).toBe("run");
  });

  it("decides per record type: vendors off leaves purchase orders, an entity's approval holds", () => {
    const auto: PermissionMatrix = { ...DEFAULT_PERMISSIONS, create: "auto" };
    const noVendors = { ...auto, entities: { vendor: { create: "off" as const } } };
    expect(decide(QBO_TOOLS.vendorCreate, noVendors, "not_required")).toBe("refused");
    expect(decide(QBO_TOOLS.purchaseOrderCreate, noVendors, "not_required")).toBe("run");
    expect(decide(QBO_TOOLS.billCreate, noVendors, "not_required")).toBe("run");
    const signedOrders = { ...auto, entities: { purchase_order: { create: "approval" as const } } };
    expect(decide(QBO_TOOLS.purchaseOrderCreate, signedOrders, "not_required")).toBe("approval");
    expect(decide(QBO_TOOLS.vendorCreate, signedOrders, "not_required")).toBe("run");
    const noChart = { ...DEFAULT_PERMISSIONS, entities: { account: { read: "off" as const } } };
    expect(decide(QBO_TOOLS.accountQuery, noChart)).toBe("refused");
    expect(decide(QBO_TOOLS.classQuery, noChart)).toBe("run");
  });

  it("the framework's last line refuses a write whose record type the client turned off", async () => {
    const s = await setup({ ...DEFAULT_PERMISSIONS, entities: { vendor: { create: "off" } } });
    await expect(
      executeWrite(s.connector, QBO_TOOLS.vendorCreate, { displayName: "New Co" }, s.ctx()),
    ).rejects.toMatchObject({ code: "permission_off" });
    expect(s.qbo.apiCalls("POST", "vendor")).toHaveLength(0);
    const r = await runReadTool(s.connector, QBO_TOOLS.classQuery, {}, s.ctx());
    expect((r.output as { classes: unknown[] }).classes).toHaveLength(3);
  });
});
