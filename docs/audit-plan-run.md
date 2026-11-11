# Running the speed and structure plan with agents

How to run `docs/audit-plan.md` with a group of agents that merge their own work. Read the plan
first; this page only says who does what, in what order, and what may merge unattended.

**In one line:** one lead agent with a serial merge queue, workers on their own branches, an
integration branch, and one merge to `main` when every gate is green.

## The set-up

1. **One lead.** It owns `docs/audit-plan.md`: it ticks items, fills in the results table and
   writes down what was skipped and why. It hands out items and is the only one that merges.
2. **Workers on their own branches.** Each takes one item or a small group, opens a PR against
   the integration branch, and attaches what the gates below ask for.
3. **A different agent reviews each PR.** Never the one that wrote it.
4. **An integration branch** (`speed/run`), cut from `main`. Workers' PRs merge into it one at a
   time, each rebased on the last. `main` deploys to staging on every push, so the work reaches
   `main` as one PR, not as many.
5. **Nothing else merges to `main` during a run**, so the integration branch rebases cleanly.

## The order

Follow the plan's phases in order. Within them:

1. **Measure.** Phase 0, on the integration branch. Commit the new baseline.
2. **Foundations, alone.** 1.2 with 1.9 (the cache under `useApi`), then 1.3 (the skeleton
   parts). Nothing else in phases 1 to 3 starts until these are merged.
3. **The front end, by screen.** Each worker gets screens that it alone may touch:

   | Worker | Its files | Items |
   |---|---|---|
   | Portal | `apps/web/src/portal/**` | 1.4 and 1.5 (portal parts), 1.6, 2.1, 2.7 |
   | Back-office agent and client pages | `apps/web/src/ops/client/**`, `ops/agents/**`, `ops/screens/AgentPage.tsx`, `ops/builder/**`, `ops/triggers/**` | 1.4 and 1.5 (back-office parts), 2.5 |
   | Back-office frame and lists | `apps/web/src/ops/OpsLayout.tsx`, `ops/command/**`, `ops/screens/Inbox.tsx` | 1.5 (Home), 2.3 |
   | Polling and search | `apps/web/src/runs/**`, `portal/status.ts`, the two Records screens, `directory/**`, `portal/screens/Contacts.tsx` | 2.2, 2.4 |
   | First load | `apps/web/index.html`, `apps/web/public/_headers`, `apps/web/src/i18n/**`, `session/**`, `App.tsx` | 1.1, 4.1, 4.3, 4.4, 4.5 |

   Where two workers need the same file, the lead gives it to one and queues the other.
4. **Route splitting (4.2), alone**, after the step above: it edits the route files everyone
   else touches.
5. **Lists (phase 3).** 3.1 first and alone (the paging shape and its hook). Then one list per
   worker, web and API together.
6. **The heavy handlers (phase 6).** One worker per route file. 2.6 follows 6.7.
7. **The cron (phase 8).**
8. **Structure (phase 10)**, the items that need no decision: 10.1, 10.5, 10.6, 10.9 without the
   redirects, 10.10, 10.12.

Items that wait on other work or on the owner are in "What never merges unattended" below, with
4.6 (waits on 10.3) and 4.7 (waits on D3).

## What a PR must pass before the lead merges it

- `pnpm check` is green.
- The measurement script (plan, appendix A) run before and after: no screen's API calls or SQL
  statements go up, and the item's "Done when" holds.
- The route sweep: `pnpm --filter @countersign/web sweep`.
- Screenshots of each touched screen, light and dark, at 1440 wide and at phone width, attached
  to the PR. Tests cannot say whether a skeleton looks right; the owner reads these.
- The reviewer's note: what it checked, and that no invariant in `CLAUDE.md` is loosened.

If a gate fails twice, the worker stops, the lead notes the item as skipped with the reason, and
the run goes on. No gate is ever loosened, skipped or rewritten to get green.

## What never merges unattended

These are opened as ready PRs and left for the owner.

| Item | Why |
|---|---|
| 5.1 One transaction per request | It changes sign-in and client scoping (invariant 1). |
| Phase 7 Indexes | Each needs a query plan on a database with real volume, which a local agent does not have. A migration cannot be edited once it reaches `main`. |
| Phase 9 CI and deploy workflows | They are the guards that catch the agents' own mistakes. |
| 1.7 Responses that do not wait for background work | Each move is safe only if something retries a failure; a wrong call leaves a run that never starts. |
| Anything marked Owner's call (D1 to D6) | Not the agents' decision. |

## Merging to `main`

The lead opens one PR from the integration branch to `main` with the report below at the top.

- **Steps 1 to 4 of the order** (front end only, almost no server code): the lead merges it when
  every gate is green on the branch as a whole.
- **Steps 5 to 8** (the API, the cron, structure): the lead leaves the PR ready for the owner,
  unless the owner has said beforehand that it may merge.

Production is untouched throughout: it deploys only from a `v*` tag.

## Before a run

- **A working local database in the agents' environment.** The measurement gate needs the app
  running against Postgres 16 with pgvector and the demo seed. In a fresh cloud container Postgres
  was there but pgvector was not: `apt-get install -y postgresql-16-pgvector`, start the server,
  then the steps in appendix A.
- **Answers to D1 to D6, or a note that they are open.** Steps 1 to 4 wait on none of them.

## The report

The lead writes it at the top of the PR to `main`:

- the results table from the plan, with a row for this run;
- items done (ticked in the plan), with their PRs;
- PRs held for the owner, and why;
- items skipped, and why;
- anything it found that the plan did not know about.

## The lead's brief

Hand this to the lead agent as its task. Name the steps of the order it is to do.

> You are the lead for a run of `docs/audit-plan.md`, steps … to … of the order in
> `docs/audit-plan-run.md`. Read `CLAUDE.md` and both files in full before anything else, and
> follow them.
>
> 1. Cut `speed/run` from `main` (or carry on from it if it exists). Run phase 0 on it and
>    commit the new baseline.
> 2. Do the steps in order: foundations first and alone, then workers by screen. Give each
>    worker its items, the files it alone may touch, and the gates. Workers open PRs against
>    `speed/run`.
> 3. Have a different agent review each PR. Merge one at a time, rebased, only when every gate
>    passes. After each merge, run the measurement and add a row to the results table.
> 4. Before each item, run its "Check". If it no longer holds, tick it with a note and go on.
> 5. Never merge an item from "What never merges unattended": open it as a ready PR and leave it.
>    Never decide an Owner's call. Never loosen, skip or rewrite a test or a gate. If an item
>    fails its gates twice, note it as skipped with the reason and go on.
> 6. At the end, open one PR from `speed/run` to `main` with the report at the top, and merge it
>    or leave it as "Merging to `main`" says.
