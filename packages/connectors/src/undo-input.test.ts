// R5 (docs/plan.md §1.86, §9): a write tool's own undo input (`undoInput`), for a reverse and for a
// restore whose before state isn't shaped like its input. Pure: the hooks get the stored write.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Connector, defineWriteTool, type UndoInputArgs } from "./connector";
import { createGsheetsConnector } from "./gsheets/index";
import { createHubspotConnector, HUBSPOT_TOOLS } from "./hubspot/index";
import { createQboConnector } from "./qbo/index";
import { LEDGER_WRITE_TOOLS } from "./qbo/ledger-writes";
import { QBO_TOOLS } from "./qbo/tool-kit";

function hook(connector: Connector, id: string) {
  const handler = connector.tools[id];
  if (handler?.kind !== "write" || !handler.undoInput) throw new Error(`${id} has no undoInput`);
  return handler.undoInput;
}

describe("defineWriteTool's undoInput", () => {
  const tool = (undoInput?: (args: { input: { id: string; n: number } }) => unknown) =>
    defineWriteTool({
      id: "t.thing.update",
      description: "x",
      verb: "update",
      undo: { kind: "restore" },
      input: z.object({ id: z.string(), n: z.number() }),
      output: z.object({ ok: z.boolean() }),
      beforeSchema: z.object({ n: z.number() }),
      before: async () => ({ n: 1 }),
      run: async () => ({ ok: true }),
      ...(undoInput ? { undoInput } : {}),
    }).handler;
  const args: UndoInputArgs = {
    input: { id: "a", n: 2 },
    before: { n: 1 },
    output: { ok: true },
    current: { n: 2 },
  };

  it("is absent unless the tool gives one", () => {
    const h = tool();
    expect(h.kind === "write" && h.undoInput).toBeFalsy();
  });

  it("gets the stored write parsed with the tool's own schemas", () => {
    const h = tool(({ input }) => ({ id: input.id, n: 1 }));
    expect(h.kind === "write" && h.undoInput?.(args)).toEqual({ id: "a", n: 1 });
  });

  it("says nothing when what was stored no longer parses", () => {
    const h = tool(() => ({ id: "a", n: 1 }));
    if (h.kind !== "write" || !h.undoInput) throw new Error("no hook");
    expect(h.undoInput({ ...args, input: { id: 3 } })).toBeNull();
    expect(h.undoInput({ ...args, output: { ok: "yes" } })).toBeNull();
    expect(h.undoInput({ ...args, current: { n: "2" } })).toBeNull();
  });
});

describe("QuickBooks", () => {
  const qbo = createQboConnector();

  const record = (over: Record<string, unknown> = {}) => ({
    id: "41",
    syncToken: "3",
    name: "Lumber",
    fullName: "Materials:Lumber",
    number: "5010",
    description: null,
    accountType: "Cost of Goods Sold",
    accountSubType: "SuppliesMaterialsCogs",
    parent: { id: "40", name: "Materials" },
    active: true,
    ...over,
  });

  it("reverses a new account, class or location by making it inactive at the version it made", () => {
    for (const id of [
      LEDGER_WRITE_TOOLS.accountCreate,
      LEDGER_WRITE_TOOLS.classCreate,
      LEDGER_WRITE_TOOLS.locationCreate,
    ]) {
      const input =
        id === LEDGER_WRITE_TOOLS.accountCreate
          ? { name: "Lumber", accountType: "Expense" }
          : { name: "Lumber" };
      expect(
        hook(
          qbo,
          id,
        )({
          input,
          before: { parent: null },
          output: {
            id: "41",
            syncToken: "0",
            name: "Lumber",
            fullName: "Lumber",
            alreadyDone: false,
          },
          current: { parent: null },
        }),
        id,
      ).toEqual({ id: "41", syncToken: "0", active: false });
    }
  });

  it("keeps bills, vendors and purchase orders final: nothing voids them", () => {
    for (const id of ["qbo.bill.create", "qbo.vendor.create", "qbo.purchaseorder.create"]) {
      const h = qbo.tools[id];
      expect(h?.kind === "write" && h.undoInput, id).toBeFalsy();
    }
  });

  it("puts back the fields a ledger update set, at the record's version now", () => {
    const before = { current: record(), newParent: { id: "40", name: "Materials" } };
    const now = {
      current: record({ syncToken: "4", name: "Timber", active: false, parent: null }),
      newParent: null,
    };
    expect(
      hook(
        qbo,
        LEDGER_WRITE_TOOLS.accountUpdate,
      )({
        input: { id: "41", syncToken: "3", name: "Timber", active: false, parentId: null },
        before,
        output: {
          id: "41",
          syncToken: "4",
          name: "Timber",
          fullName: "Timber",
          alreadyDone: false,
        },
        current: now,
      }),
    ).toEqual({ id: "41", syncToken: "4", name: "Lumber", active: true, parentId: "40" });
    // A field that had nothing to go back to: a person decides.
    expect(
      hook(
        qbo,
        LEDGER_WRITE_TOOLS.accountUpdate,
      )({
        input: { id: "41", syncToken: "3", accountSubType: "Other" },
        before: { current: record({ accountSubType: null }), newParent: null },
        output: {
          id: "41",
          syncToken: "4",
          name: "Lumber",
          fullName: "Lumber",
          alreadyDone: false,
        },
        current: { current: record({ syncToken: "4", accountSubType: "Other" }), newParent: null },
      }),
    ).toBeNull();
  });

  const line = (over: Record<string, unknown>) => ({
    id: "1",
    detailType: "account",
    description: null,
    amount: "100.00",
    account: { id: "80", name: "Materials" },
    item: null,
    qty: null,
    unitPrice: null,
    class: null,
    customer: null,
    billable: null,
    ...over,
  });
  const bill = (syncToken: string, lines: unknown[]) => ({
    entity: "Bill",
    id: "7",
    syncToken,
    docNumber: "B-7",
    txnDate: "2026-11-01",
    vendor: { id: "5", name: "Acme" },
    total: "130.00",
    currency: "USD",
    memo: null,
    paymentType: null,
    tax: null,
    lines,
  });

  it("puts an itemized bill's replaced lines back in place of the lines it added", () => {
    const freight = line({ id: "2", amount: "30.00", account: { id: "81", name: "Freight" } });
    const before = bill("2", [
      line({
        class: { id: "9", name: "Shop" },
        customer: { id: "3", name: "Job 3" },
        billable: "Billable",
      }),
      freight,
    ]);
    const now = bill("3", [
      freight,
      line({
        id: "3",
        detailType: "item",
        account: null,
        item: { id: "11", name: "Oak" },
        qty: "2",
        unitPrice: "40.00",
        amount: "80.00",
      }),
      line({
        id: "4",
        detailType: "item",
        account: null,
        item: { id: "12", name: "Pine" },
        qty: "1",
        unitPrice: "20.00",
        amount: "20.00",
      }),
    ]);
    const input = {
      id: "7",
      syncToken: "2",
      expectedTotal: "130.00",
      replaceLineIds: ["1"],
      lines: [
        { itemId: "11", qty: "2", unitPrice: "40.00", amount: "80.00" },
        { itemId: "12", qty: "1", unitPrice: "20.00", amount: "20.00" },
      ],
    };
    const out = {
      entity: "Bill",
      id: "7",
      syncToken: "3",
      total: "130.00",
      lineCount: 3,
      alreadyDone: false,
    };
    expect(
      hook(qbo, QBO_TOOLS.billUpdateLines)({ input, before, output: out, current: now }),
    ).toEqual({
      id: "7",
      syncToken: "3",
      expectedTotal: "130.00",
      currency: "USD",
      replaceLineIds: ["3", "4"],
      lines: [{ accountId: "80", amount: "100.00", classId: "9", customerId: "3", billable: true }],
    });
    // A line already billed to the customer can't be put back as it was.
    const billed = bill("2", [
      line({ customer: { id: "3", name: "Job 3" }, billable: "HasBeenBilled" }),
      freight,
    ]);
    expect(
      hook(qbo, QBO_TOOLS.billUpdateLines)({ input, before: billed, output: out, current: now }),
    ).toBeNull();
  });
});

