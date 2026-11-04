# Webhooks connector: notes and the Zapier app plan

## What v1 is (built)

- `webhook` connector, `auth: 'none'` (the client connects it from the portal; no provider sign-in).
- **In**: hooks per connection. `POST /api/hooks/:clientId/:hookId` with the hook's token (`?token=` or
  `x-mezonas-token`) or a signature (`x-mezonas-signature: sha256=<hex>` of `<ts>.<body>` keyed with the
  token, `x-mezonas-timestamp` within 5 minutes). JSON or form, 64 KB, 60/min per hook, stored once
  as `raw_record(connector='webhook', entity_type='Delivery', external_id='<hookId>:<key>')` where the
  key is the sender's `Idempotency-Key` or the body's sha256. Emits `webhook.received` (a connector
  event type) with the body as `data`. Unknown hooks, wrong tokens and other clients' paths all
  answer 401, so nothing can be probed.
- **Out**: `webhook.event.send` (`external`, verb `create`): POSTs `{id, event, data, sentAt, source}`
  to the connection's outbound URL with `Idempotency-Key`, `x-mezonas-timestamp` and
  `x-mezonas-signature` (signing secret per URL). https only, public hosts only, no redirects,
  10-second timeout. The response status and its first 2 KB are the action's result.
- Storage: hook ids, names and the outbound **host** in `connection.config` (the operator sees them,
  and can filter triggers on `hookName`/`hookId`); tokens, the outbound URL and its signing secret in
  the encrypted credentials (only the client admin's portal shows them).

## Follow-ups (not built)

- Several outbound targets per connection (named), chosen per step.
- A per-hook trigger picker in the builder (today a trigger filter on `{{trigger.hookName}}`).
- A delivery log in the portal (the raw records are there; no screen yet).
- Retention for `Delivery` raw records (they are append-only like every raw record).
- DNS-resolving SSRF check (today: URL as written, plus Cloudflare egress and no redirects).

## The published Zapier app (later, owner 2026-11-04)

A Zapier Platform app ("Mezonas") over the same endpoints, so a client picks Mezonas in Zapier's
editor instead of pasting URLs.

**Auth.** OAuth 2.0 against Mezonas (WorkOS-backed sign-in), scoped to one client and to the client
admin's role; the token can manage that client's webhook connection only. Needs: an OAuth
authorization server in `apps/api` (authorize, token, refresh), a `zapier` OAuth client per
deployment, and token storage (a new table, hence a migration). Alternative for a first version: an
API key per client made in the portal (`auth: 'api_key'` in Zapier), revocable.

**Triggers** (REST hooks, so Zapier subscribes and unsubscribes itself):
- *New event from Mezonas* — `performSubscribe` calls `POST /api/zapier/hooks/outbound` (creates an
  outbound target pointing at Zapier's `targetUrl`), `performUnsubscribe` deletes it. Payload as today.
  Needs several outbound targets per connection (above).
- *Approval needed* / *Run finished* (later): the same mechanism over `inbox.*` and run events, with
  portal-safe fields only (invariant 11).
- `performList` for sample data: the last few events sent (needs the delivery log).

**Actions:**
- *Send data to Mezonas* — `POST /api/hooks/...` with a hook chosen from a dynamic dropdown
  (`GET /api/zapier/hooks`) or created on the fly; input fields free-form.
- *Find a run* (search) — later.

**Work before building:** Zapier Platform CLI project in its own repo or `apps/zapier`, REST-hook
subscription routes, OAuth server, app review by Zapier (public listing). Check Zapier's current
platform requirements (CLI version, review rules) at that time; nothing here was checked against them.
