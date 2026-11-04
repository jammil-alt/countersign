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
| Errors come back as HTTP 200 with `{"error": "invalid_code"}` (reused or wrong-DC code, revoked refresh token) | Checked for `invalid_code`; treated as "reconnect" on refresh |
| Revoke: `POST <accounts-server>/oauth/v2/token/revoke?token=<refresh token>` | **UNCHECKED** |
| DC list: accounts.zoho.com / .eu / .in / .com.au / .jp / .ca / .com.cn / .sa / .uk, API domains `www.zohoapis.<same>` | **UNCHECKED** (third-party note says the published list is shorter than the live one; `accounts.zoho.com/oauth/serverinfo` lists them). Unknown servers are refused, never contacted |

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
| Org id | `GET /crm/v8/org` → `{org:[{id, company_name, …}]}` | **UNCHECKED** shape |
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
- Upsert with `duplicate_check_fields` so a retried create can't make a second record (Zoho takes no
  idempotency key; today the external action runs the call once, and only a lost answer could repeat it).
- Per-DC client secrets from env (`ZOHO_CLIENT_SECRETS`).
- Field metadata (`/settings/fields`) for typed inputs in the builder.

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
