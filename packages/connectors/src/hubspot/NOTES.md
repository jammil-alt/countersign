# HubSpot connector: notes

Written 2026-11-06 (stream W3-B) without network access to HubSpot's developer docs
(`developers.hubspot.com`) or a HubSpot developer account. The facts below are what we know of
HubSpot's OAuth and CRM v3 APIs; everything marked **UNCHECKED** must be verified with the owner's
public app and a test account before a client connects. The fake (`./fake.ts`) answers in these
shapes, so a wrong fact is fixed here, in `./index.ts` and in the fake.

## OAuth 2.0 (public app, authorization code)

| Fact | Status |
|---|---|
| Authorize at `https://app.hubspot.com/oauth/authorize?client_id&redirect_uri&scope&state`, scopes space-separated | Known; **UNCHECKED** whether HubSpot now prefers `optional_scope` for some |
| Code exchange: `POST https://api.hubapi.com/oauth/v1/token`, form-encoded `grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code` | Known |
| Answer: `access_token` (30 minutes), `refresh_token`, `expires_in`, `token_type` | Known |
| Refresh: same endpoint, `grant_type=refresh_token`; the refresh token does not rotate and does not expire until the app is uninstalled; 400 `BAD_REFRESH_TOKEN` when gone | **UNCHECKED** that it never rotates (we keep whichever comes back) |
| Which account: `GET /oauth/v1/access-tokens/{token}` → `hub_id`, `hub_domain`, `user`, `scopes` | Known; `hub_id` is the connection's account id. **UNCHECKED** whether HubSpot has moved this to a newer endpoint (the token sits in the path, so it must never be logged; we log no URLs) |
| Revoke: `DELETE /oauth/v1/refresh-tokens/{token}` | Known |
| Scopes asked: `oauth`, `crm.objects.{contacts,companies,deals}.{read,write}` | **UNCHECKED**: that notes and tasks need no scope of their own (we believe creating them against a record needs that record type's write scope). If they do, add `crm.objects.notes.write`-style scopes here and in the app |

## API used (CRM v3)

All under `https://api.hubapi.com`, `Authorization: Bearer <access token>`.

| Tool | Endpoint | Status |
|---|---|---|
| `hubspot.record.search` | `POST /crm/v3/objects/{contacts|companies|deals}/search` with `filterGroups[{filters[{propertyName, operator, value}]}]`, `query`, `properties`, `limit` (≤ 100), `after` → `{total, results, paging.next.after}` | Known. **UNCHECKED**: at most 5 groups of 6 filters (we send one group of at most 5) |
| `hubspot.record.get` | `GET /crm/v3/objects/{type}/{id}?properties=a,b` | Known |
| `hubspot.record.create` | `POST /crm/v3/objects/{type}` with `{properties}` | Known. A second contact with the same email is refused with 409 `CONFLICT` |
| `hubspot.record.update` | `PATCH /crm/v3/objects/{type}/{id}` with `{properties}` → the record with `updatedAt` | Known |
| `hubspot.note.create` | `POST /crm/v3/objects/notes` with `properties {hs_timestamp, hs_note_body}` and `associations [{to: {id}, types: [{associationCategory: "HUBSPOT_DEFINED", associationTypeId}]}]` | Known shape. **UNCHECKED** type ids: note→contact 202, note→company 190, note→deal 214 |
| `hubspot.task.create` | `POST /crm/v3/objects/tasks` with `hs_timestamp` (due), `hs_task_subject`, `hs_task_body`, `hs_task_status: NOT_STARTED`, `hs_task_type: TODO`, `hs_task_priority`, and an association | Known shape. **UNCHECKED** type ids: task→contact 204, task→company 192, task→deal 216 |
| Errors | `{status: "error", category, message, correlationId}`; 401 expired token; 404 `OBJECT_NOT_FOUND`; 409 `CONFLICT`; 429 `RATE_LIMITS` | Known. 429 and 5xx are retryable |

Values: HubSpot keeps every property as text; we return them as text (or null). Deal `amount`
stays the text HubSpot gives (no float); a tool that needs it as money reads it with `dec`.

## Idempotency (HubSpot takes no idempotency key)

- **Update** is safe to repeat: if every property already has the value asked for, nothing is sent
  and the result says `alreadyDone`. That check comes before the stale check (`expectedUpdatedAt`),
  so a retry after a lost answer is a no-op rather than a "changed since" refusal.
- **Create** (record, note, task): right before writing, a record of the same kind made in the last
  24 hours that matches it is taken as this action's own earlier write and reported done. A record:
  same type, every given property equal, found by its email, domain, name or deal name. A note: the
  same body on the same record (found by `hs_createdate` and the association, compared on our side).
  A task: the same subject and body, on the same record if any.
  - **UNCHECKED**: that search can filter on `associations.contact` / `.company` / `.deal` for notes
    and tasks, and on `hs_createdate` with epoch milliseconds.
  - **UNCHECKED**: that HubSpot stores `hs_note_body` exactly as sent (we send the text with `&`, `<`
    and `>` escaped). If HubSpot rewrites the HTML, the note's twin is not recognised and a retry
    after a lost answer adds the note again.
  - The cost: the same note or task on the same record within a day, asked for by two different
    actions, is made once. A contact whose email exists already (and is not this action's) is
    refused before writing ("update it instead"), as HubSpot itself would.

## Rate limits

**UNCHECKED** for public apps: about 100 requests per 10 seconds per account, and search endpoints
about 5 requests a second. Each tool call makes one to three requests.

## Not built

The directory import source (ARCHITECTURE §6.11) is a follow-up (docs/plan.md §1.52). No other
object types (tickets, line items, custom objects), no owners, no deletes, no merges.
