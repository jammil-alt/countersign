# Worker `logins`: item 4.7, part one, of docs/audit-plan.md (website logins in their own Worker)

You are the `logins` worker of the speed run. Your branch is `speed/logins`. The owner answered D3
"yes, both": website logins move to their own Worker (yours), and our own transport replaces the
Anthropic SDK (another worker's PR). It changes the Worker's make-up and the deploy, so it is its
own PR, held for the owner.

## Your item

Read 4.7 in the plan, `docs/plan.md` §1.82, ARCHITECTURE §6.9 (the code service) and the browser
connection sections, and `apps/mfa` (README, NOTES, wrangler.jsonc, how `apps/api` reaches it by
the `CODES` service binding, how `deploy.yml` deploys it first). Check: `@cloudflare/playwright` is
imported by `apps/api/src/browser/driver.ts` (and env.ts) and the `BROWSER` (Browser Run) binding
is on `apps/api`; the Worker's dry-run is about 13.2 MB.

Do: a new Worker for website logins and browser tool calls, built the way `apps/mfa` is: its own
`apps/<name>` folder, its own `wrangler.jsonc` with the `BROWSER` binding, its own tests, deployed
before `apps/api` in `deploy.yml`, reached from `apps/api` only by a service binding with a narrow
RPC entrypoint. `apps/api` keeps the decisions (the permission gate, pinned origins, the blocked
tier, the vault read, the audit and the external-action path); the new Worker only drives the
browser for one call and returns the result. Invariant 13 holds exactly: a site login secret is
handed over for one call and never logged, stored or returned; second factors still come only from
`apps/mfa`, handed once; agents never sign in to blocked-tier sites; sign-in is code on pinned
origins, never the model. Name public resources Mezonas (as `mezonas-codes`). Locally, `pnpm dev`
must keep working without the new Worker (as with the code service: browser tools are off
locally), and the existing chromium tests must still run in Node against real Chromium.

Done when: `@cloudflare/playwright` is no longer in `apps/api`'s bundle; the Worker's dry-run size
before and after is in the PR (`cd apps/api && npx wrangler deploy --dry-run --outdir <dir> --env staging`,
and the new Worker's size too); `pnpm check` is green; the deploy order and the new Worker's
bindings and secrets (if any) are written up in `docs/operations.md`.

## Your files

A new `apps/<name>/**`; `apps/api/src/browser/**`, `apps/api/src/env.ts` (the binding types),
`apps/api/wrangler.jsonc` (bindings only), `apps/api/package.json`; `packages/connectors/src/browser/**`
only where the Playwright adapter must move; `.github/workflows/deploy.yml` (the new Worker's deploy
step only; another held PR also edits this file, keep your change small); `scripts/check-deps.mjs`
and `docs/plan.md` §2 for the new app's layering; `docs/operations.md`; `pnpm-lock.yaml`;
`pnpm-workspace.yaml` if needed.

## Gates for this item

No screen changes: screenshots only of the back office's browser sites and scripts screens
(`/ops/utilities` or wherever they are), light, 1440, to show they still load. The screen
measurement must not go up. Put both Workers' sizes in the PR.

## This PR is held for the owner

Your item is in "What never merges unattended" (or is held by the owner's instructions). Open the
PR against `speed/run` and mark it ready when every gate passes, as below, with "Held for the owner"
as the first line of its body and why. The lead will have it reviewed but will not merge it.
## How you work (the same for every worker in this run)

You are a worker in the speed and structure run of `jammil-alt/countersign` (Mezonas). A lead
session coordinates the run and is the only one that merges. The lead's session id is
`session_01SXdUGAm6RT8JE1EEfcxtfv`.

**Read first, in full:** `CLAUDE.md`, `docs/audit-plan.md` (the plan: your items, "The rules for
every screen", the owner's answers to D1–D6) and `docs/audit-plan-run.md` (gates). Follow
`CLAUDE.md`. Do not edit `docs/audit-plan.md`: the lead owns it.

**Branch.** You are on `speed/logins`, cut from `speed/run`. Commit only there and push with
`git push -u origin speed/logins`. Never push to `speed/run` or `main`. If the lead asks you to
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
If `pnpm check` fails at `apps/api/src/browser/chromium.test.ts` with "Executable doesn't exist at
/opt/pw-browsers/chromium_headless_shell-1248/...", the container has another build: fix the
environment, never the test (`ls /opt/pw-browsers` for the build you have):
`mkdir -p /opt/pw-browsers/chromium_headless_shell-1248 && ln -sfn /opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64 /opt/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64`.
For the sweep, `SWEEP_CHROMIUM=/opt/pw-browsers/chromium` also works. `pnpm lint` checks `docs/` too.

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
   `speed/logins-shots` (never to your PR branch) and link them from the PR.
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
