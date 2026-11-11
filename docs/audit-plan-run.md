# Running the speed and structure plan with agents

How to run `docs/audit-plan.md` overnight with a group of agents that merge their own work. Read
the plan first; this page only says who does what, in what order, and what may merge unattended.

**In one line:** one lead agent with a serial merge queue, workers on their own branches, an
integration branch overnight, and one merge to `main` at the end if every gate is green. About
three nights, not one.

## Why not all at once

- The plan has 80 items. Most of the front-end work rests on one change (the cache under
  `useApi`, item 1.2) that must land first.
- `main` deploys to staging on every push. Twenty merges overnight are twenty staging deploys,
  and one bad merge breaks staging while nobody is watching.
- Agents working at once collide when they edit the same files.

## The set-up

1. **One lead.** It owns `docs/audit-plan.md`: it ticks items, fills in the results table and
   writes down what was skipped and why. It hands out items and is the only one that merges.
2. **Workers on their own branches.** Each takes one item or a small group, opens a PR against
   the integration branch, and attaches what the gates below ask for.
3. **A different agent reviews each PR.** Never the one that wrote it.
4. **An integration branch per night** (`speed/night-1`, …), cut from `main`. Workers' PRs merge
   into it one at a time, each rebased on the last. At the end of the night it becomes one PR to
   `main`.
5. **Foundations first, alone.** Phase 0 (measure), then 1.2 with 1.9 (the cache), then 1.3 (the
   skeleton parts). Nothing else in phases 1 to 3 starts until these are merged.
6. **Then fan out by screen, not by item.** Each worker gets screens that it alone may touch:

   | Worker | Its files | Items |
   |---|---|---|
   | Portal | `apps/web/src/portal/**` | 1.4 and 1.5 (portal parts), 1.6, 2.1, 2.7 |
   | Back-office agent and client pages | `apps/web/src/ops/client/**`, `ops/agents/**`, `ops/screens/AgentPage.tsx`, `ops/builder/**`, `ops/triggers/**` | 1.4 and 1.5 (back-office parts), 2.5 |
   | Back-office frame and lists | `apps/web/src/ops/OpsLayout.tsx`, `ops/command/**`, `ops/screens/Inbox.tsx` | 1.5 (Home), 2.3 |
   | Polling and search | `apps/web/src/runs/**`, `portal/status.ts`, the two Records screens, `directory/**`, `portal/screens/Contacts.tsx` | 2.2, 2.4 |
   | First load | `apps/web/index.html`, `apps/web/public/_headers`, `apps/web/src/i18n/**`, `session/**`, `App.tsx` | 1.1, 4.1, 4.3, 4.4, 4.5 |

   Route splitting (4.2) runs last and alone: it edits the route files everyone else touches.
   Where two workers need the same file, the lead gives it to one and queues the other.

## What a PR must pass before the lead merges it

- `pnpm check` is green.
- The measurement script (plan, appendix A) run before and after: no screen's API calls or SQL
  statements go up, and the item's "Done when" holds.
- The route sweep: `pnpm --filter @countersign/web sweep`.
- Screenshots of each touched screen, light and dark, at 1440 wide and at phone width, attached
  to the PR. Tests cannot say whether a skeleton looks right; the owner reads these in the morning.
- The reviewer's note: what it checked, and that no invariant in `CLAUDE.md` is loosened.

If a gate fails twice, the worker stops, the lead notes the item as skipped with the reason, and
the night goes on. No gate is ever loosened, skipped or rewritten to get green.

## What never merges unattended

These are opened as ready PRs and left for the owner.

| Item | Why |
|---|---|
| 5.1 One transaction per request | It changes sign-in and client scoping (invariant 1). |
| Phase 7 Indexes | Each needs a query plan on a database with real volume, which a local agent does not have. A migration cannot be edited once it reaches `main`. |
| Phase 9 CI and deploy workflows | They are the guards that catch the agents' own mistakes. |
| 1.7 Responses that do not wait for background work | Each move is safe only if something retries a failure; a wrong call leaves a run that never starts. |
| Anything marked Owner's call (D1 to D6) | Not the agents' decision. |

## The nights

| Night | Work | Merges to `main` on its own |
|---|---|---|
| 1 | Phase 0; phase 1 except 1.7; phase 2 except 2.6; phase 4 except 4.6 and 4.7 | Yes, if every gate is green |
| 2 | Phase 3 (lists: 3.1 first and alone, then one list per worker, web and API together); phase 6 by route file, with 2.6 after 6.7 | Owner looks first (recommended) |
| 3 | Phase 8 (the cron); phase 10 items that need no decision (10.1, 10.5, 10.6, 10.9 without the redirects, 10.10, 10.12) | Owner looks first (recommended) |
| Any | 5.1, phase 7, phase 9, 1.7 | No: PRs waiting for the owner |

Night 1 is where the app starts to feel different, and it changes almost no server code.
Production is untouched throughout: it deploys only from a `v*` tag.

## Before the first night

- **A working local database in the agents' environment.** The measurement gate needs the app
  running against Postgres 16 with pgvector and the demo seed. In a fresh cloud container Postgres
  was there but pgvector was not: `apt-get install -y postgresql-16-pgvector`, start the server,
  then the steps in appendix A.
- **Answers to D1 to D6, or a note that they are open.** Night 1 waits on none of them.
- **Nothing else merging to `main` that night**, so the integration branch rebases cleanly.

## The morning report

The lead writes it at the top of the night's PR to `main`:

- the results table from the plan, with the night's row;
- items done (ticked in the plan), with their PRs;
- PRs held for the owner, and why;
- items skipped, and why;
- anything it found that the plan did not know about.

## The lead's brief

Hand this to the lead agent as its task, with the night's number filled in.

> You are the lead for night N of `docs/audit-plan.md`. Read `CLAUDE.md`, that plan and
> `docs/audit-plan-run.md` in full before anything else, and follow them.
>
> 1. Cut `speed/night-N` from `main`. Run phase 0 on it and commit the new baseline.
> 2. Do the night's work in the order `docs/audit-plan-run.md` gives: foundations first and
>    alone, then workers by screen. Give each worker its items, the files it alone may touch, and
>    the gates. Workers open PRs against `speed/night-N`.
> 3. Have a different agent review each PR. Merge one at a time, rebased, only when every gate
>    passes. After each merge, run the measurement and add a row to the results table.
> 4. Before each item, run its "Check". If it no longer holds, tick it with a note and go on.
> 5. Never merge an item from "What never merges unattended": open it as a ready PR and leave it.
>    Never decide an Owner's call. Never loosen, skip or rewrite a test or a gate. If an item
>    fails its gates twice, note it as skipped with the reason and go on.
> 6. At the end, open one PR from `speed/night-N` to `main` with the morning report at the top.
>    Merge it only if this is a night that merges on its own and every gate is green on the
>    branch as a whole; otherwise leave it ready for the owner.
