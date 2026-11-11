# Worker `cache`: items 1.2 and 1.9 of docs/audit-plan.md

You are the `cache` worker of the speed run. Your branch is `speed/cache`. You run alone: nothing
else in phases 1 to 3 starts until your PR is merged, so other workers are waiting on you.

## Your items

- **1.2 A cache under `useApi`: show what is known, refresh behind.** Read the item in the plan in
  full and build exactly that: keep `useApi`'s signature (260 call sites, none of which you change
  except to opt a route out or show `refreshing`); a store keyed by route, options and the active
  client; stored answer at once with a refresh behind (`loading` false when there is data, plus
  `refreshing`); identical GETs in flight shared; any successful write marks every stored answer
  stale; nothing older than five minutes is shown; `cache: "none"` opt-out for short-lived links
  and one-time values (signed document links, second-factor and vault routes: find them all);
  `prefetch(route, options)`. Memory only: never `localStorage`, `sessionStorage` or IndexedDB.
  Emptied on sign-out, on a session change, on the idle lock and when the operator's client
  changes. Tests: a fake-fetch test for each bullet, and one that a second user's session never
  sees the first's answers.
  The owner's answer to D6 is "our own cache first". If the store grows past about 300 lines, or
  you can see paged lists (item 3.1: `limit`, opaque `cursor`, `items` and `nextCursor`, pages
  appended, first page cached) will not fit it cleanly, stop and tell the lead before going on.
  Done when: list → row → back shows the list at once; the agent page's Workflow tab asks
  `catalog/events` once.
- **1.9 A failed refresh keeps the page.** Keep `data` when a refresh fails and show the error
  beside it; store the key with the data and never show another key's data (the skeleton or
  today's loading state instead). Test both. Run pages must keep polling after a failed refresh.

Keep the store per `ApiClient` (or per `ApiProvider`) so tests that hand in a fake client never
share answers. Watch the existing screen tests: many may assume a fresh fetch per mount; fix the
store's isolation, not the tests' expectations.

## Your files

- `apps/web/src/api/**` (the hook, the store, their tests).
- The few lines that empty the store, in `apps/web/src/session/**` (sign-out, session change, the
  idle lock in `session/activity.ts`) and wherever the operator's active client changes.
- The one-line opt-outs (`cache: "none"`) at the call sites that need them, and `refreshing` where
  a screen already shows a reload.
- `docs/` is not yours, except the PR body.

## Screens to measure and photograph

