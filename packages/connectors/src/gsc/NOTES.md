# Google Search Console connector: notes

Built 2026-11-08 against a fake (`./fake.ts`), from Plenary Labs' search import
(`apps/api/src/search/google.ts`) and Google's published API reference as we know it. Google's
docs were not reachable from the build environment. Everything marked **UNCHECKED** must be
verified against a real property (mezonas.com, owner's phase 0 tasks 1 and 2) before a client
connects.

## Sign-in: a service account (docs/marketing-plan.md D5)

| Fact | Status |
|---|---|
| A service account's key JSON has `client_email`, `private_key` (PKCS#8 PEM) and `private_key_id` | Checked (same key format as the Google Chat app, `../gchat`) |
| Token: `POST https://oauth2.googleapis.com/token`, form `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion` (RS256 JWT: `iss` the account's email, `scope`, `aud` the token URL, `iat`, `exp` ≤ 1 hour) | Checked (as `../gchat/auth.ts`) |
| Scope `https://www.googleapis.com/auth/webmasters.readonly` is enough for Search Analytics | **UNCHECKED** |
| The account needs no project roles, only to be added to the property (Restricted is enough to read Search Analytics) | **UNCHECKED** (Plenary's phase 0 says so) |
| A `token_uri` in the key is ignored: the assertion goes to Google's token URL only | Our decision |
| The Search Console API must be enabled on the account's Google Cloud project, else 403 | **UNCHECKED** wording of the error; we say "is the service account a user on the property?" for any 401/403 |

## Search Analytics

| Fact | Status |
|---|---|
| `POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl, URL-encoded}/searchAnalytics/query` | **UNCHECKED** (the older `www.googleapis.com/webmasters/v3/...` host also answers, by Google's docs) |
| Body: `startDate`, `endDate` (yyyy-mm-dd, the property's time zone: Pacific), `dimensions` (`date`, `query`, `page`), `type: web`, `dataState: final`, `rowLimit` ≤ 25,000, `startRow` | **UNCHECKED**: the 25,000 limit and that `dataState: final` leaves out days not final yet |
| Answer `{rows: [{keys, clicks, impressions, ctr, position}], responseAggregationType}`; `rows` absent when there are none | **UNCHECKED** |
| Properties are `sc-domain:example.com` (Domain) or `https://example.com/` (URL prefix) | Checked (Plenary used `sc-domain:`) |
| 16 months of history (we ask for 486 days the first time) | Google's docs say 16 months; **UNCHECKED** how a span starting before that answers (we expect rows only from the first day kept) |
| Anonymised queries are left out of `query` rows but counted in `page` rows | Google's docs say so; the Search screen says the two don't add up |
| Days are the property's days (Pacific), not UTC | **UNCHECKED** effect: we store the day Google names |
| Quotas: per site and per project, by load (QPS and a daily load budget); a query by `query` and `page` over a month is "expensive" | **UNCHECKED** numbers. We read a month at a time, at most 4 pages of 25,000 rows per month and dimension set, once a night; past that the day's record says `truncated` |
| 429 when over quota | **UNCHECKED**; we stop and say so, and the next night reads from where the data stops |

## What we keep

One raw record per connection, day and dimension set (`search.page_day`, `search.query_page_day`),
its version a hash of what it says. A day is stored only up to the last day Google gave final
figures for in that month; the days after wait for a later night. Never the token, the key or a
response body; a failure is kept as a reason in our words on the connection's sync state.

## Google sign-in (`gsc_oauth`, M50, `./oauth.ts`)

Built 2026-11-08 against the same fake, from what we know of Google's OAuth and Search Console's
sites list. A connector of its own beside `gsc` (the framework has one way to sign in per
connector); both store the same raw records and the Marketing pack treats both as Google.

| Fact | Status |
|---|---|
| Authorization at `https://accounts.google.com/o/oauth2/v2/auth` with `scope=webmasters.readonly`, `access_type=offline`, `prompt=consent`; code and refresh grants at `https://oauth2.googleapis.com/token` | Checked (as Gmail, Drive and Sheets) |
| The token answer's `scope` lists what was granted; a person can untick it | Checked for Drive; we refuse less or more than `webmasters.readonly` |
| `GET https://searchconsole.googleapis.com/webmasters/v3/sites` lists `siteEntry: [{siteUrl, permissionLevel}]`, `siteEntry` absent when there are none | **UNCHECKED** (the `www.googleapis.com/webmasters/v3/sites` host is the documented one) |
| `permissionLevel` is `siteOwner`, `siteFullUser`, `siteRestrictedUser` or `siteUnverifiedUser`; the first three can read Search Analytics | **UNCHECKED** |
| `webmasters.readonly` is a sensitive (not restricted) scope, so Google's verification of the OAuth client must name it; until then an app in testing gets refresh tokens that end after 7 days | **UNCHECKED** whether Google counts it as sensitive; owner action (docs/plan.md §1.78) |
| Revoking at Google ends every scope the account gave the shared client | Checked for Drive (so no `revoke` here either) |
| The redirect URI `<app origin>/connections/gsc_oauth/callback` must be registered on the OAuth client | Owner action |

The property read is `config.property`: the only property the account can read, else its only
Domain property, else the one the Marketing pack picks from the site's domain when a person points
a site's search figures at the connection (`set-search-source`). We never read two properties
through one connection (a Domain and a URL-prefix property of one site count the same searches).

## Not built

- `searchAppearance`, `country` and `device` dimensions; Discover and News (`type`).
