# Worker `ops-frame`: back-office frame and lists (step 3 of docs/audit-plan-run.md)

You are the `ops-frame` worker of the speed run. Your branch is `speed/ops-frame`.

The foundations are merged into `speed/run`: the cache under `useApi` (1.2 with 1.9: stored
answers show at once and refresh behind, `refreshing`, shared in-flight GETs, `prefetch`) and the
skeleton parts (1.3: `Loaded` takes a `skeleton`; the parts are in `apps/web/src/ui/`). Read both
PRs' code before you start. Four other workers run beside you, each on its own files: stay in yours.
For every screen you touch, the rules for every screen in the plan apply: give it a skeleton
shaped like its content, and move its hand-written loading/error/data triples to `Loaded`.
If you need a change in `apps/web/src/ui/**` or `apps/web/src/api/**`, ask the lead first.

The skeleton parts are in `apps/web/src/ui/skeleton.tsx` (see `apps/web/src/ui/README.md`):
`SkeletonLine`, `SkeletonText`, `SkeletonBlock`, `SkeletonCard`, `SkeletonStat(s)`, `SkeletonRows`,
`SkeletonPage`; `Loading size="line"` for a small slot; `Loading progress` for a write in progress.
The store is in `apps/web/src/api/store.ts`: `usePrefetch()` for 1.6, `keep: true` only for a
search or filter of one list. Decisions so far: `docs/plan.md` §1.91.

## Your items (read each in docs/audit-plan.md)

- **1.5** (back-office Home, `ops/command/CommandCenter.tsx`): Recent runs sits inside
  `<Loaded>`: give each section its own `Loaded` and skeleton, start the calls together. Done
  when: with `LATENCY_MS=100` Home shows its main content after one round trip past the session.
- **2.3** Escalations and the frame count Needs us once: `ops/OpsLayout.tsx` polls
  `/api/ops/counts` and reloads it on every route change; `ops/screens/Inbox.tsx` also polls
  `opsNeedsUs`. Have Escalations call `useShareCounts` as the command center does; reload counts on
  a route change only when the first path segment after `/ops` changes.
- **1.6** (your screens): prefetch on hover or focus of Home's and Escalations' rows that open a
  detail page; on Home, prefetch Escalations once Home has settled. One prefetch per target, none
  on touch scroll, none in a hidden tab.
- **1.8** for presses on your screens (snooze, mark read and filters at once with
  `useOptimistic`; decisions never shown as done early, rule 7).
- From 1.3: `apps/web/src/shell/Search.tsx` still shows loading text in the search popover: give
  it a skeleton of its result rows (`Search.tsx` and its test are yours too).

## Your files

`apps/web/src/ops/OpsLayout.tsx`, `ops/command/**`, `ops/screens/Inbox.tsx`, and their tests. Also
`apps/web/src/shell/Search.tsx` and its test.

## Screens to measure and photograph

The whole back-office surface in the measurement (counts calls must drop on moves). Screenshots:
Home and Escalations, light and dark, 1440 and 390, and one capture mid-load of Home.

## How you work (the same for every worker in this run)

You are a worker in the speed and structure run of `jammil-alt/countersign` (Mezonas). A lead
session coordinates the run and is the only one that merges. The lead's session id is
`session_01SXdUGAm6RT8JE1EEfcxtfv`.

**Read first, in full:** `CLAUDE.md`, `docs/audit-plan.md` (the plan: your items, "The rules for
every screen", the owner's answers to D1–D6) and `docs/audit-plan-run.md` (gates). Follow
`CLAUDE.md`. Do not edit `docs/audit-plan.md`: the lead owns it.

**Branch.** You are on `speed/ops-frame`, cut from `speed/run`. Commit only there and push with
`git push -u origin speed/ops-frame`. Never push to `speed/run` or `main`. If the lead asks you to
bring your branch up to date, merge `origin/speed/run` into it and push normally. Never force-push
(the sessions refuse it); the lead merges with a merge commit.

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
If `pnpm check` fails at `apps/api/src/browser/chromium.test.ts` with "Executable doesn't exist at
/opt/pw-browsers/chromium_headless_shell-1248/...", the container has another build: fix the
environment, never the test (`ls /opt/pw-browsers` for the build you have):
`mkdir -p /opt/pw-browsers/chromium_headless_shell-1248 && ln -sfn /opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64 /opt/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64`.
For the sweep, `SWEEP_CHROMIUM=/opt/pw-browsers/chromium` also works. If `pnpm typecheck` is killed for memory
(exit 137), run `pnpm -r --workspace-concurrency=4 typecheck` instead (same checks, fewer at once)
and say so in the PR. Empty the Postgres log (`truncate -s 0 /var/log/postgresql/postgresql-16-main.log`)
before measuring. `pnpm lint` checks `docs/` too.

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
   `speed/ops-frame-shots` (never to your PR branch) and link them from the PR.
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
