# Stripe client: notes

Rewritten 2026-11-05 for `docs/plan.md` §1.32: Mezonas works out each bill, and Stripe only holds
customers and invoices. It sends each invoice, takes payment and tells us the outcome. There are no
products, prices, subscriptions or meters. Stripe's docs were not reachable from the build
environment (docs.stripe.com did not resolve on 2026-11-04 or 2026-11-05), so everything here comes
from what we knew of Stripe's API before. Nothing has been called live; the tests use the fake in
`fake.ts`. Check everything marked **UNCHECKED** against docs.stripe.com and a test-mode account
before the first client is billed.

## Requests

| Fact | Status |
|---|---|
| Base URL `https://api.stripe.com`, `Authorization: Bearer <secret key>` | Known |
| POST bodies are `application/x-www-form-urlencoded` with bracketed nested keys (`metadata[tenant_id]`, `period[start]`) | Known |
| `Idempotency-Key` header on POSTs. A repeat with the same key and the same params replays the first answer, and a repeat with different params is an error. Keys are kept about 24 hours | Known; **UNCHECKED**: the exact retention window |
| Errors are non-2xx with `{"error": {"type", "code", "message"}}` | Known |
| No `Stripe-Version` header is sent unless `apiVersion` is set, so the account's default API version applies | Decision. **UNCHECKED**: pin the account's version and recheck the shapes below against it |

Our idempotency keys: `mezonas-customer-<tenant id>` for the customer, then
`mezonas:<statement id>:invoice`, `mezonas:<statement id>:item:<line id>`,
`mezonas:<statement id>:finalize` and `mezonas:<statement id>:send`. Each Stripe id is stored as soon
as it comes back, so a send that stops part-way resumes at the first step not done. Within the
key's lifetime, a retry replays the same answer.

## Endpoints used

| Use | Endpoint | Status |
|---|---|---|
| Create customer | `POST /v1/customers` with `name`, `email`, `metadata[tenant_id]` → `{id: "cus_…"}` | Known |
| Update customer | `POST /v1/customers/{id}` with `name`, `email` | Known |
| Create a draft invoice | `POST /v1/invoices` with `customer`, `collection_method=send_invoice`, `days_until_due`, `auto_advance=false`, `pending_invoice_items_behavior=exclude`, `currency=usd`, `description`, `metadata[statement_id]`, `metadata[tenant_id]` → `{id: "in_…", status: "draft"}` | Known; **UNCHECKED**: that `pending_invoice_items_behavior=exclude` keeps out pending items not created with `invoice=<id>` (it became the default on newer API versions); that `currency` is accepted for a customer with no currency yet |
| Add an invoice item | `POST /v1/invoiceitems` with `customer`, `invoice`, `amount` (integer cents, may be negative), `currency`, `description`, `period[start]`, `period[end]` (Unix seconds), `metadata[statement_id]`, `metadata[line_id]` → `{id: "ii_…"}` | Known; **UNCHECKED**: negative `amount` for an adjustment (a credit line) on a send-invoice invoice; `period` shown on the invoice. Zero-amount lines are not sent (decision), so Stripe's handling of them doesn't matter |
| Finalize | `POST /v1/invoices/{id}/finalize` with `auto_advance=false` → `{status: "open", number, hosted_invoice_url, invoice_pdf, due_date}` | Known; **UNCHECKED**: that `hosted_invoice_url` and `invoice_pdf` are set on the finalize answer (we also take them from `invoice.finalized`) |
| Send | `POST /v1/invoices/{id}/send` → the invoice | Known; **UNCHECKED**: that the customer must have an email for Stripe to send it (we let the operator set one at set-up), and that sending in test mode emails nobody |
| Get an invoice | `GET /v1/invoices/{id}` | Known |
| Invoice fields read | `id`, `number`, `status` (`draft`/`open`/`paid`/`uncollectible`/`void`), `currency`, `total`, `amount_due`, `due_date`, `hosted_invoice_url`, `invoice_pdf`, `metadata` | Known |

Amounts are integers in the currency's smallest unit. We price in USD only, so an amount is the
statement line's dollars × 100, which is exact because lines are rounded to cents. Zero-decimal
currencies (`jpy`, `krw`, …, the list in `client.ts`) are whole units. **UNCHECKED**: that list is
complete.

No longer used (§1.24, superseded): prices (`GET /v1/prices`), subscriptions and subscription items,
and billing meter events.

## Webhooks

| Fact | Status |
|---|---|
| Header `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=…][,v0=…]` | Known |
| `v1` = HMAC-SHA256 (hex) of `<t>.<raw body>` under the endpoint's signing secret (`whsec_…`, used as is, not base64-decoded) | Known |
| Tolerance: Stripe's libraries default to 300 seconds; we also refuse timestamps more than 300 seconds in the future | Known / decision |
| Several `v1` while a secret is being rolled; any one matching is enough | Known |
| Event body: `{id: "evt_…", object: "event", type, created, livemode, data: {object}}` | Known |
| Stripe retries a delivery that doesn't get a 2xx for up to about three days, and events can arrive out of order | Known. We store each event id once, apply an event only when it is newer than the last one applied to the statement, and never let a failure undo `paid` |
| Events handled: `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible` | Known names. **UNCHECKED**: that `invoice.payment_failed` fires for send-invoice collection when a payment on the hosted page fails (it may only fire for automatic charges). Uncollectible maps to `payment_failed` (decision) |
| `data.object.customer` is the customer id (a string, not expanded); `data.object.metadata` carries what we set on the invoice | Known |
| Every other event (including the old `customer.subscription.*`) is acknowledged and dropped | Decision |