describe("HubSpot and Google Sheets", () => {
  it("puts HubSpot properties back, guarded by the record's updatedAt now", () => {
    expect(
      hook(
        createHubspotConnector(),
        HUBSPOT_TOOLS.update,
      )({
        input: {
          objectType: "contacts",
          id: "501",
          properties: { lifecyclestage: "customer", phone: 5551234 },
          expectedUpdatedAt: "2026-11-01T00:00:00Z",
        },
        before: {
          id: "501",
          name: "Ana",
          updatedAt: "2026-11-01T00:00:00Z",
          properties: { lifecyclestage: "lead", phone: null },
        },
        output: {
          objectType: "contacts",
          id: "501",
          updatedAt: "2026-11-02T00:00:00Z",
          alreadyDone: false,
        },
        current: {
          id: "501",
          name: "Ana",
          updatedAt: "2026-11-02T00:00:00Z",
          properties: { lifecyclestage: "customer", phone: "5551234" },
        },
      }),
    ).toEqual({
      objectType: "contacts",
      id: "501",
      properties: { lifecyclestage: "lead", phone: null },
      expectedUpdatedAt: "2026-11-02T00:00:00Z",
    });
  });

  const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const sheets = createGsheetsConnector();
  const before = (values: unknown[][]) => ({
    spreadsheet: { id: SHEET, name: "Prices" },
    sheet: { id: 0, title: "Sheet1" },
    range: "B2:C3",
    values,
  });
  const input = {
    spreadsheetId: SHEET,
    range: "B2:C3",
    values: [
      ["12", null],
      [true, "x"],
    ],
  };
  const output = {
    spreadsheetId: SHEET,
    sheet: "Sheet1",
    range: "B2:C3",
    updatedCells: 3,
    alreadyDone: false,
  };

  it("puts the cells a Sheets update wrote back, keeping the ones it kept", () => {
    expect(
      hook(
        sheets,
        "sheets.range.update",
      )({
        input,
        before: before([
          ["10", "kept"],
          [false, null],
        ]),
        output,
        current: before([
          ["12", "kept"],
          [true, "x"],
        ]),
      }),
    ).toEqual({
      spreadsheetId: SHEET,
      sheet: "Sheet1",
      range: "B2:C3",
      values: [
        ["10", null],
        [false, ""],
      ],
    });
  });

  it("won't put a formula back as text", () => {
    expect(
      hook(
        sheets,
        "sheets.range.update",
      )({
        input,
        before: before([
          ["=A2*2", "kept"],
          [false, null],
        ]),
        output,
        current: before([
          ["12", "kept"],
          [true, "x"],
        ]),
      }),
    ).toBeNull();
  });
});
