# Website: what we couldn't verify

The `website` connector writes to Mezonas' own R2 bucket (bound as `SITE_CONTENT`) and pings
IndexNow. Its tests use `MemoryObjectStore` and a fake fetch; nothing below has been checked
against the live services. Check each item before the owner turns publishing on.

## The bucket (`SITE_CONTENT`)

- The binding is not in `apps/api/wrangler.jsonc` for staging or production: the owner adds it
  (and makes the bucket, e.g. `mezonas-site-content`). Until then `website.publish` and
  `website.meta` refuse with "publishing isn't set up" and the external action is recorded as
  failed. Staging's bucket must be one nothing public reads.
- That the site Worker (`apps/site`, behind `SITE_GUIDES=on`) reads exactly the keys and shapes of
  `docs/marketing-plan.md` §11.4: `site/<domain>/guides/<slug>.json`, `site/<domain>/sitemap.json`,
  `site/<domain>/redirects.json`, with `domain` without `www.`. The shapes are `GuideFragment` and
  `Sitemap` in `index.ts`; the site's builder should import nothing from here and keep its own copy.
- R2's custom metadata keeps the action's idempotency key and first publish time on the guide's
  object (`idempotencyKey`, `publishedAt`), so a re-run keeps its time. UNCHECKED: R2's limit on
  custom metadata size (2 KB, from memory) is far above what we write.
- The sitemap is read, changed and written back by each action, with no conditional write: two
  publishes at the same moment could lose an entry until the next publish. R2's `onlyIf` (etag
  match) would close it; not used yet.

## IndexNow

- The request: `POST https://api.indexnow.org/indexnow` with JSON
  `{ host, key, keyLocation, urlList }`, answered 200 or 202 (from IndexNow's docs as we remember
  them). UNCHECKED: whether `api.indexnow.org` forwards to Bing and Yandex as well, and the 422 it
  gives for a key it can't fetch.
- The key file: IndexNow fetches `https://<domain>/<key>.txt` and expects the key as its text. The
  site must serve it before `INDEXNOW_KEY` is set (owner action, with the site's builder). The key
  is not a secret (IndexNow proves ownership by fetching it), but it is kept as a Worker secret so
  that nothing pings until the owner sets it.
- A failed ping is logged and the publish still succeeds: a missed ping costs a crawl's delay.

## Titles of the site's own pages (`website.meta`)

- A change to a page of the site's own (not `/guides/…`) writes nothing: it is recorded on the
  external action (`applied: false`) and a person makes it in the site's code by pull request
  (docs/marketing-plan.md §4.5, "Core pages stay in git").
