# Ramp connector: notes

Written 2026-11-06 (stream W3-B) without network access to Ramp's developer docs
(`docs.ramp.com/developer-api`) or a Ramp account. Everything below comes from what we know of
Ramp's public developer API and is **UNCHECKED** until the owner's Ramp developer app exists and a
real (or Ramp's demo) business is connected. The fake (`./fake.ts`) answers in the shapes listed
here, so a fact that turns out wrong is fixed in three places: this file, `./index.ts` and the fake.

## OAuth 2.0 (authorization code)

| Fact | Status |
|---|---|
| Authorize at `https://app.ramp.com/v1/authorize?response_type=code&client_id&redirect_uri&scope&state`, scopes space-separated | **UNCHECKED** |
| Code exchange: `POST https://api.ramp.com/developer/v1/token`, form-encoded `grant_type=authorization_code`, `code`, `redirect_uri`, with HTTP Basic auth (`client_id:client_secret`) | **UNCHECKED** (Basic auth rather than the client in the body) |
| Answer: `access_token`, `refresh_token`, `expires_in` (seconds, about 10 days), `scope`, `token_type` | **UNCHECKED**: whether a refresh token always comes (some apps must ask for it, e.g. an `offline_access`-like scope). Without one the connection signs in again when the access token expires (the connector accepts a grant without one) |
| Refresh: same endpoint, `grant_type=refresh_token`; 400 `invalid_grant` when gone | **UNCHECKED**; whether refresh tokens rotate (we keep whichever comes back) |
| Revoke: `POST /developer/v1/token/revoke` with `token`, Basic auth | **UNCHECKED** |
| Scopes asked: `transactions:read`, `users:read`, `receipts:write`, `business:read` | **UNCHECKED** names; check that `receipts:write` is enough to upload (no `receipts:read` needed) |
| Demo environment: `demo.ramp.com` / `demo-api.ramp.com` with its own apps | **UNCHECKED**; not wired (only production hosts). A `RAMP_ENV` like `QBO_ENV` is the follow-up if the owner tests on demo first |

## API used

All under `https://api.ramp.com/developer/v1`, `Authorization: Bearer <access token>`.

| Use | Endpoint | Status |
|---|---|---|
| Sign-in: which business | `GET /business` → `id`, `business_name_legal`, `business_name_on_card` | **UNCHECKED** |
| `ramp.transaction.query` | `GET /transactions?from_date&to_date&user_id&card_id&state&page_size&start` → `{data, page: {next}}` | **UNCHECKED**: parameter names, `from_date` taking a full ISO time, the states' names, the order (we assume newest first) |
| Paging | `page.next` is a full URL whose `start` is the next page's cursor | **UNCHECKED**. We read `start` from it only when its origin is `https://api.ramp.com`, and never fetch it |
| Transaction fields | `id`, `amount` (JSON number, major units), `currency_code`, `merchant_name`, `user_transaction_time`, `settlement_date`, `state`, `card_id`, `card_holder {user_id, first_name, last_name, department_name}`, `memo`, `sk_category_name`, `receipts` (ids) | **UNCHECKED**: above all whether `amount` is major units (dollars) or minor units (cents), and whether it is a number or an object. Amounts are read through text into decimals (`dec(String(n))`), never kept as floats |
| Missing receipt | filtered on our side from `receipts` being empty | We don't send a "has no receipt" parameter we couldn't check |
| One transaction (before state, cardholder) | `GET /transactions/{id}` | **UNCHECKED** |
| `ramp.user.query` | `GET /users?email&department_id&page_size&start` → `id`, `first_name`, `last_name`, `email`, `role`, `status`, `department_id` | **UNCHECKED** (`email` filter) |
| `ramp.receipt.upload` | `POST /receipts`, `multipart/form-data`: `idempotency_key`, `transaction_id`, `user_id`, `receipt` (the file) → `{id, …}` | **UNCHECKED**: the field names, that `user_id` is required (we send the cardholder's), the accepted file types (we send PDF, PNG, JPEG, HEIC) and size (we refuse above 25 MB) |
| Errors | JSON `{error_v2: {error_code, message}}` (or `{error}`, `{message}`); 401 expired token; 404; 429 rate limit | **UNCHECKED** shapes. 429 and 5xx are retryable |

## Ids

Ramp's ids look like UUIDs. Tool inputs that go into a URL path are checked as UUID-shaped
(`z.guid()`), so nothing else reaches a path. **UNCHECKED** that every id is.

## Idempotency

The receipt upload sends `idempotency_key` = `mezonas-` + 48 hex characters of
sha256(`ramp:<external action key>`), so the same action always sends the same key and a retry after
a lost answer gets the first receipt back. **UNCHECKED**: that Ramp honours the key on this endpoint,
for how long, and its length limit (ours is 56 characters).

## Rate limits

**UNCHECKED** (we believe a few hundred requests a minute per app). The poll reads at most 10 pages
of 100 per connection every 15 minutes.

## The poll (`ramp.transaction.created`)

ARCHITECTURE §6.11: "event `ramp.transaction.created` from a poll every 15 minutes". Ramp also has
webhooks; we poll because it needs no public endpoint or signing secret from the owner. Each read
covers the last read's start minus 3 days (card purchases reach Ramp late), stores each transaction
once as a raw record (`entity_type = 'Transaction'`, version null) and emits the event for those it
stored. The first read of a new connection emits nothing. A transaction's later changes (pending to
cleared, a receipt added) are not events in v1.