Measure both surfaces in full (they all go through `useApi`). Screenshots: back-office Runs, a run
page and back again to Runs; the agent page's Workflow tab; portal Home. Show in the PR that going
back to a list shows it at once (the measurement's `move` rows, and a note of what you saw).
## How you work (the same for every worker in this run)

You are a worker in the speed and structure run of `jammil-alt/countersign` (Mezonas). A lead
session coordinates the run and is the only one that merges. The lead's session id is
`session_01SXdUGAm6RT8JE1EEfcxtfv`.

**Read first, in full:** `CLAUDE.md`, `docs/audit-plan.md` (the plan: your items, "The rules for
every screen", the owner's answers to D1–D6) and `docs/audit-plan-run.md` (gates). Follow
`CLAUDE.md`. Do not edit `docs/audit-plan.md`: the lead owns it.

**Branch.** You are on `speed/cache`, cut from `speed/run`. Commit only there and push with
`git push -u origin speed/cache`. Never push to `speed/run` or `main`. If the lead asks you to
rebase on `speed/run`, rebase your own branch and push with `--force-with-lease` (your branch only).

**Files.** Touch only the files listed under "Your files". If you need another file, send the lead
a message first saying which and why, and wait for the answer. Tests next to files you own are yours.

**Before each item, run its "Check"** from the plan. If it no longer holds, say so in the PR and
skip that item.

**Database and app (your own, on your own machine):**

```bash
apt-get install -y postgresql-16-pgvector   # only if pgvector is missing; apt-get update first if it is not found
pg_ctlcluster 16 main start
su postgres -c "psql -qc \"alter user postgres password 'postgres'\""
pnpm install --frozen-lockfile
cp .env.example .env
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres \
  CS_OWNER_PASSWORD=cs_owner CS_WORKER_PASSWORD=cs_worker scripts/setup-postgres.sh
SEED_DEMO=1 SEED_E2E=1 DIRECT_DATABASE_URL=postgresql://cs_owner:cs_owner@localhost:5432/countersign pnpm db:seed
su postgres -c "psql -c \"alter system set log_statement='all'\" -c \"alter system set log_line_prefix='%m [%p] '\" -c \"alter system set log_connections=on\" -c 'select pg_reload_conf()'"
pnpm dev    # in the background; ready when `curl localhost:8787/api/auth/dev/users` answers
```

Chromium is at `/opt/pw-browsers/chromium`; `require('playwright')` works from any directory. Do
not install Playwright. A `Request.cf` fetch error in the `wrangler dev` log is harmless.

**Measure** with `docs/speed-run/measure.mjs` (appendix A of the plan). Copy it outside the repo,
then run it for the surface(s) you touch, plain and with `LATENCY_MS=100`, **before** your change
(on the `speed/run` you started from) and **after** it, on your machine. Ids for the demo seed:

```bash
CLIENT_ID=d05e3878-9438-5523-b4b2-ef83e76a0da2 RUN_ID=65051fda-35fd-564a-a619-2b315848eb38 \
  AGENT_ID=2249ecf7-3a8e-5031-8e74-092837d39c74 node measure.mjs ops ops.json   # and: portal portal.json
```

**Gates. Your PR is ready only when all of these hold:**

1. `pnpm check` is green (lint, layering, typecheck, tests).
2. The measurement before and after: no screen's API calls or SQL statements go up, and each
   item's "Done when" holds. Put the before/after table for the screens you touched in the PR.
3. The route sweep passes: `pnpm --filter @countersign/web sweep` with `pnpm dev` running (rebuild
   first: `pnpm dev` builds the web app once at start, so restart it after your last change).
4. Screenshots of each screen you touched, light and dark, at 1440 wide and at phone width (390),
   taken with Playwright at deviceScaleFactor 2. Publish them on one private Artifact page and link
   it from the PR, if you have the Artifact tool. If you don't, push the images to a branch
   `speed/cache-shots` (never to your PR branch) and link them from the PR.
5. A different agent reviews it. The lead arranges that; you answer the review.

**Never** loosen, skip, disable or rewrite a test, a lint rule or a gate to get green. If a gate
fails twice, stop, and tell the lead with the output. No invariant in `CLAUDE.md` may be loosened;
the nearest to this work are 1 (client isolation), 8 (approval), 11 (no bundles, prompts or cost
in the portal) and 14 (audit). Copy and UI follow "UI and copy" in `CLAUDE.md`: the design system's
tokens and classes only, both themes.

**Decisions.** Where you choose between options, leave a `// DECISION:` comment in the code and
write the decision in the PR body under "Decisions for docs/plan.md §1". The lead adds them to
`docs/plan.md` on merge, so workers don't collide in that file.

**The PR.** Open it against `speed/run`, never `main`, as a draft while you work. Body: the items
done (and any skipped by their Check), what changed, the decisions, the measurement table, the
sweep result, the screenshots link, and what a reviewer should look at. No model identifiers in
commits, PR text or code; end commits with the attribution lines your environment gives you.
When every gate passes, mark it ready and send the lead a message (`send_message` to
`session_01SXdUGAm6RT8JE1EEfcxtfv`) with the PR link. If you are stuck, send the lead a message
saying what and why. If you have no `send_message` tool, say it in a PR comment.

**When done** (PR ready, or stopped): stop `pnpm dev` and Postgres (`pg_ctlcluster 16 main stop`).
If the lead or the reviewer asks for changes, start them again, fix, re-run the gates, and tell
the lead.
