# Stripe client: notes

Written 2026-11-04. Stripe's docs and API were not reachable from the build environment, so
everything here comes from what we knew of Stripe's API before. Nothing has been called live: the
tests use the fake in `fake.ts`. Everything marked **UNCHECKED** must be checked against
docs.stripe.com and a Stripe test-mode account before the first client is billed.

## Requests

| Fact | Status |
|---|---|
| Base URL `https://api.stripe.com`, `Authorization: Bearer <secret key>` | Known |
| POST bodies are `application/x-www-form-urlencoded` with bracketed nested keys (`items[0][price]`, `metadata[tenant_id]`, `payload[value]`) | Known |
| `Idempotency-Key` header on POSTs; a repeat with the same key and params replays the first answer; keys are kept about 24 hours | Known; **UNCHECKED**: the exact retention window |
| Errors: non-2xx with `{"error": {"type", "code", "message"}}` | Known |
| No `Stripe-Version` header is sent unless `apiVersion` is set, so the account's default API version applies | Decision. **UNCHECKED**: pin the account's version (or set `apiVersion`) to one that has billing meters, and recheck the shapes below against it |

## Endpoints used

| Use | Endpoint | Status |
|---|---|---|
| Create customer | `POST /v1/customers` with `name`, `email`, `metadata[tenant_id]` → `{id: "cus_…"}` | Known |
| Update customer | `POST /v1/customers/{id}` with `name`, `email` | Known |
| Read a price | `GET /v1/prices/{id}` → `currency`, `unit_amount` (integer, minor units), `unit_amount_decimal` (string, minor units, may have decimals), `recurring.interval`, `recurring.usage_type` (`licensed`/`metered`), `recurring.meter` | Known; **UNCHECKED**: `recurring.meter` as the field naming a metered price's meter |
| Create subscription | `POST /v1/subscriptions` with `customer`, `items[0][price]` + `items[0][quantity]` (base), `items[1][price]` (metered, no quantity), `billing_cycle_anchor` (Unix seconds, 1st of next month UTC), `proration_behavior=create_prorations`, `collection_method=send_invoice`, `days_until_due`, `metadata[tenant_id]` → `{id: "sub_…", status, items.data[{id: "si_…", quantity, price.id}]}` | Known; **UNCHECKED**: that a metered item must be sent without `quantity` (the fake refuses one); the first, prorated invoice for the part-month up to the anchor |
| Change the agent count | `POST /v1/subscription_items/{id}` with `quantity`, `proration_behavior=create_prorations` | Known; **UNCHECKED**: quantity `0` (a client with no active agent) is accepted for a licensed item |
| Report usage | `POST /v1/billing/meter_events` with `event_name`, `payload[stripe_customer_id]`, `payload[value]` (a whole number, as a string), `identifier`, `timestamp` (Unix seconds) → `{object: "billing.meter_event", identifier, …}` | **UNCHECKED** (billing meters, 2024+): the path, the payload keys (they are the meter's configured `customer_mapping` and `value_settings` keys; the defaults are assumed), that `identifier` deduplicates within a rolling window (assumed at least 24 hours), the answer to a duplicate identifier (the fake answers 400 `resource_already_exists`; we also send the identifier as the Idempotency-Key so a retry replays instead), how far back `timestamp` may be (assumed 35 days) and how late usage for a period that has just ended is still invoiced in that period (assumed: a grace period of about an hour after the period ends) |
| List invoices | `GET /v1/invoices?customer=…&limit=…` → `{data: [invoice], has_more}` | Known |
| Get an invoice | `GET /v1/invoices/{id}` | Known |
| Invoice fields read | `id`, `number`, `status` (`draft`/`open`/`paid`/`uncollectible`/`void`), `currency`, `total`, `amount_due`, `amount_paid`, `created`, `period_start`, `period_end`, `due_date`, `hosted_invoice_url`, `invoice_pdf` | Known; **UNCHECKED**: `period_start`/`period_end` on a subscription invoice are the usage period (on recent API versions the line items carry the service periods) |

Amounts are integers in the currency's smallest unit; zero-decimal currencies (`jpy`, `krw`, …, the
list in `client.ts`) are whole units. **UNCHECKED**: the list is complete. We only price in USD for
now.

## Webhooks

| Fact | Status |
|---|---|
| Header `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=…][,v0=…]` | Known |
| `v1` = HMAC-SHA256 (hex) of `<t>.<raw body>` under the endpoint's signing secret (`whsec_…`, used as is, not base64-decoded) | Known |
| Tolerance: Stripe's libraries default to 300 seconds; we also refuse timestamps more than 300 seconds in the future | Known / decision |
| Several `v1` while a secret is being rolled; any one matching is enough | Known |
| Event body: `{id: "evt_…", object: "event", type, created, livemode, data: {object}}` | Known |
| Stripe retries a delivery that doesn't get a 2xx, for up to about three days; events can arrive out of order | Known; we store each event id once and apply subscription changes only when newer than the last applied |
| Events handled: `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` | Known names. **UNCHECKED**: whether to also listen to `invoice.finalized` or `invoice.overdue` for send-invoice collection |
| `data.object.customer` is the customer id (a string, not expanded) on invoices and subscriptions | Known |

## Setting up Stripe (morning)

1. In the Stripe dashboard (test mode first): create a **billing meter** for credits, event name
   `mezonas_credits` (or change the setting), aggregation **sum**, customer mapping key
   `stripe_customer_id`, value key `value`.
2. Create a product "Mezonas agent" with a **monthly licensed price** (the base fee per active agent).
3. Create a product "Mezonas credits" with a **monthly metered price** on that meter (the price per
   overage credit; fractions of a cent need `unit_amount_decimal`).
4. Add a webhook endpoint `https://<host>/api/billing/stripe/webhook` for the four events above and
   copy its signing secret.
5. `wrangler secret put STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (per environment;
   docs/operations.md), allow `api.stripe.com` in the Worker's network if it is restricted, then save
   the two price ids in `/ops/billing`.
