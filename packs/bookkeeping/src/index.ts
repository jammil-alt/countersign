// @countersign/pack-bookkeeping: the Bookkeeping area (docs/plan.md §1.79). Bank and card
// transactions from the bank feed, matched with the client's accounting tool, ruled or categorized
// against its chart of accounts, and booked after approval. apps/api registers it.
// May import core, db, llm, senses, documents, connectors; never agents or workflows.

export * from "./schema";
