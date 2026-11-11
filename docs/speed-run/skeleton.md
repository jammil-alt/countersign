# Worker `skeleton`: item 1.3 of docs/audit-plan.md

You are the `skeleton` worker of the speed run. Your branch is `speed/skeleton`. You run alone:
the five screen workers start only after your PR is merged. The cache under `useApi` (items 1.2
and 1.9) is already merged into `speed/run`: `loading` is false when stored data exists, and there
is a `refreshing` flag.

## Your item

**1.3 Skeletons in place of "Loading".** Read the item in the plan. Build the foundation that every
screen worker after you will use:

- `Skeleton` parts built from the design system's tokens: a line (text width), a block, a card, a
  stat, table rows (a number of rows and columns), and a page body (title line plus a few cards).
  No new colours, radii or shadows (the design system in `packages/design-system` is read-only;
  your CSS goes in the web app's own stylesheets). Both themes. A gentle pulse at most, and none
  under `prefers-reduced-motion: reduce`. `aria-hidden` on the shapes, with one visually hidden
  "Loading" for screen readers (keep the existing i18n key).
- `Loaded` (`apps/web/src/ui/page.tsx`) takes an optional `skeleton` and shows it on a first load
  instead of the `Loading` text. With none given, it shows the page-body skeleton, so no screen
  shows the loading text after the frame is up from the day this merges.
- `Loading` (`apps/web/src/ui/primitives.tsx`, 111 uses) shows a skeleton too, not text. Where a
  `Loading` is used inline (a button, a small slot), keep it small: read the call sites and give
  `Loading` a size if needed rather than editing every caller.
- Fold the sidebar's `SidebarAgentSkeleton` (`apps/web/src/shell/Shell.tsx`) onto the shared parts
  if it fits without changing how it looks.

You do **not** shape each screen's skeleton or move the hand-written loading/error/data triples:
the screen workers after you do that for their own screens. Do it only for the few screens in
`apps/web/src/ui/**` and `shell/**` if any.

Done when: no screen shows the loading text after the frame is up (check in the sweep and with a
`LATENCY_MS=300` pass of the measurement script, watching for the text), and a skeleton the size
of its content does not move what is already on screen.

## Your files

- `apps/web/src/ui/**` (parts, `Loaded`, `Loading`, their tests and the app's own CSS there).
- `apps/web/src/shell/Shell.tsx` and its CSS, only for the sidebar skeleton.
- Screen tests that assert the old loading text: update the assertion to the new accessible
  "Loading" label only, never delete the test or weaken what it checks.

## Screens to measure and photograph

Measure both surfaces in full (the counts must not change). Screenshots of the skeleton itself,
caught mid-load with a request delay (route interception in Playwright that holds `/api/` answers
for 2 s): back-office Home, Runs, a client overview, the agent page; portal Home, Inbox, a run
page. Light and dark, 1440 and 390. Then the same screens loaded, to show nothing moved.
## How you work (the same for every worker in this run)

You are a worker in the speed and structure run of `jammil-alt/countersign` (Mezonas). A lead
session coordinates the run and is the only one that merges. The lead's session id is
`session_01SXdUGAm6RT8JE1EEfcxtfv`.

**Read first, in full:** `CLAUDE.md`, `docs/audit-plan.md` (the plan: your items, "The rules for
every screen", the owner's answers to D1–D6) and `docs/audit-plan-run.md` (gates). Follow
`CLAUDE.md`. Do not edit `docs/audit-plan.md`: the lead owns it.

**Branch.** You are on `speed/skeleton`, cut from `speed/run`. Commit only there and push with
`git push -u origin speed/skeleton`. Never push to `speed/run` or `main`. If the lead asks you to
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
   `speed/skeleton-shots` (never to your PR branch) and link them from the PR.
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
