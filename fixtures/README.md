# Fixtures

| Folder | What |
|---|---|
| `invoices/` | Sample millwork invoices (`*.pdf`/`*.png`) with `*.expected.json` (the `InvoiceExtraction` we expect). Golden tests for M2. |
| `gmail/` | Recorded Gmail API responses (history, messages, attachments) for sync tests. Synthetic mail only. |
| `qbo/` | Sample QBO API payloads (Purchase, Bill, VendorCredit, Vendor, Item, Attachable, CDC response) for mapper tests. |
| `zoho_crm/` | Synthetic Zoho OAuth and CRM API v8 answers (token, org, search, get, writes, errors), served by a fake `fetch` in tests. |
| `podio/` | Synthetic Podio OAuth and API answers (orgs, apps with fields, items, writes, errors), served by a fake `fetch` in tests. |
| `matching/` | Labeled line pairs (`same` / `different`, a note each) for the matcher golden test (M8, `packs/materials/src/catalog/golden.test.ts`; target ≥ 95% precision on `same` at the auto threshold). Labels are a buyer's truth, not what the parser can prove. |
| `llm/` | Recorded model responses for replay mode, keyed by request hash (created by `LLM_MODE=record`). |

Fixtures must not contain real client data. Invoices are synthetic or redacted.
