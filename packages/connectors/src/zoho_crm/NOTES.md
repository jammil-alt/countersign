# Zoho CRM connector: notes

Checked 2026-11-04. `www.zoho.com` was not reachable from the build environment, so facts come from
web search summaries of Zoho's docs (links below). Everything marked **UNCHECKED** must be verified
against the live docs and a Zoho sandbox org before a client connects.

## OAuth 2.0 (Zoho Accounts)

| Fact | Status |
|---|---|
| Authorization request to `https://accounts.zoho.com/oauth/v2/auth` with `response_type=code`, `client_id`, `scope` (comma-separated), `redirect_uri`, `access_type=offline` (for a refresh token), `prompt=consent`, `state` | Checked (search summary of Zoho's multi-DC and token docs) |
| Multi-DC must be enabled on the client in the API console | Checked |
| The callback carries `location` (the user's DC) and `accounts-server` (the accounts URL to exchange the code at) | Checked |
| Code exchange: `POST <accounts-server>/oauth/v2/token` with `grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code`; answers `access_token`, `refresh_token`, `api_domain`, `token_type`, `expires_in` (3600) | Checked (fields); **UNCHECKED**: params sent as a form body rather than the query string |
| API calls go to `api_domain` with `Authorization: Zoho-oauthtoken <token>` | Checked |
| Refresh at the same DC's accounts server with `grant_type=refresh_token`; the answer has no new refresh token (they don't rotate); recent docs say it also returns `api_domain` | Checked; we keep the old refresh token and update the API domain if one comes back |
| Each DC may have its own client secret | Checked; `clientSecrets` (by accounts server) supported in code, not wired to env yet |
| Errors come back as HTTP 200 with `{"error": "invalid_code"}` (reused or wrong-DC code, revoked refresh token) | Checked for `invalid_code`; treated as "reconnect" on refresh (any other error, e.g. `invalid_client` or too many refreshes, is retried) |
| Revoke: `POST <accounts-server>/oauth/v2/token/revoke?token=<refresh token>` | **UNCHECKED** |
| DC list: accounts.zoho.com / .eu / .in / .com.au / .jp / .ca / .com.cn / .sa / .uk, API domains `www.zohoapis.<same>` | **UNCHECKED** (third-party note says the published list is shorter than the live one; `accounts.zoho.com/oauth/serverinfo` lists them). Unknown servers are refused, never contacted |

| API hosts of non-production orgs: a Developer Edition org's API is `https://developer.zohoapis.<dc>`, a sandbox's `https://sandbox.zohoapis.<dc>` (the org itself is at `developers.zoho.com/crm`) | **UNCHECKED**: from the owner's setup notes (2026-11-12), not yet seen in a token's `api_domain`. Both are accepted by `isZohoApiDomain` beside `www.zohoapis.<dc>` |

Security: `accounts-server` is a query parameter anyone can forge, and the code exchange sends our
client secret to it, so only the allowlisted hosts are accepted (`isZohoAccountsServer`). `api_domain`
is checked against the same list.

## Scopes

`ZohoCRM.modules.{leads,contacts,accounts,deals}.{READ,CREATE,UPDATE}`,
`ZohoCRM.modules.notes.{READ,CREATE}`, `ZohoCRM.modules.tasks.{READ,CREATE}`, `ZohoCRM.org.READ`.
No `DELETE` or `ALL`. **UNCHECKED**: that search needs only the module's `READ` scope, and that
notes created through a record's related list need `notes.CREATE`.

## API v8 endpoints used

| Use | Endpoint | Status |
|---|---|---|
| Org id | `GET /crm/v8/org` → `{org:[{id, company_name, …}]}` | **UNCHECKED** shape, and that it answers only the organization the token works in (we take the first as the connection's account and keep every id in `config.accountIds`, so a sign-in again matches whatever the order) |
| Search | `GET /crm/v8/{module}/search?criteria=…|email=…|phone=…|word=…&page&per_page` → `{data, info:{more_records}}` | Path checked (community scripts); one of criteria/email/phone/word per call (criteria wins), criteria up to 10 conditions of `equals`/`starts_with`: checked. **UNCHECKED**: `per_page` max 200, 204 when nothing matches |
| Get | `GET /crm/v8/{module}/{id}` → `{data:[record]}` | **UNCHECKED** (v8 may require `fields` on list calls, not on get by id) |
| Create | `POST /crm/v8/{module}` `{data:[{…}]}` → `{data:[{code, status, details:{id, Modified_Time}}]}` | **UNCHECKED** shape (as in v2–v7) |
| Update | `PUT /crm/v8/{module}/{id}` `{data:[{…}]}` | **UNCHECKED** |
| Note | `POST /crm/v8/{module}/{id}/Notes` `{data:[{Note_Title, Note_Content}]}` | **UNCHECKED** (v8 may prefer `POST /Notes` with `Parent_Id`) |
| Task | `POST /crm/v8/Tasks` with `What_Id` + `$se_module` (Accounts, Deals, Leads) or `Who_Id` (Contacts) | **UNCHECKED** |

We omit the `trigger` array on writes, so the client's own Zoho workflow rules run as if a person
made the change. **UNCHECKED** default.

## Rate limits

Credits per rolling 24 hours by edition (Free 5,000; Enterprise about 50,000 + 1,000 per licence),
`X-API-CREDITS-REMAINING` past 50% use; concurrency caps by edition (Free 5 … Ultimate 25), with
`TOO_MANY_REQUESTS` (429) when exceeded. Checked (search summary). We fail the call with a retryable
`ZohoApiError`; the step's retries (3, exponential from 10 s) space them out. A per-org throttle is a
follow-up if clients hit the cap.

## Not built (follow-ups)

- Sync of modules into `raw_record` (bulk read or `GET /{module}?fields=…&modified_since`) and Zoho
  **notifications** (`/crm/v8/actions/watch`) as a trigger, as QBO's webhooks are planned. Notification
  limits and expiry are unchecked.
- Upsert with `duplicate_check_fields` so a create whose answer was lost can be checked instead of
  asking a person. Zoho takes no idempotency key; since 2026-11-20 creates, notes and tasks are made
  at most once per key through the platform's record of attempts (PLATFORM_QA STATE-4): a try
  started without Zoho's answer fails as unconfirmed and is never sent again.
- Per-DC client secrets from env (`ZOHO_CLIENT_SECRETS`).
- Field metadata: built 2026-11-20, below.

## Sync and notifications (W4-B, 2026-11-06; nothing below was checked against live docs)

| Fact | Status |
|---|---|
| List records: `GET /crm/v8/{module}?fields=…&sort_by=Modified_Time&sort_order=asc&page&per_page` with `If-Modified-Since` (ISO, offset); answers `{data, info:{more_records}}`, 304 when nothing changed | **UNCHECKED**: `fields` mandatory in v8 (at most 50), the sort, the header's format, and 304 (204 is also handled) |
| Page numbers reach only the first 2,000 records (10 pages of 200); past that the window moves on by the last record's `Modified_Time` | **UNCHECKED** (v8 offers `page_token` past 2,000; not used) |
| Field API names of a standard org (`ZOHO_SYNC_FIELDS`) | **UNCHECKED**; a renamed or removed field comes back absent |
| Notifications: `POST /crm/v8/actions/watch` `{watch:[{channel_id (number), events:["Leads.all",…], channel_expiry (≤ 1 day), token (≤ 50 chars), notify_url}]}`, answered under `watch` | **UNCHECKED**: the shapes, the one-day expiry, the token length; we renew after 20 hours |
| A notification is a POST to `notify_url` with `channel_id`, `token` (as given), `module`, `operation`, `ids` | **UNCHECKED** shape; we only check the token and channel, then poll |
| Scopes `ZohoCRM.notifications.READ` and `.CREATE` for the watch | **UNCHECKED**; added to the sign-in, so connections made before need a new sign-in for notifications (the poll works without) |
| A list call without `If-Modified-Since` lists every record of the module (a first sync's full read, 2026-11-24) | **UNCHECKED** |
| Deleted records: `GET /crm/v8/{module}/deleted?type=all&page&per_page` with `If-Modified-Since` → `{data:[{id, deleted_time, type, display_name, …}], info:{more_records}}`, 204 when none; `all` covers the recycle bin and permanently deleted records | **UNCHECKED**: the path, `type`, the shape, whether the header filters by `deleted_time`, and the order; at most 10 pages (2,000) of deletions per module and pass are read, any beyond are left |
| What `ZohoCRM.modules.ALL` (or the module scopes we ask for) grants covers `/deleted` | **UNCHECKED**; a refusal (the scope, or a 400, 403 or 404) skips that pass's deletions with a warning, so changes keep coming; a deleted record then stays in our copy until a pass reads its deletion |
| A record restored from the recycle bin comes back with a newer `Modified_Time` | **UNCHECKED**; we mark every version we hold of a record in the deleted list deleted, so a record restored inside the same pass's window stays out of matches until its next change is read |

When and how often (2026-11-24, owner: poll once a day, and again when an agent needs the
records). The first sync reads every record (history, no events); a connection whose first sync
read only 90 days reads everything once more by itself, records older than its window coming in
quietly (`quietUntil`). Each later pass lists each module's changes, then its deletions, which
mark the raw records deleted. apps/api polls a connection once a day, every 15 minutes while a
pass is unfinished, and every 15 minutes when an agent starts on Zoho's changes and the watch
isn't live; a step whose tool reads the synced records (`feed: "zoho_crm"`) catches up first
(apps/api `zoho/sync.ts` and `feeds.ts`).

## Field metadata and custom-field sync (docs/plan.md §1.164 step 3, 2026-11-20; nothing below was checked against live docs)

What we built: `fields.ts` reads a module's fields (`connector.fields`, `connector.fieldCache`, the
read tool `zoho_crm.field.list`); apps/api keeps them per connection in `sync_cursor.zohoFields`
(read daily by the cron, or at once from the back office) and types the builder's
`zoho_crm.record.create` / `.update` `fields` input from them (labels as titles, so Reshape data
proposes a custom field by its label). A connection's `config.syncFields` (`{ "Leads": ["Region"] }`)
adds fields to the sync's list call, checked against the field list and the 50-field limit.

| Fact | Status |
|---|---|
| Field metadata: `GET /crm/v8/settings/fields?module=<Module>` → `{fields:[{api_name, field_label, display_label, data_type, custom_field, read_only, field_read_only, system_mandatory, visible, length, view_type:{edit}, pick_list_values:[{actual_value, display_value}]}]}` | **UNCHECKED**: the path, every key's name and meaning (fixtures `fields-leads.json`, `fields-deals.json` follow v2–v7 docs). A field with `visible: false` is left out; `-None-` is dropped from picklists |
| Read-only: `read_only` or `field_read_only` true, `view_type.edit` false, or a `formula`, `autonumber`, `rollup_summary` or `aggregate` type | **UNCHECKED** which flag v8 sets for system fields (`Created_Time`) and formulas |
| Required on a create: `system_mandatory` | **UNCHECKED**; a layout's own mandatory fields aren't read (Zoho refuses the create, which fails the step) |
| A picklist's write value is `actual_value` (else `display_value`) | **UNCHECKED** |
| `data_type` values (`text`, `textarea`, `email`, `phone`, `website`, `picklist`, `multiselectpicklist`, `date`, `datetime`, `integer`, `bigint`, `double`, `decimal`, `currency`, `percent`, `boolean`, `lookup`, `ownerlookup`, `userlookup`, `formula`, `autonumber`, `fileupload`, `subform`, …) and the JSON a write takes for each (a lookup as `{id}`, a currency as a number) | **UNCHECKED**; an unknown type is typed "any" in the builder |
| Scope `ZohoCRM.settings.fields.READ` (and that `ZohoCRM.settings.fields.ALL` / `ZohoCRM.settings.ALL` grant it) | **UNCHECKED**; added to the sign-in, so connections made before need a new sign-in for field metadata (sync, tools and writes work without) |
| A call outside the grant's scopes answers 401 `{"code":"OAUTH_SCOPE_MISMATCH"}` | **UNCHECKED**; we read that code on any 401 and then don't refresh the token (it isn't expired) and don't count it towards the connection's attention; the token answer's `scope`, when stored, already says whether to call at all |
| The token answer's `scope` lists the granted scopes, comma- or space-separated | **UNCHECKED** (the fixtures carry one); without it, the call itself tells |
| v8's list call reads at most 50 `fields` | **UNCHECKED** (as above); the check counts the standard fields and `Owner`, `Created_Time`, `Modified_Time` |
| A field named in `fields` that the org doesn't have | **UNCHECKED** whether v8 refuses the call or leaves it out; we leave out of the call any extra field the kept field list no longer has |

Fields chosen after records were synced: a record is read again with them (raw records are never
updated). The extra fields' key is part of the record's version (`<Modified_Time>~f1a2b3c4`), and a
change of fields starts a pass over every module from the first sync's window; a record read again
only for its fields (same `Modified_Time` as a version we hold) raises no event. Records older than
that window keep what they were read with until they change.

## Live setup (owner, 2026-11-12)

- **API console client** "Mezonas" (Server-based Application) on the owner's Zoho login, US data
  center, multi-DC on with the same credentials for every data center. Redirect URIs:
  `https://staging.mezonas.com/connections/zoho_crm/callback`,
  `https://app.mezonas.com/connections/zoho_crm/callback`,
  `http://localhost:8787/connections/zoho_crm/callback`. Its ID and secret go in the GitHub
  environments as `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET`.
- **Test org for this connector:** Zoho CRM Developer Edition "Mezonas Dev" (org 946623917; free, no
  expiry, sample data; Central time, USD). Run the UNCHECKED items above against it first, starting
  with the `api_domain` its token returns.
- **Set up, no connector built:** Zoho Books, Zoho Inventory and Zoho Expense share one test org,
  "Mezonas Test" (org 946624820; every Books and Inventory call passes `organization_id`). Books and
  Inventory are on Premium trials until about 2026-11-26 and then drop to their free plans (tighter
  API limits); Expense posts to Books. They are ready for when a client needs them: not in
  ARCHITECTURE v0.15's v1 scope, so a connector for any of them is a scope decision first.

## Sources

- [Multi DC support (Zoho Accounts)](https://zoho.com/accounts/protocol/oauth/multi-dc.html)
- [Multi DC support (CRM v8)](https://www.zoho.com/crm/developer/docs/api/v8/multi-dc.html)
- [Access and refresh tokens (CRM v8)](https://www.zoho.com/crm/developer/docs/api/v8/access-refresh.html)
- [Refresh access token](https://www.zoho.com/crm/developer/docs/api/refresh.html)
- [Zoho API console OAuth notes (unified.to)](https://docs.unified.to/skills/zoho-api-console-oauth/SKILL.md)
- [Search records V8 (Deluge)](https://www.zoho.com/deluge/help/crm/search-records-V8.html)
- [Kaizen #30: parameters in Zoho CRM APIs](https://help.zoho.com/portal/en/community/topic/kaizen-30-parameters-in-zoho-crm-apis-part-2-2)
- [API limits (CRM v8)](https://prezohoweb.zoho.com/crm/developer/docs/api/v8/api-limits.html)
- [Kaizen #203: handling API limits](https://help.zoho.com/portal/zh/community/topic/kaizen-203-answering-your-questions-handling-api-limits-and-error-responses)
