# Podio connector: notes

Checked 2026-11-04. `developers.podio.com` was not reachable from the build environment. Facts come
from (a) web search summaries of Podio's docs and (b) Podio's official PHP client, `podio/podio-php`
(GitHub, commit `1c55389`, 2024-02-22), read for endpoint paths, request encodings and error codes.
Everything marked **UNCHECKED** must be verified against the live docs and a real Podio org before a
client connects.

## OAuth 2.0 (server-side flow)

| Fact | Status |
|---|---|
| Authorize at `https://podio.com/oauth/authorize?response_type=code&client_id&redirect_uri&state` (`scope` optional) | Checked (podio-php `authorize_url`; docs recommend `state` against CSRF) |
| Code exchange: `POST https://api.podio.com/oauth/token`, form-encoded, `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret` | Checked (podio-php `authenticate`). The docs also show `/oauth/token/v2` with a JSON body for refresh; we use the form endpoint the client library uses. **UNCHECKED** which one Podio prefers today |
| Answer: `access_token`, `refresh_token`, `expires_in`, `scope`, `ref: {type, id}` (the user) | Checked (podio-php `PodioOAuth`) |
| Access token 8 hours, refresh token 28 days | Checked (docs summary). **UNCHECKED**: whether 28 days runs from issue or from last use. If from last use, a connection nobody uses for 28 days must reconnect; a scheduled refresh is a follow-up |
| Refresh: same endpoint, `grant_type=refresh_token`; answer has the same shape (new refresh token) | Checked; we save the new refresh token every time |
| Requests carry `Authorization: OAuth2 <access token>` | Checked (podio-php) |
| Errors: 400 `invalid_grant` (bad code or refresh token), 401 `invalid_token` / `expired_token` (refresh and retry), 403, 404, 409 conflict, 410 gone, **420 rate limit**, 5xx | Checked (podio-php `request`) |
| Scopes: optional; format like `item:read` | **UNCHECKED**: no scope is sent, so the grant is what the signing-in user can do. Agents are still limited by the connection's matrix and the approval gate |
| Revoke endpoint | None known; disconnect drops our tokens only. **UNCHECKED** |

## API used

| Tool | Endpoint | Status |
|---|---|---|
| `podio.space.list` | `GET /org/` (organizations with their `spaces`) | Path checked; `spaces` inside each org **UNCHECKED** |
| `podio.app.list` | `GET /app/space/{space_id}/` | Checked (path) |
| `podio.app.get` | `GET /app/{app_id}`: `config.name`, `config.item_name`, `fields[]` with `field_id`, `external_id`, `type`, `label`, `status`, `config.required`, `config.settings.options[]` | Checked (podio-php `PodioApp`, `PodioAppField`) |
| `podio.item.filter` | `POST /item/app/{app_id}/filter/` with `limit`, `offset`, `filters` (by field id), `sort_by`, `sort_desc` → `{total, filtered, items}` | Path checked; filter value formats per type **UNCHECKED** (passed through) |
| `podio.item.get` | `GET /item/{item_id}`: `item_id`, `app_item_id`, `title`, `link`, `app.app_id`, `current_revision.revision`, `fields[].values[]` | Checked (podio-php `PodioItem`) |
| `podio.item.create` | `POST /item/app/{app_id}/` with `fields` (by external id) and `external_id` → `item_id`, `title` | Checked (path; fields by field id or external id: docs summary) |
| (create retry) | `GET /item/app/{app_id}/external_id/{external_id}` | Checked (path) |
| `podio.item.update` | `PUT /item/{item_id}` with `fields` and `revision` → `revision` | Path checked; Podio refusing a stale `revision` with 409 **UNCHECKED** (we also check the revision ourselves first) |
| `podio.comment.create` | `POST /comment/item/{item_id}` with `value` (and `external_id`) → `comment_id` | Checked (path, `value`); `external_id` on comments **UNCHECKED** |
| `podio.task.create` | `POST /task/` with `text`, `description`, `due_date`, `ref_type: "item"`, `ref_id`, `external_id` → `task_id` | Checked (path, fields per `PodioTask`); `ref_type`/`ref_id` in the body **UNCHECKED** (podio-php also has `POST /task/{ref_type}/{ref_id}/`) |

**Field values on write** (podio-php `api_friendly_values`): text, number, progress, duration,
location as the value; money `{value, currency}`; category as option ids; date
`{start_date | start_utc, end_date | end_utc}`; app as item ids; contact as profile ids; email and
phone as `[{type, value}]`; tag as strings. Calculation, image, file and embed fields are refused
(read-only or need uploads). Values are checked against the app's own field definitions on every
write (`fields.ts`); a category value may be the option's id or its text.

**Field values on read** become plain values: category option texts, money `{value, currency}`, date
`{start, end}`, app `{itemId, title}`, contact `{profileId, name}`; multi-valued types are lists.

## Rate limits

About 1,000 calls an hour per user, 250 for heavy calls; headers `x-rate-limit-limit` and
`x-rate-limit-remaining`; status **420** when hit. The numbers come from a third-party directory and
are **UNCHECKED**; status 420 and the headers are checked (podio-php). A 420 fails the call as
retryable, so the step retries with backoff.

## Idempotency

Podio takes no idempotency key, but items, comments and tasks take an `external_id`. Item create sets
`external_id` to the external action's key (unless the step gives one) and looks it up first, so a
retry after a lost answer finds the first item instead of creating a second. Comments and tasks carry
the key too, but are not looked up before creating (a follow-up if retries prove common).

## Not built (follow-ups)

- Sync of items into `raw_record`, and Podio **hooks** (`POST /hook/{ref_type}/{ref_id}/`, with a
  verification handshake: `/hook/{id}/verify/request` and `/verify/validate`) as a trigger.
- Files (`/file/`), and file, image and embed fields.
- A scheduled refresh, if refresh tokens expire when unused.

## Sources

- [How to authenticate with the Podio API](https://developers.podio.com/authentication)
- [podio-js authentication](https://podio.github.io/podio-js/authentication)
- [Podio API: items](https://developers.podio.com/doc/items)
- [Filter items](https://developers.podio.com/doc/items/filter-items-4496747)
- [Filters](https://developers.podio.com/doc/filters)
- [Add new item](https://developers.podio.com/doc/items/add-new-item-22362)
- [Item model](https://developers.podio.com/models/item)
- [Podio API at publicapi.dev](https://publicapi.dev/podio-api) (rate limits; third party)
- [podio/podio-php](https://github.com/podio/podio-php) (official client: paths, encodings, errors)
