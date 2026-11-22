# Fixtures

| Folder | What |
|---|---|
| `invoices/` | Sample millwork invoices (`*.pdf`/`*.png`) with `*.expected.json` (the `InvoiceExtraction` we expect). Golden tests for M2. |
| `gmail/` | Recorded Gmail API responses (history, messages, attachments) for sync tests. Synthetic mail only. |
| `qbo/` | Sample QBO API payloads (Purchase, Bill, VendorCredit, Vendor, Item, Attachable, CDC response) for mapper tests. |
| `zoho_crm/` | Synthetic Zoho OAuth and CRM API v8 answers (token, org, search, get, writes, errors), served by a fake `fetch` in tests. |
| `podio/` | Synthetic Podio OAuth and API answers (orgs, apps with fields, items, writes, errors), served by a fake `fetch` in tests. |
| `matching/` | Labeled line pairs (`same` / `different`, a note each) for the matcher golden test (M8, `packs/materials/src/catalog/golden.test.ts`; target ≥ 95% precision on `same` at the auto threshold). Labels are a buyer's truth, not what the parser can prove. |
| `matching/crm/` | A client's synced Zoho leads, contacts, accounts and deals with spreadsheet rows labelled with the record each is (or none), for the Sales area's golden test (`packs/sales/src/match/golden.test.ts`; ≥ 95% precision on `same` at the default threshold). |
| `evals/` | The golden datasets (docs/plan.md §1.212): per template workflow, cases of a trigger, a synthetic world and the writes the run makes, written by `evals/generate.mjs`. Replayed in CI by `apps/api/src/evals/golden.test.ts`. |
| `llm/` | Recorded model responses for replay mode, keyed by request hash (created by `LLM_MODE=record`). |

Fixtures must not contain real client data. Invoices are synthetic or redacted.
