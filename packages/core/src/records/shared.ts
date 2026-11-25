// The shared business records' record types (ARCHITECTURE §5.2; step model §10f): the platform's
// own tables every area builds on, declared here as an area declares its own on its manifest.
// apps/api gives each its store.

import { RecordType } from "./record-type";

/** A business the client buys from, as the sync and the documents keep it. */
export const VENDOR_RECORD_TYPE: RecordType = RecordType.parse({
  id: "vendor",
  name: "Vendor",
  plural: "Vendors",
  area: "shared",
  about: "A business the client buys from, kept in sync with the accounting system.",
  fields: [
    { name: "name", type: "text", required: true, about: "The vendor's name" },
    { name: "createdAt", type: "date", required: true, about: "When we first kept it" },
    // The owner's call on the Bill clerk (2026-11-25): a Match on Vendors, then Get by id, gives the
    // vendor's id in the client's accounting system for Accounting › Create bill.
    {
      name: "externalRefs",
      type: "group",
      required: true,
      about: "The vendor's id in each connected tool, by connector",
      of: [
        { name: "qbo", type: "text", required: false, about: "Its QuickBooks vendor id" },
        { name: "billcom", type: "text", required: false, about: "Its BILL vendor id" },
        { name: "odoo", type: "text", required: false, about: "Its Odoo partner id" },
      ],
    },
  ],
  keys: ["name"],
  // DECISION (§10d: "our records have no add-a-vendor action"): a vendor is added by the sync or
  // when an invoice makes its purchase, so Create stays off; Update sets custom fields only.
  operations: { update: true },
});

/** A purchase, bill or vendor credit, from the accounting system or an upload. */
export const TRANSACTION_RECORD_TYPE: RecordType = RecordType.parse({
  id: "transaction",
  name: "Transaction",
  plural: "Transactions",
  area: "shared",
  about: "A purchase, bill or vendor credit from the accounting system or an upload.",
  fields: [
    { name: "kind", type: "text", required: true, about: "purchase, bill or vendor_credit" },
    { name: "vendorId", type: "record", record: "vendor", required: false },
    { name: "txnDate", type: "date", required: false },
    { name: "total", type: "money", required: true },
    { name: "currency", type: "text", required: true },
    { name: "memo", type: "text", required: false },
    { name: "status", type: "text", required: true, about: "Whether its documents are found" },
  ],
  links: [{ name: "vendor", to: "vendor", field: "vendorId" }],
  // Synced and linked by the platform's own code; custom fields only.
  operations: { update: true },
});

export const SHARED_RECORD_TYPES: readonly RecordType[] = [
  VENDOR_RECORD_TYPE,
  TRANSACTION_RECORD_TYPE,
];
