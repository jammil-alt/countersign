// The Bookkeeping area's record types (docs/step-model-plan.md §10f): bank and card transactions
// from the bank feed, on the table the area already owns. Find, Get by id and Update (custom
// fields only); the feed adds and changes the rest.

import { type RecordStore, RecordType } from "@countersign/core";
import { type Tx, tableRecordStore } from "@countersign/db";
import { bankTxn } from "./schema";

export const BANK_TRANSACTION_RECORD_TYPE: RecordType = RecordType.parse({
  id: "bank_transaction",
  name: "Bank transaction",
  plural: "Bank transactions",
  area: "bookkeeping",
  about: "One bank or card transaction from the bank feed, as booked or proposed.",
  fields: [
    { name: "txnDate", type: "date", required: true },
    {
      name: "amount",
      type: "money",
      required: true,
      about: "Always positive; direction says which way",
    },
    { name: "currency", type: "text", required: true },
    { name: "direction", type: "text", required: true, about: "in or out" },
    { name: "payee", type: "text", required: false },
    { name: "description", type: "text", required: false },
    { name: "bankCategory", type: "text", required: false },
    { name: "status", type: "text", required: true, about: "Where it is in booking" },
  ],
  operations: { update: true },
});

export const BOOKKEEPING_RECORD_TYPES: readonly RecordType[] = [BANK_TRANSACTION_RECORD_TYPE];

export const BOOKKEEPING_RECORD_STORES: readonly RecordStore<Tx>[] = [
  tableRecordStore({
    type: BANK_TRANSACTION_RECORD_TYPE,
    table: bankTxn,
    id: bankTxn.id,
    tenantId: bankTxn.tenantId,
    ext: bankTxn.ext,
    order: bankTxn.txnDate,
    columns: {
      txnDate: bankTxn.txnDate,
      amount: bankTxn.amount,
      currency: bankTxn.currency,
      direction: bankTxn.direction,
      payee: bankTxn.payee,
      description: bankTxn.description,
      bankCategory: bankTxn.bankCategory,
      status: bankTxn.status,
    },
  }),
];
