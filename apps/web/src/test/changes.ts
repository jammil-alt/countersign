// An external action as the API sends it, for the approval-card tests: the Bill clerk itemizing
// QuickBooks bill 20418 from Northline Panel Supply (its one account line becomes the invoice's two
// item lines; the total stays $9,742.35). The display mirrors what the qbo connector declares for
// `qbo.bill.update_lines` (packages/connectors/src/qbo/display.ts); the web never imports a
// connector, so the tests carry their own copy.
import type { ChangeDisplayView, ToolDisplay } from "@countersign/core";
import type { InboxCardItem } from "../inbox/InboxCard";

export const BILL_LINES_DISPLAY: ToolDisplay = {
  name: { en: "QuickBooks bill", es: "Factura de QuickBooks" },
  description: {
    en: "Replace the bill's lines with the items on the vendor's invoice. The total stays the same.",
    es: "Cambia las líneas de la factura por los artículos de la factura del proveedor. El total no cambia.",
  },
  number: "before.docNumber",
  subject: "before.vendor",
  names: "before.names",
  fields: [
    { label: { en: "Date", es: "Fecha" }, kind: "date", now: "before.txnDate" },
    {
      label: { en: "Lines", es: "Líneas" },
      kind: "lines",
      now: "before.lines",
      after: "input.lines",
      adds: true,
      removes: "input.replaceLineIds",
      currencyPath: "before.currency",
      columns: {
        id: "id",
        description: "description",
        qty: "qty",
        unitPrice: "unitPrice",
        amount: "amount",
        refs: [
          { key: "item" },
          { key: "account" },
          { key: "itemId", names: "items" },
          { key: "accountId", names: "accounts" },
        ],
      },
    },
    {
      label: { en: "Total", es: "Total" },
      kind: "money",
      now: "before.total",
      currencyPath: "before.currency",
    },
  ],
};

export const BILL_LINES_VIEW: ChangeDisplayView = {
  connectorName: "QuickBooks Online",
  tool: BILL_LINES_DISPLAY,
};

export const BILL_BEFORE = {
  entity: "Bill",
  id: "146",
  syncToken: "3",
  docNumber: "20418",
  txnDate: "2026-10-28",
  vendor: { id: "58", name: "Northline Panel Supply" },
  total: "9742.3500",
  currency: "USD",
  memo: null,
  paymentType: null,
  tax: null,
  lines: [
    {
      id: "1",
      detailType: "account",
      description: "Northline invoice 20418",
      amount: "9742.35",
      account: { id: "20", name: "Job Materials" },
      item: null,
      qty: null,
      unitPrice: null,
    },
  ],
  names: {
    items: { "31": "Baltic birch 3/4 4x8", "32": "Edgebanding oak 7/8" },
    accounts: { "20": "Job Materials" },
  },
};

export const BILL_INPUT = {
  id: "146",
  syncToken: "3",
  expectedTotal: "9742.35",
  currency: "USD",
  replaceLineIds: ["1"],
  lines: [
    {
      itemId: "31",
      description: "Baltic birch 3/4 4x8 B/BB",
      qty: "60",
      unitPrice: "142.5000",
      amount: "8550.00",
    },
    {
      itemId: "32",
      description: "Edgebanding oak 7/8 x 500'",
      qty: "4",
      unitPrice: "298.0875",
      amount: "1192.35",
    },
  ],
};

export const BILL_ITEM: InboxCardItem = {
  id: "00000000-0000-4000-8000-0000000f0101",
  kind: "external_action",
  title:
    "Itemize a QuickBooks bill: replace lines (usually its one account line) with the invoice's item lines. The total must stay the same, or the change is refused. (qbo.bill.update_lines)",
  payload: {
    tool: "qbo.bill.update_lines",
    verb: "update",
    connector: "qbo",
    connectionId: "00000000-0000-4000-8000-0000000c0001",
    input: BILL_INPUT,
    before: BILL_BEFORE,
    stepId: "itemize",
    onReject: "stop",
    actionId: "00000000-0000-4000-8000-0000000ac001",
  },
  display: BILL_LINES_VIEW,
  status: "open",
  runId: "00000000-0000-4000-8000-0000000f0102",
  dueAt: null,
  createdAt: "2026-11-06T10:00:00.000Z",
  resolvedAt: null,
};
