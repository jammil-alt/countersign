# Plaid: facts to verify live

The `bankfeed` connector was built against a fake Plaid (`fake.ts`), from what we know of Plaid's
API without checking its docs or a sandbox. Check each item below in Plaid's sandbox before a
client connects a real bank, and fix the connector, the fake and this file together.

## Keys and environments

- `PLAID_CLIENT_ID` is the same in every environment; `PLAID_SECRET` differs per environment.
  `PLAID_ENV` is `sandbox` or `production` (`https://sandbox.plaid.com`,
  `https://production.plaid.com`). Plaid retired its Development environment; confirm nothing
  else is needed for limited production access.
- The client id and secret are sent in the `PLAID-CLIENT-ID` and `PLAID-SECRET` headers (not in
  the JSON body), with `Plaid-Version: 2020-09-14`. Confirm Plaid accepts the headers on every
  endpoint we call.

## Link

- `/link/token/create` with `products: ["transactions"]`, `country_codes: ["US"]`, `language`
  (`en` or `es`), `user.client_user_id` (a SHA-256-derived hex string, no email), `webhook`,
  `redirect_uri` and `transactions.days_requested: 90`. Check:
  - which Link languages Plaid supports for US institutions (we send only `en` and `es`);
  - that `redirect_uri` must be registered in the dashboard and must be `https` (except localhost
    in sandbox), and that a link token without it still works for non-OAuth banks;
  - that `days_requested` is accepted at 90 and how it affects billing.
- Update mode: the same request with `access_token` and **without** `products`. Confirm Plaid
  refuses `products` in update mode, and that Link's `onSuccess` in update mode gives a public
  token we may ignore (the access token stays the same).
- OAuth banks: Link sends the browser to the redirect URI with `oauth_state_id`; the page opens
  Link again with the same token and `receivedRedirectUri`. Check with sandbox's OAuth
  institution ("Platypus OAuth Bank"). The token is kept in the tab's `sessionStorage`.
- Our signed state lives 10 minutes (`OAUTH_STATE_TTL_MS`). A slow OAuth bank may take longer;
  if so, the callback fails with `expired` and the client starts again.
- Link tokens expire after about 4 hours (`expiration`).

## Items, accounts and products

- `/item/public_token/exchange` answers `access_token` and `item_id`. Access tokens don't expire.
- `/item/get` answers `item.products`, `item.billed_products`, `item.institution_id`, `item.error`.
  We refuse (and remove) an item whose `products` or `billed_products` include `auth`, `transfer`,
  `payment_initiation` or `signal`. Confirm `available_products` (which may list `auth`) is not
  billed and grants nothing.
- `/institutions/get_by_id` needs `country_codes`; we use it only for the connection's label.
- `/accounts/get` balances are cached by Plaid (not real time); `balances.limit` is for credit.
- `/item/remove` ends billing for the item and invalidates the access token. Confirm the error
  code for a removed item's token (we treat `ITEM_NOT_FOUND` and `INVALID_ACCESS_TOKEN` as gone).

## Transactions

- `/transactions/sync` answers `added`, `modified`, `removed` (`transaction_id`, `account_id`),
  `next_cursor`, `has_more`, `accounts` and `transactions_update_status`. Check that `accounts`
  is on every page, and the exact values of `transactions_update_status`
  (`NOT_READY`, `INITIAL_UPDATE_COMPLETE`, `HISTORICAL_UPDATE_COMPLETE`): announcing starts after
  a sync that ends with `HISTORICAL_UPDATE_COMPLETE`.
- Before the first pull is ready, the first call answers an empty `next_cursor`; we keep no cursor
  and try again. Confirm.
- `count` is at most 500. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` we restart the pass
  from its first cursor (up to 3 times), as Plaid advises.
- `amount` is a JSON number in the major unit; **positive = money out of the account** (purchases,
  debits), **negative = money in** (deposits, refunds, card payments). We store the absolute value
  as a decimal string (`numeric(14,4)`, from the number's shortest text, never computed with) and a
  `direction` of `out` or `in`. Check amounts with more than 2 decimals (unofficial currencies).
- A pending transaction that posts is removed, and the posted one is added with a new id and
  `pending_transaction_id` pointing to the pending one. We announce the posted one only if we
  never stored the pending one. Confirm the order Plaid reports them in (same page or not).
- `personal_finance_category.detailed` is our `category`; the legacy `category` array is ignored.
- `/transactions/get` (the query tool) takes `start_date`, `end_date` and
  `options.count` (≤ 500), `options.offset`, `options.account_ids`, and answers
  `total_transactions`. It may answer `PRODUCT_NOT_READY` right after connecting.

## Webhooks

- The webhook URL is set per item through the Link token:
  `<APP_ORIGIN>/api/connections/bankfeed/webhook/<client id>`. Nothing needs setting in the
  dashboard for it. Changing it for existing items needs `/item/webhook/update` (not built).
- `SYNC_UPDATES_AVAILABLE` (type `TRANSACTIONS`) starts a sync. We also accept the older
  `DEFAULT_UPDATE`, `INITIAL_UPDATE` and `HISTORICAL_UPDATE` codes.
- `ITEM` / `ERROR` (with `error.error_code`, e.g. `ITEM_LOGIN_REQUIRED`), `USER_PERMISSION_REVOKED`
  and `USER_ACCOUNT_REVOKED` put the connection in `error`. `PENDING_EXPIRATION`,
  `PENDING_DISCONNECT` and `LOGIN_REPAIRED` are ignored in v1: check whether
  `PENDING_DISCONNECT` should warn the client earlier.
- Verification: the `Plaid-Verification` header is a JWT with header `alg: ES256` and `kid`;
  claims `iat` and `request_body_sha256` (hex SHA-256 of the body **as sent**, whitespace
  included). The key comes from `/webhook_verification_key/get` (`key_id`), a JWK with `x`, `y`,
  `crv: P-256`, `created_at`, `expired_at`. We reject a key whose `expired_at` is in the past,
  an `iat` more than 5 minutes off our clock either way, and any other algorithm. Confirm how
  Plaid rotates keys and whether an expired key may still sign webhooks for a while.
- Plaid retries a webhook that doesn't get a 200; confirm the retry schedule and timeout.

## Product and compliance

- Production access needs Plaid's review (company profile, security questionnaire, use case).
- The price per connected item, and whether it is absorbed or passed into credits: the owner's
  open question (docs/plan.md §7, item 9).
- HIPAA: `plaid` is a processor in `packages/core/src/compliance/processors.ts`; a client in HIPAA
  mode can't be offered the bank feed until Plaid's BAA (if Plaid signs one) is in
  `BAA_PROCESSORS`.
- Plaid's end-user privacy policy and data-transparency messaging are shown inside Link; check
  whether our terms must link to Plaid's end user privacy policy.
