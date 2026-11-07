-- QuickBooks sync (docs/plan.md M9, §1.30): a synced transaction's lines are a copy of the lines it
-- has in the client's tool now. When QuickBooks changes them (an itemized bill: one account line
-- becomes the invoice's item lines), sync replaces the copy, so the runtime may delete
-- `transaction_line` rows. Only those: transactions, documents and vendors are still never deleted,
-- and the history of every version stays in raw_record, which is insert-only (invariant 3).
-- Row-level security already covers DELETE (0004's policies are FOR ALL), so a client's lines can be
-- deleted only inside that client's scope. Additive only: the previous Worker never deletes lines.
GRANT DELETE ON transaction_line TO cs_runtime;
