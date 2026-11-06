# QuickBooks Online fixtures

Synthetic QBO API v3 answers for the `qbo` connector's tests and its fake (`packages/connectors/src/qbo/fake.ts`).
The company, vendors, items and amounts are made up. Shapes follow what we know of QBO's JSON
(`packages/connectors/src/qbo/NOTES.md` lists what still needs checking against the live sandbox).

| File | What |
|---|---|
| `query-*.json` | `GET /v3/company/{realm}/query` answers for Bill, Purchase, VendorCredit, Vendor, Item, Attachable. The fake starts from these records. |
| `query-customer.json`, `query-invoice.json`, `query-payment.json` | Accounts receivable (v0.12): three customers; invoices open, paid (by payment 501), current, overdue, voided, and one older than 365 days; a payment applied to an invoice. |
| `query-account.json` | Two expense accounts, so approval cards name the accounts new lines use. |
| `report-aged-receivable-detail.json` | `GET /v3/company/{realm}/reports/AgedReceivableDetail`: open invoices by how far past due, and a credit memo. The fake builds the same shape from its invoices. |
| `company-info.json` | `GET /v3/company/{realm}/companyinfo/{realm}` (the company's name on the connection). |
| `cdc.json` | `GET /v3/company/{realm}/cdc`: a new bill, a deleted purchase, a new attachment. |
| `token-*.json` | Intuit's token endpoint: authorization code, refresh (a new refresh token), `invalid_grant`. |
| `fault-*.json` | Errors: stale `SyncToken` (5010), expired token (401), throttled (429). |
| `webhook-*.json` | Webhook bodies: the classic `eventNotifications` shape and the CloudEvents shape. |
