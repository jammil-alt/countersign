// @countersign/pack-bookkeeping: the Bookkeeping area (docs/plan.md §1.79). Bank and card
// transactions from the bank feed, matched with the client's accounting tool, ruled or categorized
// against its chart of accounts, and booked after approval. apps/api registers it.
// May import core, db, llm, senses, documents, connectors; never agents or workflows.

export * from "./accounts";
export {
  ACCOUNT_QUESTIONS,
  BOOKINGS_REVIEW,
  BOOKKEEPING_ACTIONS,
  BOOKKEEPING_NIGHTLY,
  BOOKKEEPING_REPORTS,
  BOOKKEEPING_REVIEWS,
  txnView,
} from "./api";
export * from "./bookings";
// §1.232: the Close pack, beside the Bookkeeping pack (its own manifest, id `close`).
export { CLOSE_REPORTS, CLOSE_REVIEW, CLOSE_REVIEWS } from "./close/api";
export { CLOSE_CONFIG_DEFAULTS, CLOSE_CONFIG_FIELDS } from "./close/config";
export * from "./close/engine";
export { CLOSE_PACK_ID } from "./close/ids";
export { CLOSE_HANDLERS, CLOSE_SKILLS, closeManifest } from "./close/manifest";
export * from "./close/schema";
export {
  type CheckOutput,
  checkClose,
  closeConfig,
  closeList,
  closeView,
  decideClose,
  entryReference,
  entryWritten,
  JOURNAL_CREATE_TOOL,
  moneyWords,
  proposeEntry,
  readyEntries,
  settleEntries,
} from "./close/store";
export { MONTH_END_CLOSE_SLUG, MONTH_END_CLOSE_TEMPLATE } from "./close/template";
export { CLOSE_TOOLS } from "./close/tools";
export { type ImportResult, importFeeds } from "./feed";
export { PACK_ID } from "./ids";
export { BOOKKEEPING_HANDLERS, BOOKKEEPING_SKILLS, bookkeepingManifest } from "./manifest";
export * from "./pack";
export { payeeKey } from "./payee";
export { bookingReference, POSTING_TOOLS, qboInput, txnReference } from "./posting";
export { RECONCILE_REPORTS, RECONCILE_REVIEWS, RECONCILIATION_REVIEW } from "./reconcile/api";
export * from "./reconcile/engine";
export { RECONCILE_SKILLS } from "./reconcile/skills";
export {
  decideReconciliation,
  monthPeriod,
  type ReconcileOutput,
  reconciliationView,
  runReconciliation,
} from "./reconcile/store";
export { bankPairKey, RECONCILE_TOOLS } from "./reconcile/tools";
// Step model §10f: the area's record types and their stores.
export {
  BANK_TRANSACTION_RECORD_TYPE,
  BOOKKEEPING_RECORD_STORES,
  BOOKKEEPING_RECORD_TYPES,
} from "./records";
export * from "./schema";
export * from "./splits";
export { BOOKKEEPER_SLUG, BOOKKEEPER_TEMPLATE } from "./template";
export { BOOKKEEPING_TOOLS, thresholdFrom } from "./tools";
