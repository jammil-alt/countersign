# Odoo connector: notes

Written 2026-11-12 without a live Odoo, an Odoo database or network access to Odoo's docs. What we
rely on comes from Odoo's documented external API as we know it (JSON-RPC `execute_kw`, which has
been stable from Odoo 8 to 19) and is marked **known**; everything else is **UNCHECKED** until a
real database is connected. The fake (`./fake.ts`) answers in the shapes listed here, so a fact
that turns out wrong is fixed in three places: this file, `./client.ts` / `./records.ts` /
`./index.ts`, and the fake.

## Address, sign-in and transport

| Fact | Status |
|---|---|
| `POST <address>/jsonrpc` with `{"jsonrpc":"2.0","method":"call","params":{"service":…,"method":…,"args":[…]}}` | known |
| `common.authenticate(db, login, key, {})` answers the user id, or `false` for a login or key it refuses | known |
| `object.execute_kw(db, uid, key, model, method, args, kwargs)` runs a model method as that user, with that user's access rights and record rules | known |
| An API key (My Profile → Account Security → New API Key) is accepted wherever the password is, on Odoo 14 and later | known |
| Odoo Online answers the external API only on the Custom plan (not One App Free or Standard) | **UNCHECKED**: Odoo's pricing page said so in 2025. The client must be told before connecting |
| An API key may be given an expiry (Odoo 17+: up to 3 months for non-admins, then it stops) | **UNCHECKED**. An expired key is `AccessDenied`: the connection needs the client again |
| A wrong database name fails `authenticate` with an error answer (`psycopg2.OperationalError` or `KeyError`), not `false` | **UNCHECKED**: either way it is "the client must enter the login again" |
| Odoo 19 adds `/json/2/<model>/<method>` (bearer key, `X-Odoo-Database`) and marks `/jsonrpc` and `/xmlrpc` deprecated, to go in a later version | **UNCHECKED** which version removes them. Moving is a change to `client.ts` alone |
| Odoo served under a path (`https://example.com/odoo/` as the root) | **UNCHECKED**. We keep only the address's origin, so a pasted link to a screen (`/odoo/action-123`) works |
| Every call runs in one transaction that Odoo rolls back on any exception, so an error answer means nothing was written | known (Odoo's RPC dispatch) |
| Error answers are HTTP 200 with `error.data.name` the exception's dotted name (`odoo.exceptions.UserError`) and `error.data.message`; `error.data.debug` holds a traceback, which we never read or show | known |
| Rate limits | **UNCHECKED**. Odoo Online is said to throttle heavy RPC use; a 429 is a retryable refusal, no throttle is sent |
| Redirects: an http address or a moved database answers 3xx | We never follow one (the key goes only to the address the client gave) and say "check the Odoo address" |

## Reading

| Fact | Status |
|---|---|
| `fields_get(attributes=[type, string, relation])` lists a model's fields; one call per model per tool call | known |
| `search_read(domain, fields, limit, offset, order)` and `search_count(domain)`; archived records are left out unless `context.active_test` is false | known |
| Asking `search_read` for a field the model doesn't have is an error | known. We read only the defaults Odoo lists in `fields_get`, so a database without, say, `account` installed (no `customer_rank`) still reads; a field the agent names that isn't there is refused before sending |
| Empty values come back as `false` whatever the type; many2one as `[id, "name"]`; x2many as id lists; float and monetary as JSON numbers | known. We return `null`, `{id, name}`, the id list, and decimal text |
| `stock.move.quantity` (17+) is `quantity_done` before 17 | known; `fields_get` picks whichever is there |
| `account.move.line.display_type = 'product'` marks invoice lines (17+); before, product lines have it empty | **UNCHECKED** for 14–16: the line list may be empty there. Lines aren't relied on for any write |
| `account.move` with `move_type = 'entry'` are journal entries; agents see only invoices, credit notes and bills (`out_invoice`, `out_refund`, `in_invoice`, `in_refund`) | known |
| `crm.lead` exists only with the CRM app; `purchase.order` only with Purchase; `stock.*` only with Inventory | known. A missing model answers an error (`KeyError`), shown as "isn't in this Odoo" |

## Writing

| Fact | Status |
|---|---|
| `create(vals)` answers the new id (a list of ids from 17 when given a list; we send one dict) | known; both are read |
| `write([id], vals)` answers `true` | known |
| One2many commands: `[0, 0, vals]` creates a line; many2many `[6, 0, ids]` sets the list | known |
| Order lines without `price_unit` get the pricelist (sales) or vendor (purchase) price; taxes come from the product | **UNCHECKED** over RPC on each version (computed fields from 15/16 should apply them; before, onchange did and RPC skips onchange) |
| `purchase.order.line.date_planned` and `name` are required before 16 | **UNCHECKED**. If Odoo refuses, the refusal is passed on (not written) |
| `sale.order.action_confirm`, `purchase.order.button_confirm` confirm; a purchase order above the company's approval limit goes to `to approve` instead | known. `to approve` is reported as confirmed by us, waiting on their manager |
| `account.move.action_post` posts a draft and gives it its number | known |
| `stock.picking.button_validate` answers `true` when done, or a window action (`stock.immediate.transfer`, `stock.backorder.confirmation`, …) when Odoo wants a person to choose | known in shape; the wizard names differ by version. We refuse and leave it to a person |
| `message_post(body, message_type='comment', subtype_xmlid='mail.mt_note')` logs an internal note (followers aren't notified) and answers the message id | known for 14–17 (`@api.returns`); **UNCHECKED** on 18–19 |
| A plain-text `body` over RPC is escaped (17+) or sanitized as HTML (before) | **UNCHECKED** per version. Markup in the text never runs either way; on old versions it may show as formatting |
| `mail.activity.create` needs `res_model_id` (an `ir.model` id, readable by internal users) and `res_id`; the activity type defaults to a to-do | **UNCHECKED**: the default type, and whether a user with few rights can read `ir.model` |
| No idempotency key on any method | known. Once only is ours: see `docs/plan.md` §1.97 |

## The Odoo user

The client makes an internal user for us with only the apps and rights the work needs (for
example Sales: User, Purchase: User, Invoicing: Billing, Inventory: User), not Administrator, and an
API key for it. What each right allows is Odoo's: a call outside it is `AccessError`, passed on as
`forbidden` and not written. **UNCHECKED**: whether an internal user costs the client a seat on
their plan (it does on Odoo Online's per-user pricing, as far as we know).

## To verify against a real Odoo (in order)

1. Odoo 17 Online trial on the Custom plan: connect with an API key, read each model, search with a
   word and with a condition on a link path.
2. Create a quotation with two lines without prices; check prices and taxes filled in. Same for an
   RFQ and a draft vendor bill.
3. Confirm the quotation and the RFQ; post the bill; check the totals the tools compare.
4. Validate a receipt with quantities set, then one without (expect the wizard refusal).
5. Log a note with `<b>` and `&` in it; check how it shows. Schedule an activity as a user with
   only Sales: User.
6. Repeat 1 and 5 on Odoo 16 and 18, and on 19 (`/jsonrpc` still answers, deprecated).
7. Revoke the key in Odoo; check the connection asks the client again.
