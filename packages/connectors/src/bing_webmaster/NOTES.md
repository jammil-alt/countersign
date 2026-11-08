# Bing Webmaster Tools connector: notes

Built 2026-11-08 against a fake (`./fake.ts`), from Plenary Labs' search import
(`apps/api/src/search/bing.ts`) and Bing's published JSON API as we know it. Bing's docs were not
reachable from the build environment. Everything marked **UNCHECKED** must be verified against a
real site (mezonas.com, owner's phase 0 task 3) before a client connects.

| Fact | Status |
|---|---|
| An API key is generated per Bing user in Webmaster Tools (Settings, API access) and reaches every site that user can see | **UNCHECKED** |
| `GET https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=…&apikey=…` and `…/GetPageStats?…` | **UNCHECKED** (Plenary's code calls these) |
| Answer `{d: [{Query, Date, Impressions, Clicks, AvgImpressionPosition, AvgClickPosition}]}`; for `GetPageStats`, `Query` holds the page's URL | **UNCHECKED** |
| `Date` is `/Date(ms±hhmm)/`; we take the calendar day it names at its own offset | **UNCHECKED** whether rows are per day or per week (we store each on the day Bing names) |
| The reports cover the history Bing keeps (about six months) in one answer, without paging | **UNCHECKED** |
| A site the key's user can't see answers an error object, not rows | **UNCHECKED** shape; we refuse any answer without `d` |
| 401 or 403 for a bad key; 429 when over quota | **UNCHECKED** |
| How late Bing's figures settle | **UNCHECKED**; we leave out the last two days and read them on a later night |

Queries come without their pages, so a Bing query row is kept against no page (the pack's
`/*`). The key travels in the query string, as Bing's JSON API takes it: the URL is never logged,
and an error never quotes it.

## Not built

- `GetRankAndTrafficStats`, crawl and index reports, URL submission (a write: it would be an
  external action behind approval, and it tells Bing about pages, which §11.5 keeps off).
