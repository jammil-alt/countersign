# Fixtures

| Folder | What |
|---|---|
| `invoices/` | Sample millwork invoices (`*.pdf`/`*.png`) with `*.expected.json` (the `InvoiceExtraction` we expect). Golden tests for M2. |
| `gmail/` | Recorded Gmail API responses (history, messages, attachments) for sync tests. Synthetic mail only. |
| `qbo/` | Sample QBO API payloads (Purchase, Bill, VendorCredit, Vendor, Item, Attachable, CDC response) for mapper tests. |
| `matching/` | Labeled line pairs (`same` / `different`) for the matcher golden test (M3; target ≥ 95% precision on `same`). |
| `llm/` | Recorded model responses for replay mode, keyed by request hash (created by `LLM_MODE=record`). |

Fixtures must not contain real client data. Invoices are synthetic or redacted.
