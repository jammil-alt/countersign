# Worker `transport`: item 4.7, part two, of docs/audit-plan.md (our own model transport)

You are the `transport` worker of the speed run. Your branch is `speed/transport`. The owner
answered D3 "yes, both": website logins move to their own Worker (another PR, not yours), and our
own transport over `fetch` replaces the Anthropic SDK. You do the second. Its own PR, held for the
owner.

## Your item

Read 4.7 in the plan. Check: `cd apps/api && npx wrangler deploy --dry-run --outdir <dir> --env staging`
(about 13.2 MB, 2.8 MB gzipped at phase 0), and where `@anthropic-ai/sdk` is imported (`git grep`).

Do: replace `@anthropic-ai/sdk` in `packages/llm` with a small transport over `fetch` (the other
providers in that folder, `openai.ts`, `gemini.ts`, `xai.ts`, already do this: follow their shape).
Keep everything the SDK gave that the package uses: the request and response shapes it sends
and reads, headers (`anthropic-version`, the key header), retries on 429 and 5xx with backoff, the
timeout, errors mapped as today, usage and cost tracking, tool use, and whatever streaming or
batch the package uses (check; drop nothing that is used). Record and replay (`LLM_MODE`) must work
unchanged: every recorded fixture under `fixtures/` must replay as it does today. Validate the
model's response with Zod at the boundary (invariant 5). Remove the dependency from every
`package.json` and the lockfile.

You cannot call the live API (no key, and tests never call it). Add tests with a fake `fetch` that
check the exact request (URL, headers, body) for each kind of call the package makes, built from
what the SDK sent: read the SDK's source in `node_modules` to be sure.

Done when: no `@anthropic-ai/sdk` anywhere; the Worker's dry-run size before and after is in the
PR; replay tests and `pnpm check` are green.

## Your files

`packages/llm/**`, the `package.json` files that list the SDK, `pnpm-lock.yaml`. Anything in
`apps/api` only where it imports the SDK directly (tell the lead first if that is more than a few
lines).

## Gates for this item

No screen changes: no screenshots, and the screen measurement must simply not change (run it once
after, for the agent page and portal Home, to show the app still works). Put the Worker size in the
PR instead.

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

**Branch.** You are on `speed/transport`, cut from `speed/run`. Commit only there and push with
`git push -u origin speed/transport`. Never push to `speed/run` or `main`. If the lead asks you to
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
   `speed/transport-shots` (never to your PR branch) and link them from the PR.
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
