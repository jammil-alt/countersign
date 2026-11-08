# Hacker News connector (read only): notes

Written 2026-11-08 for M48 (`docs/plan.md` §1.77; `docs/marketing-plan.md` §4.2, D6). Neither API
was called from the build environment: the connector and its fake (`fake.ts`) follow the APIs as
we know them. Check every item under "To verify" against the live APIs before the forum watch runs
on staging, and fix the connector and the fake where they differ.

## What the connector does

- No sign-in, no key: `auth: none`. A client connects it in one click; the forum watch reaches it
  through an ordinary binding.
- `hackernews.search` (read): `GET https://hn.algolia.com/api/v1/search_by_date?query=…&tags=story&numericFilters=created_at_i>…&hitsPerPage=…`,
  newest first, stories only, from the last 1–30 days (default 7), at most 30. Each story: its
  id (`objectID`), title, the HN page `https://news.ycombinator.com/item?id=<id>`, the link it
  points at (http or https only), author, points, comment count, when posted.
- `hackernews.thread` (read): `GET https://hacker-news.firebaseio.com/v0/item/<id>.json` for the
  story, then each of its first 0–30 (default 20) first-level comments (`kids`), in parallel;
  deleted and dead items are left out. Takes an id or the item's HN link.
- HN's HTML (`text`, titles) becomes plain text in code (`hnText`): paragraphs as blank lines, a
  link as its address, every other tag dropped, entities decoded, control characters gone. Story
  text is cut at 8,000 characters and each comment at 4,000.
- Every answer is other people's words: the tools' descriptions say so, and the text only ever
  reaches a model as a tool result (invariant 9).
- Answers over 2 MB, non-JSON answers and non-2xx statuses are errors. Redirects aren't followed.
- Compliance: `hackernews` is a processor in `packages/core/src/compliance` (the search words go to
  Algolia, ids to Firebase), so a client in HIPAA mode is refused it.

## To verify

- Algolia's `search_by_date` parameters and answer: `hits[].objectID`, `title`, `url`, `author`,
  `points`, `num_comments`, `created_at_i`; whether `numericFilters` needs to be URL-encoded as we
  send it (`created_at_i%3E…`); the largest `hitsPerPage`.
- Algolia's rate limit (we believe 10,000 requests an hour per IP) and how a 429 looks.
- The item API's answer for an unknown id (`null` with 200, as the fake has it) and for a deleted
  item (`deleted: true` with no text).
- Whether the official API asks for a `User-Agent` or anything else from a Worker.
- Whether Algolia's or Firebase's terms limit this use (a few searches a day per client).
