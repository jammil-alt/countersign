# Speed and structure plan (audit of 2026-11-11)

What the audit of 2026-11-11 found, as work to do in order. The audit read the code at commit
`d2e13ae` and ran the app locally on the demo seed, counting API calls and SQL statements per
screen. This file is written to be run later, after other work has landed, by a person or an agent.

**The finding in one line:** the app is slow because each screen makes many small requests, each
request pays about ten SQL statements before it does any work, and polling repeats the heaviest
requests. Slow single queries are a small part of it.

**What comes first (owner, 2026-11-11): how it feels to the person.** The screen shows before the
back end has finished. What was seen a moment ago shows at once and refreshes behind. Long lists
come a page at a time. Fewer statements matter, but they come second: phases 1 to 3 are about what
the person sees, and they are done before the server work in phases 5 to 8.

## How to run this plan

1. **Start with phase 0.** The code will have moved. Measure again and write the new numbers into
   the baseline tables below before changing anything.
2. **Do the phases in order.** Phases 1 to 4 are mostly front end and change what the person
   feels. Phases 5 to 8 change the API, the database and the cron. Phase 9 is CI. Phase 10 is
   structure and can run alongside.
3. **Before each item, check it is still true.** Each item has a "Check" line. File paths and
   function names are from `d2e13ae`; line numbers are left out on purpose. If the check fails
   (someone fixed it, or the code moved), tick the item with a note and go on.
4. **After each phase, measure again** (appendix A) and write the numbers under "Results". A phase
   is done when `pnpm check` is green and its target is met or the miss is explained.
5. **Follow `CLAUDE.md`.** Draft PRs. Migrations, CI and deploy workflows, and sign-in changes
   each get their own PR. Where this plan picks between options, record it in `docs/plan.md` §1
   and leave a `// DECISION:` comment. No item here may loosen an invariant; the ones nearest to
   this work are 1 (client isolation), 8 (approval), 11 (no bundles or cost in the portal) and
   14 (audit).
6. **Stop and ask the owner** at the items marked **Owner's call**. They are listed below.

### The rules for every screen

Every item in phases 1 to 4 is judged against these. A new screen follows them from the start.

1. **The frame first.** The sidebar, the page title and the tabs show without waiting for the
   page's data. Only the session is allowed to hold them back.
2. **Shown before, shown at once.** A screen seen in the last few minutes shows what it showed,
   then refreshes behind. No blank and no "Loading" on the way back from a detail page.
3. **A placeholder the size of the content.** Where data is still coming, a skeleton holds its
   place, so nothing jumps when it arrives. No full-page loading text after the first paint.
4. **The main thing first.** What the person came for loads first. Side panels, counts, charts
   and history load after it, each in its own place.
5. **A press answers at once.** A button shows it was pressed within a tenth of a second. The
   response never waits for work the person does not need to see finished (a Workflow starting, a
   notification going out).
6. **Lists by the page.** No list loads more than 50 rows at first. More come on scroll or on
   "Show more". Sorting and filtering happen on the server.
7. **Honest about writes.** Anything that writes to a client's tools or decides an approval is
   never shown as done before the server says so (invariant 8). It shows "sending", then the
   result.

### Owner's calls

| # | Question | Where it matters |
|---|---|---|
| D1 | May a read-only request write its audit row after the response (in `waitUntil`) instead of inside the request? Invariant 14 and `docs/plan.md` §1.35 say the row is part of the request today. | 5.3 |
| D2 | May memberships be carried in the sealed session cookie for a few minutes, so most requests skip the lookup? It delays a removed member's loss of access by that long. | 5.2 |
| D3 | Move Playwright (website logins) to its own Worker, and replace the Anthropic SDK with our own transport, to cut the 12.4 MB Worker? `docs/plan.md` §1.82 left this to the owner. | 4.7 |
| D4 | Move the Worker-free services out of `apps/api` into new packages? It changes the package list in `docs/plan.md` §2. | 10.2 |
| D5 | Drop the 13 "old address" redirects in the back office, since production has had no release? | 10.9 |
| D6 | The cache in 1.2 is planned as our own small one under `useApi`. If it outgrows that, may a query library (TanStack Query) go under the same hook? It adds a dependency and reverses the `// DECISION:` in `useApi.tsx`. | 1.2 |

## Baseline (2026-11-11, commit `d2e13ae`, local, demo seed)

Counts are exact. Times are not given: local times say nothing about staging. SQL counts leave out
`begin` and `commit`.

### Per screen, fresh load

| Screen | API calls | SQL statements | Same call asked more than once |
|---|---|---|---|
| Back office Home | 4 | 60 | |
| Back office Escalations | 5 | 54 | |
| Back office Runs | 5 | 50 | |
| Back office run page | 5 | 66 | |
| Back office client overview | 11 | 108 | `agents/:id/go-live` ×4 (one per agent) |
| Back office agent page | 11 | 122 | `clients/:id` ×2, `agents/:id` ×2 |
| Agent page, Workflow tab | 17 | 164 | `catalog/events` ×3, `clients?view=names` ×2, `triggers` ×2 |
| Agent page, Versions tab | 21 | 207 | `agents/:id` ×3, `clients/:id/events` ×3, `catalog/events` ×2 |
| Portal Home | 7 | 107 | `/api/overview` ×2 |
| Portal Inbox | 8 | 83 | |
| Portal Runs | 5 | 55 | `/api/overview` ×2 |
| Portal run page | 7 | 79 | |
| Portal agent page | 11 | 149 | |
| Portal agent, Access tab | 8 | 126 | |

### Per screen, moving inside the app

A typical move costs 3 API calls and 35 to 45 statements. `GET /api/ops/counts` fired on 16 of 17
back-office moves. `GET /api/overview` fired on 13 of 13 portal moves, twice on four of them.

### What the person sees today

- `index.html` has an empty `#root`: nothing shows until the 526 kB bundle has run.
- The back office then waits four times in a row: the bundle, `/api/session`, the `OpsApp` chunk,
  the page's data. Home adds a fifth for Recent runs.
- Loading is a line of text (`Loading` in `apps/web/src/ui/primitives.tsx`). There is one
  skeleton in the app (`SidebarAgentSkeleton` in `shell/Shell.tsx`).
- Nothing is kept: going from a list to a row and back loads the list again from nothing.
- The client page's title and figures blank on every tab click.
- No screen uses `startTransition`, `useDeferredValue` or `useOptimistic`.
- Lists arrive whole: runs 100, documents 200, inbox up to 200, contacts and directory all of them.

### Per request

| Request | SQL statements | Response size |
|---|---|---|
| Fixed cost of any session route | 6 (plus 2 `begin`, 2 `commit`) | |
| `GET /api/feedback/status` | 7 | 17 B |
| `GET /api/ops/counts` | 16 | 248 B |
| `GET /api/ops/command-center` | 33 | 22 kB |
| `GET /api/ops/runs/:id` | 28 | 21 kB |
| `GET /api/ops/agents/:id/builder-catalog` | 12 | **595 kB** |
| `GET /api/ops/skills` | 12 | **443 kB** |
| `GET /api/overview` | 14 | 3 kB |
| `GET /api/table` | **40** | 7 kB |
| `GET /api/runs/:id` | 21 | 4 kB |
| `GET /api/access` | 17 | 9 kB |
| `GET /api/services/:id` | 19 | 3 kB |
| `GET /api/inbox?status=resolved` | 9 | **151 kB** |

The fixed cost is two transactions: the user and their memberships, then the scope, the handler
and the audit row. With the local `dev` sign-in one of the six is an email lookup that WorkOS does
not make; `docs/plan.md` §1.84 counts nine with `begin` and `commit`.

### Bundles

| What | Size | Gzipped |
|---|---|---|
| Web, loaded by everyone: `index` + `ui` chunks | 1,877 kB | 526 kB |
| Web, the back office's `OpsApp` chunk | 652 kB | 167 kB |
| Web, `WorkflowBuilder` chunk | 137 kB | 40 kB |
| Web CSS | 89 kB | 17 kB |
| Worker (`wrangler deploy --dry-run`) | 12.4 MB | 2.6 MB |

In the `ui` chunk by source: the six message catalogs 704 kB, core's route contract 429 kB,
react-router 368 kB, zod 362 kB, decimal.js 125 kB. In `index`: react-dom 612 kB, every portal
screen 337 kB. In the Worker: `@cloudflare/playwright` 3.2 MB, `@anthropic-ai/sdk` 3.0 MB, Sentry
about 2.2 MB, pdf-lib 0.8 MB.

### Results

Add a row after each phase. "To content" is the script's `settled` time with `LATENCY_MS=100`
(appendix A): it is not a real-world time, but it shows waits in a row.

| Date | Commit | After phase | Portal Home (calls / SQL / to content) | Portal agent | Ops Home | Ops agent page | Web first load, gzipped |
|---|---|---|---|---|---|---|---|
| 2026-11-11 | `d2e13ae` | baseline | 7 / 107 / 0.8 s | 11 / 149 / 0.8 s | 4 / 60 / 1.1 s | 11 / 122 / 1.0 s | 526 kB |

With 100 ms added per request, a screen that needed one round trip past the session would settle
in about 0.4 s. Moving inside the app at the baseline: portal agent 0.34 s (three calls in a row),
back-office agent page 0.34 s, its Workflow tab 0.46 s; a simple screen 0.12 s (one).

---

## Phase 0: measure again

- [ ] **0.1 Run the measurement** (appendix A) on the current `main`, once plain and once with
  `LATENCY_MS=100`. Replace the baseline tables above if the numbers moved by more than a tenth,
  fill in "to content", and note the commit.
- [ ] **0.2 Check each phase's items** against the code and tick what is already done.
- [ ] **0.3 Ask the owner** for answers to D1 to D6, or note that they are still open. Only the
  items that name one wait on it.

---

## Phase 1: the screen shows first

Target: the frame paints without waiting for page data; a screen seen in the last five minutes
shows its content at once; no full-page loading text after the first paint; a press answers
within a tenth of a second.

- [ ] **1.1 Something on screen before the bundle runs.**
  Check: `apps/web/index.html` has an empty `#root`.
  Do: put a still frame inside `#root` (the page colour, the sidebar's shape, the mark), styled
  from the main stylesheet with the design system's tokens, in both themes. React replaces it on
  mount. No script is needed, so the CSP is untouched.

- [ ] **1.2 A cache under `useApi`: show what is known, refresh behind.**
  Check: `apps/web/src/api/useApi.tsx` fetches on every mount, keeps nothing, and two components
  asking the same route each make a request.
  Do: keep the hook's signature (229 call sites) and put a store under it, keyed by route and
  options:
  - a mounted hook gets the stored answer at once and a refresh behind it (`loading` stays false
    when there is data; add `refreshing` for the few places that show it);
  - identical `GET`s in flight share one request;
  - **any successful write marks every stored answer stale.** Stale answers still show, and are
    refreshed the next time a screen uses them. This is the whole invalidation rule; it is
    simple and it cannot leave a screen wrong for longer than one request;
  - an answer older than five minutes is not shown: the skeleton is, as on a first visit;
  - a route may opt out (`cache: "none"`): anything that returns a short-lived link or a
    one-time value (signed document links live five minutes; second-factor and vault routes);
  - `prefetch(route, options)` fills the store without a component (1.6).
  Safety, not optional: the store lives in memory only, never `localStorage`, `sessionStorage` or
  IndexedDB (it holds client data). It is emptied on sign-out, on a session change, on the idle
  lock, and when the operator's client changes. The key includes the active client.
  Tests: a fake-fetch test for each bullet, and one that a second user's session never sees the
  first's answers.
  If it grows past about 300 lines, or paged lists (3.1) do not fit it cleanly: **Owner's call
  (D6)**.
  Done when: list → row → back shows the list at once; the Workflow tab asks `catalog/events`
  once.

- [ ] **1.3 Skeletons in place of "Loading".**
  Check: `Loaded` (`apps/web/src/ui/page.tsx`) shows the `Loading` text; the loading, error, data
  triple is written by hand in 60 or more places.
  Do: `Skeleton` parts built from the design system's tokens (a line, a card, table rows, a stat):
  no new colours, radii or shadows; both themes; no motion when the person asks for reduced
  motion. `Loaded` takes a `skeleton` and uses it. Each screen passes one shaped like its
  content. Move the hand-written triples to `Loaded` as each screen is touched.
  Done when: no screen shows the loading text after the frame is up, and content arriving does
  not move what is already on screen.

- [ ] **1.4 The frame does not wait for the page.**
  Check: `ClientFrame` (`apps/web/src/ops/client/ClientFrame.tsx`) sits inside each client
  screen, so a tab click remounts it and its title falls back to "Client"; the agent pages
  (`ops/screens/AgentPage.tsx`, `portal/screens/Agent.tsx`) show nothing until the agent loads.
  Do: make `ClientFrame` a layout route with `<Outlet />` above the `clients/:clientId/*` routes
  (keep every `path="…"` line: the route sweep reads them). On agent, run and client pages, draw
  the title, tabs and back link at once from what is already known (the list row that was
  clicked, the cached list, the session's client names) and fill in the rest.
  Done when: clicking through the client tabs keeps the header still and makes no
  `GET /api/ops/clients/:id`.

- [ ] **1.5 The main thing first, the rest after.**
  Check: these screens hold everything until one call returns, or load side panels with the
  main content:
  - portal Home (`portal/screens/Home.tsx`): overview, access and weekly wait on `portalTable`;
    `portalAccess` (17 statements) is loaded for tool icons;
  - portal agent (`portal/screens/Agent.tsx`): three levels deep;
  - portal run page (`portal/screens/RunTimeline.tsx`): inbox, other runs and audit wait on the run;
  - back-office Home (`ops/command/CommandCenter.tsx`): Recent runs sits inside `<Loaded>`;
  - back-office agent page (`ops/agents/AgentScreen.tsx`): `builder-catalog` (595 kB) loads on
    Overview though only the Workflow and Settings tabs use all of it.
  Do: start every call that needs only the route's ids together, in the top component. Give each
  section its own `Loaded` and skeleton so the main content never waits for a side panel. Load
  tab-only data when its tab opens (and prefetch it on hover, 1.6).
  Done when: with `LATENCY_MS=100`, each of these screens shows its main content after one round
  trip past the session.

- [ ] **1.6 Fetch on intent.**
  Do: on hover or focus of a row or link that opens a detail page (runs, inbox items, agents,
  clients, documents), call `prefetch` for that page's first call and start its chunk's
  `import()`. On Home, prefetch the Inbox once Home has settled. Limit: one prefetch per target,
  none on touch scroll, none in a hidden tab.

- [ ] **1.7 The response does not wait for background work.**
  Check: `inScope` in `apps/api/src/http.ts` awaits every `afterCommit` task before it answers.
  There were 17 uses at the audit: starting a Workflow instance (`run-controls.ts`,
  `ops-agents.ts`, `lifecycle.ts`), resuming a run after a decision (`portal.ts`, `desk.ts`,
  `step-in.ts`), sending notifications now (`notify.ts`), QuickBooks sync start (`qbo.ts`).
  Do: go through each. Move it to `defer` (after the response) when both hold: the answer does
  not report its result, and something already retries it if it fails (for decisions,
  `redeliverResolutions` in `apps/api/src/runs/resume.ts` does). Where nothing retries a failed
  start, add the sweep first or leave the task where it is. Record each choice.
  Done when: signing a change answers as soon as it is committed.

- [ ] **1.8 A press answers at once.**
  Do, by kind of action:
  - **Reversible and internal** (snooze, mark read, a filter, a sort, a settings switch, a
    rename): change the screen at once with `useOptimistic`, put it back with a plain message if
    the server refuses.
  - **Decisions and writes to a client's tools** (sign, approve, reject, send, activate, publish):
    never shown as done early (rule 7). The button turns to "Sending" at once and cannot be
    pressed twice; the card closes and the next one opens when the server answers. With 1.7 that
    answer is quick.
  - **Long work** (test runs, exports, sync now, imports, document reading): the route answers
    with the job's state; the screen shows progress in place and stays usable. Check that none of
    these routes waits for the job itself.
  - **Typing and filtering**: wrap list updates in `startTransition` so the input never lags;
    keep the old rows, dimmed, while new ones load.

- [ ] **1.9 A failed refresh keeps the page.**
  Check: a failed call in `useApi` drops `data`; run pages then stop polling because `going` is
  read from `data`. On a key change the last entity's data shows under the new id.
  Do: keep `data` when a refresh fails and show the error beside it; store the key with the data
  and never show another key's data (the skeleton instead). Both fall out of 1.2; test both.

---

## Phase 2: the front end asks less

Target: no screen asks the same route twice on load; a move between tabs of one page asks only
for that tab's data; portal Home 5 calls or fewer; back-office agent page 8 or fewer. Much of this
is settled by the cache in 1.2; these items are what is left.

- [ ] **2.1 The portal shares one overview.**
  Check: `PortalApp.tsx` loads `portalOverview`, reloads it on every route change and every 20 s;
  `portal/screens/Home.tsx` and `portal/screens/Runs.tsx` ask for it again.
  Do: with 1.2 the screens read the shell's answer. Refresh on a route change only if the stored
  answer is older than a few seconds.
  Done when: `/api/overview` is asked once per load and at most once per move.

- [ ] **2.2 Waiting on a person is not "running".**
  Check: `isRunGoing` (`apps/web/src/runs/format.ts`) and `runOpen` (`apps/web/src/portal/status.ts`)
  count `waiting`. Run pages poll every 2 s and run lists every 5 s while any run waits.
  Do: poll fast only for `queued` and `running`. For `waiting`, poll every 30 s.
  Done when: a run page left open on a waiting run makes 2 requests a minute, not 30.

- [ ] **2.3 Escalations and the frame count Needs us once.**
  Check: `ops/OpsLayout.tsx` polls `/api/ops/counts` and reloads it on every route change, agent
  tab clicks included; `ops/screens/Inbox.tsx` also polls `opsNeedsUs`.
  Do: have Escalations call `useShareCounts` as the command center does; reload counts on a route
  change only when the first path segment after `/ops` changes.

- [ ] **2.4 Search boxes wait for typing to stop.**
  Check: `portal/screens/Contacts.tsx` and `directory/DirectoryPanel.tsx` call the API on every
  keystroke; both Records screens carry the same copied 300 ms effect.
  Do: one `useDebounced` hook, used by all four.

- [ ] **2.5 Catalogs asked once.** `opsEventCatalog`, `opsBuilderCatalog`, `connectors`,
  `opsConnectors`, `opsModels`, `opsClients?view=names`: after 1.2, check each is asked once per
  page and give them a longer life in the store (they change only on a deploy or a pack switch).

- [ ] **2.6 Per-agent calls on the client overview.** `ClientOverview.tsx` asks `go-live` once
  per agent. Needs 6.7 (the stage in the `opsClient` answer); listed here so the screen is not
  forgotten.

- [ ] **2.7 Polls that never stop.** `portal/screens/Upload.tsx` checks each unread document
  every 3 s for up to 40 tries and does not pause in a hidden tab; `portal/screens/Sloan.tsx`
  polls every 3 s with no limit while the last message is the person's. Use `usePoll` and back
  off.

---

## Phase 3: long lists

Target: every list loads 50 rows or fewer at first; sorting and filtering are done by the server;
a list of a thousand rows scrolls smoothly. Web and API change together here, a list at a time.

- [ ] **3.1 One way to page.**
  Check: three styles exist (`limit`+`offset` in records, `before`+`limit` by time in threads,
  `before` by id in the audit log); most lists have none and rely on a fixed `.limit(200)` or
  `.limit(500)` in the handler (16 places).
  Do: one shape in the contract (`packages/core`): `limit` (default 50, most 100) and an opaque
  `cursor` in; `items` and `nextCursor` out; `sort` and the filters as query fields. Cursors are
  by `(sort value, id)`, not offsets, so new rows do not shift pages. On the web, one
  `usePagedApi` hook over the store in 1.2 (pages appended, the first page cached) and one
  `LoadMore` part (a button, with loading on scroll near the end).

- [ ] **3.2 Move the lists to it, the longest and most used first.**
  Check each still loads whole, then move it. In order:
  1. Runs, both surfaces (`ops/screens/Runs.tsx`, `portal/screens/Runs.tsx`; `opsRuns`,
     `portalRuns`): today the latest 100, sorted in the browser, so "sort by cost" orders only
     those 100.
  2. Inbox, both surfaces (`portalInbox`, `opsInbox`): up to 200 whole rows with payloads. The
     portal's resolved list has no limit (151 kB on the demo seed) and shows five: load it only
     when Done opens, a page at a time, and return "done this week" as a count with the open list.
  3. Documents (`ops/screens/Documents.tsx` asks for 200).
  4. Contacts and Directory (`portal/screens/Contacts.tsx`, `directory/DirectoryPanel.tsx`): no
     limit; search on the server.
  5. Back-office Home's All agents table (`ops/command/CommandCenter.tsx`): every agent of every
     client in one table.
  6. Requests (200 or 500), feedback (500), conversations, clients, statements
     (`portalBilling` loads every statement).
  The audit log and Records already page; move them to the shared shape when touched.

- [ ] **3.3 Counts without loading the rows.** Tabs and badges that need "how many" get a count
  from the server (`count(*)`), not the length of a loaded list. `record-list.ts` recounts all
  four tabs on every page change: count only the open tab then.

- [ ] **3.4 Draw only what is on screen.** For tables that can pass a few hundred rows on screen
  after "Show more" (runs, audit log, directory, the all-agents table), draw only the visible rows
  (a small windowing hook, or `content-visibility: auto` on rows where that is enough). Measure
  first with 1,000 seeded rows; skip a table that scrolls well without it.

- [ ] **3.5 Each page keeps its place.** Going to a row and back returns to the same scroll
  position and the same loaded pages (from the store), not the top of page one.

---

## Phase 4: the first load is lighter

Target: web first load under 300 kB gzipped for the portal; hashed files are never asked for
twice; no chunk over 300 kB.

- [ ] **4.1 Load one language.**
  Check: `apps/web/src/i18n/catalog.ts` imports all six catalogs.
  Do: keep `en` in the bundle; `import()` the others when the session's language is known.
  Done when: the `ui` chunk no longer contains `de`, `es`, `fr`, `it`, `pt-BR`.

- [ ] **4.2 Split by route.**
  Check: the only lazy boundaries are `OpsApp` and `WorkflowBuilder`. `ops/routes.tsx` imports
  about 70 screens, 17 of them Marketing; the portal's screens are all in the entry.
  Do: `lazy()` per group: portal Home and Inbox stay in the entry; the rest of the portal by
  screen; the back office by area (agents, skills, clients, each pack, utilities). The Suspense
  fallback is the page's skeleton inside the frame (1.3), never a blank. Keep the `path="…"`
  lines in place. Screen tests render lazy chunks; watch the 20 s test timeout.
  Done when: the build prints no size warning.

- [ ] **4.3 Start the session call and the back-office chunk early.**
  Check: `App.tsx` imports `OpsApp` only after `RequireSession` passes, which is after
  `/api/session` returns, which starts in an effect after the bundle runs (`session/session.tsx`).
  Do: start the session fetch before React mounts, and start the `OpsApp` import at module load
  when the path begins `/ops`. The frame's first calls (`opsClients?view=names`, the overview)
  can start with the session call and be dropped if it refuses.

- [ ] **4.4 Cache hashed files for good.**
  Check: `curl -sI https://staging.mezonas.com/assets/<file>.js` shows
  `Cache-Control: public, max-age=0, must-revalidate` (seen locally under `wrangler dev`; it is
  Cloudflare's default for static assets).
  Do: add to `apps/web/public/_headers`: `/assets/*` with
  `Cache-Control: public, max-age=31536000, immutable`. The `/*` security headers must still apply
  to those files; check with `curl` on staging.

- [ ] **4.5 Preload the two fonts** (`packages/design-system` Geist files, about 57 kB each) from
  `apps/web/index.html`, so text does not wait for the CSS to be parsed. The design system's own
  files stay as delivered.

- [ ] **4.6 The web takes less of core.** Needs 10.3 (subpath exports). Then check with a source
  map which of core's 429 kB route contract and 125 kB of decimal.js the entry really needs.

- [ ] **4.7 The Worker's size. Owner's call (D3).**
  Check: `cd apps/api && npx wrangler deploy --dry-run --outdir <dir> --env staging` reports about
  12.4 MB. Playwright is used only for website logins; the Anthropic SDK only for the transport.
  A cold Worker made about a third of requests wait 1 to 2.8 s (`docs/plan.md` §1.82).
  Do, if the owner agrees: website logins in their own Worker behind a service binding (as
  `apps/mfa` is); our own transport over `fetch` in `packages/llm`. Each is its own PR.

---

## Phase 5: each request costs less

Target: the fixed cost of a session route falls from two transactions to one.

- [ ] **5.1 One transaction per request.** Its own PR (sign-in).
  Check: `mountWith` in `apps/api/src/http.ts` calls `getSession` (which runs `userWithMemberships`
  inside `withUser`), then opens a second transaction in `inScope`.
  Do: open one transaction; set `app.user_id`, read the user and memberships, work out the scope,
  then set `app.tenant_ids` and `app.operator` and clear `app.user_id` in that same transaction
  before the handler runs. The handler must never run with `app.user_id` set. Refusals still
  write their audit row alone. `invokeRoute` (the MCP path) follows the same shape.
  Done when: `packages/db/src/scope.test.ts` and `rls.test.ts` pass with a new test that the
  handler's statements see only the scoped clients, and a plain `GET` logs one `begin`.

- [ ] **5.2 Memberships in the cookie. Owner's call (D2).** Only if 5.1 is not enough. Not
  recommended before a release: it changes when a removed member loses access.

- [ ] **5.3 The audit row for reads. Owner's call (D1).**
  Check: `auditInTx` in `apps/api/src/audit.ts` inserts inside the request for every route,
  reads included; a 2 s poll writes 30 rows a minute.
  Options: leave it (after phases 1 and 2 the requests are far fewer); or write the row for
  `GET`s in `waitUntil`, reporting a miss to Sentry. Writes keep their row in the transaction
  either way.
  Do first: after phases 2 and 5.1, count `audit_event` rows per hour on staging and bring that
  number to the owner.

- [ ] **5.4 Fold tiny routes into ones already asked.** `GET /api/feedback/status` (17 bytes,
  7 statements, every portal load) belongs in the session or overview answer.

- [ ] **5.5 Let the browser skip unchanged answers.** For the polled routes that stay (counts,
  overview, a waiting run), answer with an `ETag` of the content and `304` when it matches, so a
  poll that found nothing new costs no parsing and no re-render. The cache in 1.2 keeps its data.

---

## Phase 6: the heavy handlers

Target: no polled handler over 15 statements; no handler whose count grows per agent, per KPI,
per connection or per line. `docs/plan.md` §1.82 asked independent reads together in four
back-office routes; this phase does the same everywhere else. Reads asked together must not
change the scope while they are in flight. Where a screen needs one fast part and one slow part,
split the route so the fast part is not held back (rule 4), rather than making one large answer.

- [ ] **6.1 Portal Home's table** (`apps/api/src/routes/table.ts`, `portalTable`; 40 statements,
  polled every 20 s).
  Check: `activity()` (`routes/usage.ts`) runs twice; a `for` loop over agents reads the latest
  run, then the run's whole bundle and step; `weekKpis` (`apps/api/src/kpi/view.ts`) loads each
  live bundle again and runs one query per KPI.
  Do: one `Promise.all` for the fixed reads; one query for every agent's latest run and current
  step (`DISTINCT ON` or lateral); one query for the `clientView` part of the live bundles; a
  slim count in place of the second `activity()`. If the KPIs stay slow, serve them from their
  own route so the agents show first.

- [ ] **6.2 Run pages** (`opsRun` in `routes/ops-clients.ts`; `portalRunView` in
  `routes/portal.ts`).
  Check: the version bundle is loaded twice in the back office; the portal reads the run row
  three times; whole `tool_call` rows with `input` and `output` are selected.
  Do: read the run row, then ask the rest together and pass the bundle down. Add a light
  "status and updated at" route; the page polls that and reloads the full view only on a change.

- [ ] **6.3 Run lists** (`opsRunViews` in `routes/ops-clients.ts`).
  Check: it selects `agent_version.bundle` whole for every version in the list, to show a
  workflow name and an error step. Home polls this every 10 s.
  Do: select the names with a JSON path, and select the `run` columns the list shows.

- [ ] **6.4 Portal overview** (`portalOverview` in `routes/portal.ts`): ask its reads together;
  `count(*)` instead of selecting every open inbox id; see 7.3 for its events scan.

- [ ] **6.5 Portal access** (`routes/access.ts`, `apps/api/src/access/release.ts`).
  Check: `vaultItems` calls `releaseView` per connection; `releasePeople` looks up one contact
  per member; the tenant row is read twice.
  Do: call `liveReleases` once for all connections; one `inArray` for contacts. Home needs only
  tool icons: give it those from a cheaper answer.

- [ ] **6.6 Portal agent page.**
  Check: `portalService` (`routes/usage.ts`) loads the whole live bundle for one boolean;
  `portalServiceView` loads it again; the page (`portal/screens/Agent.tsx`) calls `portalTable`
  to read one agent's stage.
  Do: `portalService` returns the stage, `readsDocuments` and the KPIs from one projection of the
  bundle; the page drops `portalTable`. Invariant 11: no bundle, prompt or cost in the answer.

- [ ] **6.7 Back-office client page.**
  Check: `agentActivity` in `routes/ops-clients.ts` is five reads in a row, one over all of the
  client's runs; the overview screen then asks `go-live` once per agent.
  Do: ask together, a lateral `limit 1` per agent, and return each agent's stage in `opsClient`
  so `ClientOverview.tsx` makes no per-agent call (2.6).

- [ ] **6.8 Names on inbox cards** (`apps/api/src/change-names.ts`, `syncedRefNames`;
  `packages/connectors/src/qbo/names.ts`).
  Check: up to 40 `payload @> …` scans of `raw_record` per answer, with no index for them.
  Do: name accounts from `ledger_account` and items by `raw_record.external_id` with one `IN`
  query each; keep the containment scan as the fallback.

- [ ] **6.9 Whole bundles for small facts, elsewhere.**
  `agentUses` in `routes/ops-skills.ts` (every version of every agent, to list skills);
  `updateInfo` in `packages/agents/src/registry/lineage.ts` still called by `opsAgent` (use
  `versionsBehind`); `opsUsedBy` in `routes/ops-lineage.ts` (two bundles per fork in a loop).

- [ ] **6.10 Large answers.** `builder-catalog` 595 kB and `/api/ops/skills` 443 kB: find what
  fills them (likely full tool schemas or skill bodies) and send summaries, with the detail on
  demand when a step or a skill is opened.

- [ ] **6.11 The tenant row once per request.**
  Check: `tenantRow`, `tenantLocale`, `clientTimezone`, `leadOf`, `vaultSetup` and others each
  select from `tenant` again in the same request.
  Do: a per-transaction memo, or load it in the scoped context that `mount` hands the handler.

- [ ] **6.12 Per-line queries in packs.** `reviewLines` in `packs/materials/src/reports.ts` (two
  queries per invoice line; the same shape in `pricing/record.ts` and `purchasing/requests.ts`);
  statement lines one statement at a time in `apps/api/src/routes/billing.ts`.

- [ ] **6.13 The gate's reads during a run** (`packages/agents/src/runtime/call-tool.ts`,
  `registry/runtime-store.ts`).
  Check: each connector tool call opens three to five transactions (connection, grant, autonomy,
  stage, approval routing).
  Do: one store method that reads them in one transaction. They must still be read fresh on
  every call (invariants 8 and 13): do not cache.

- [ ] **6.14 The marketing collector** (`apps/api/src/routes/pack-inbound.ts`,
  `packs/marketing/src/measure/collect.ts`): about 13 statements and two transactions per page
  view on a public route. One transaction; select the salt before inserting it.

---

## Phase 7: indexes

Its own PR: a new migration after the latest (0042 at the audit; never edit an old one).
**Every index here is a guess from reading the schema.** Before adding one, run the query with
`EXPLAIN (ANALYZE, BUFFERS)` on a database with real volume (staging, or the demo seed grown
tenfold) and keep only those that change the plan. The cursors in 3.1 need an index on each
list's sort; add those here too.

- [ ] **7.1** `run (tenant_id, created_at desc)`: every "latest runs of a client" list.
- [ ] **7.2** `step_run (tenant_id, finished_at)`: Home's recent steps. Give that query a time
  bound as well.
- [ ] **7.3** `event (tenant_id, type, created_at)`: `latestHealthSummary` in
  `routes/supervisor.ts` walks a client's events backwards on every overview poll.
- [ ] **7.4** `external_action (tenant_id, executed_at)`: `toolChanges` and `activity`.
- [ ] **7.5** `doc_extraction (tenant_id, created_at)`: the existing index is partial
  (`agent_version_id is null`). The join on `d.id::text = r.trigger->>…` in `routes/usage.ts`
  also defeats the primary key.
- [ ] **7.6** `tool_call`: a partial expression index on `(tenant_id, (input->>'documentId'))
  where tool = 'docs.match_bill'`, for `documentMatches` in `routes/documents.ts`.
- [ ] **7.7** The command center's `retried` subquery groups every step run with more than one
  attempt, with no date bound: bound it.

---

## Phase 8: the cron

Target: an idle client costs no transaction of its own per tick.

- [ ] **8.1 Look before opening a transaction per client.**
  Check: `cronTick` in `apps/api/src/runs/dispatch.ts`, with `lifecycleTick`, `notifyTick`,
  `reachOutTick` and `raiseCodeAlerts`, opens about ten transactions per client every minute.
  Do: one query across all clients (`withTenants`) for who has undispatched events, due
  reach-outs, pending resolutions or ended pauses; open per-client transactions only for those.
- [ ] **8.2 Schedules without bundles.** `routableAgents` loads every live bundle each minute to
  read schedule triggers: select only the triggers, or keep them in a small table written when a
  version goes live.
- [ ] **8.3 Read the client list once per tick, and leave out retired clients.**
- [ ] **8.4 One failing job never skips the next.** `billingTick` in `apps/api/src/app.ts` is the
  one job without a `.catch`. Better: a small job table (name, when it is due by its last run,
  its own error handling) in place of the long function. Due-by-last-run also covers a missed
  minute, which `getUTCMinutes() === N` does not.
- [ ] **8.5 QuickBooks connections in one query.** `qboConnectionsFor` in `routes/qbo.ts` opens a
  transaction per client for each webhook and every 15 minutes. Move the cron function out of
  `routes/` while there (10.1).

---

## Phase 9: CI and deploy guards

Its own PR (workflows).

- [ ] **9.1** Set `COUNTERSIGN_REQUIRE_DB=1` in `.github/workflows/checks.yml`.
  `packages/db/src/testing.ts` says CI sets it; no workflow does, so database tests can skip
  without failing.
- [ ] **9.2** `cancel-in-progress: false` for the deploy group in `deploy.yml`: a second push can
  cancel a deploy between the migration and the Worker.
- [ ] **9.3** Pin `pnpm/action-setup` to a commit in `deploy.yml` and `add-operator.yml` as
  `checks.yml` does; pin `neonctl` to an exact version.
- [ ] **9.4** Drop `--if-present` from `db:migrate` in `deploy.yml`: a renamed script would
  silently do nothing.
- [ ] **9.5** Faster database tests: migrate once into a template database and create each test
  database from it (`createTestDatabase` in `packages/db/src/testing.ts`), instead of replaying
  every migration per file.
- [ ] **9.6** A size check in CI: fail the web build when the first load passes the target in
  phase 4, so it does not creep back.

---

## Phase 10: structure and consistency

Each item is its own PR. None changes behaviour; each ends with `pnpm check` green. Order within
the phase is by how much later work it makes easier.

- [ ] **10.1 Routes only parse, call and shape.**
  Check: services import from `apps/api/src/routes/` (19 times at the audit, e.g. `tenantLocale`
  from `routes/language`, `todayIn` from `routes/usage`); route files import each other 66 times.
  Do: move whatever a non-route file imports out of `routes/` first. Then add a rule to
  `scripts/check-deps.mjs`: nothing outside `routes/` imports from it.

- [ ] **10.2 Domain code out of the Worker app. Owner's call (D4).**
  Check: `apps/api/src` holds about 33k lines of services outside `routes/`; about half import
  nothing from the Worker (`converse/service.ts`, `reach/service.ts`, `exports/tables.ts`,
  `billing/ledger.ts`, `kpi/`). They have no tests of their own.
  Do: two or three platform packages (people and messaging; billing and usage; lifecycle and
  desk). They throw domain errors; `toHttpError` maps them. Update `docs/plan.md` §2 and
  `check-deps.mjs`. Add unit tests beside each service as it moves.

- [ ] **10.3 Core by subpath.**
  Check: `packages/core` exports about 2,400 names through one `index.ts`; `api/routes.ts` is
  over 2,000 lines.
  Do: add `exports` for `core/api`, `core/workflow`, `core/i18n` and the rest; finish splitting
  `api/routes.ts` by family. Move what is not types or rules to where it is used: server copy
  (`i18n/`), `mappers/qbo.ts`, `messaging/a2p.ts`.

- [ ] **10.4 One pack contract, and a back-office registry.**
  Check: `PackTool`, `defineTool`, `PackReport` and `PackReviewHandler` are copied into each pack
  and differ; `apps/api/src/packs.ts` takes the shared types from `@countersign/pack-materials`;
  `apps/web/src/ops/routes.tsx` imports each pack's screens by name while the portal uses
  `apps/web/src/packs/registry.ts`; `apps/api/src/mcp/ops-tools.ts` hard-codes `marketing_report`;
  `packages/agents/src/tools/web.ts` names a pack (`MARKETING_RESEARCH`).
  Do: the contract in one place every pack may import (`packages/core` is allowed by the
  layering); a back-office screen registry like the portal's.

- [ ] **10.5 Shared shapes in the contract.**
  Do: export `Timestamp` (validated), `Day`, `Usd`, `Money`, `ClientId` and the `Page` shape of
  3.1 from core; use them in every route; have `checkRouteContract` refuse a bare `z.string()`
  for a field ending in `At`. Settle `:id` against `:clientId` in client paths.

- [ ] **10.6 One helper for each small thing.**
  Check: `utcDay`, `isoDay`, `dayOf`, `iso` and `today` are each defined several times; some
  `today()` are UTC where `todayIn(timezone)` exists. `notFound("client")` after a select is
  written out 45 times; `ensureClient` is called by hand about 120 times.
  Do: `core/time` for days and ISO text, and go through each UTC `today()` to see whether the
  client's day was meant; `loadClient` and `loadConnection` helpers; `mount()` calls
  `ensureClient` itself when the path has `/clients/:id`.

- [ ] **10.7 One OAuth client for the connectors.**
  Check: code exchange and refresh are written out in eleven connectors;
  `packages/connectors/src/gdrive/index.ts` and `gsheets/index.ts` hold the same block.
  Do: `oauth2Client({ tokenUrl, clientAuth, quirks })` giving exchange, refresh and an authorised
  JSON call with retry; a Google preset for the four Google connectors. Do this before any new
  connector.

- [ ] **10.8 The web's shared parts.**
  One `surfaceRoutes(surface)` per feature in place of "two hooks, one null"
  (`directory/DirectoryPanel.tsx`, `contacts/ContactsPanel.tsx` and seven more). Split the files
  over 1,000 lines by tab or part (`WorkflowBuilder.tsx`, `Inspector.tsx`, `DirectoryPanel.tsx`,
  `DeskDetail.tsx`, `RunView.tsx`). `Table`, `SortableTable` and `Dialog` primitives (the table
  takes the paging of 3.1 and the skeleton of 1.3); one `RunSteps` in place of four `stepState`.
  One decision card: `desk/DeskDetail.tsx` and `inbox/InboxCard.tsx` both decide an inbox item.
  Write down when to use a design-system class, an app class or Tailwind (today about four
  fifths of class names are Tailwind alone). In the workflow builder, every keystroke re-checks
  and redraws the whole bundle (`WorkflowBuilder.tsx`, about 20 `useState` in one component, no
  `memo` anywhere in the app): profile it, then keep the open step's edits local and memoise the
  canvas nodes.

- [ ] **10.9 Residue.**
  Marker-only comments (`// v0.12 W2-C`, `// P-7`; about 325): remove, `git blame` keeps the
  history. Unused and file-local exports: run knip in CI. `apps/web/src/runs/StepMark.tsx` is
  imported nowhere. `describeError` in `apps/web/src/api/client.ts` reads two error shapes the
  server never sends; its header comment mentions routes that have since moved to core. The
  money helpers in `packages/core/src/money.ts` are used only by tests. The "old address"
  redirects: **Owner's call (D5)**.

- [ ] **10.10 Docs that agree.**
  "Migrations through" says 0040 in `CLAUDE.md`, 0038 in `docs/open.md`; the folder ends at 0042.
  `docs/plan.md` has two `### 1.83` and its opening status still says Phase 1. §2 lists one pack
  of three. Keep the status in one place, renumber the second 1.83 (code comments cite both), and
  write ARCHITECTURE v0.16 before more area work.

- [ ] **10.11 Stored JSON is parsed, not cast.** About 127 `as unknown as` outside tests, e.g.
  `apps/api/src/reach/service.ts` and `calls/store.ts`. Type the columns with `$type<>` and parse
  on read where the shape has changed between versions (invariant 5).

- [ ] **10.12 Name the folder for what it is.** `packages/agents/src/log/` is where the package
  may import `db` (twelve data ports, oversight, stores), not a log. Rename it and update
  `check-deps.mjs`.

---

## Not in this plan

- Keeping client data in the browser between visits (`localStorage`, IndexedDB, a service
  worker). The cache in 1.2 is memory only, on purpose.
- Server push (WebSockets, server-sent events) in place of polling. Fewer and cheaper polls come
  first; revisit if run pages still feel behind.
- Taking the connectors live. `docs/open.md` already lists that every provider runs against a
  fake; it matters more than anything here but it is setup and verification, not this work.
- Anything that loosens an invariant to save a statement or a wait.

---

## Appendix A: how to measure

Counts per screen come from a browser driving the app while Postgres logs every statement.

1. A local database with the demo data (`docs/local-development.md`):

   ```bash
   PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres \
     CS_OWNER_PASSWORD=cs_owner CS_WORKER_PASSWORD=cs_worker scripts/setup-postgres.sh
   ```

   ```bash
   SEED_DEMO=1 SEED_E2E=1 DIRECT_DATABASE_URL=postgresql://cs_owner:cs_owner@localhost:5432/countersign pnpm db:seed
   ```

2. Log every statement (as a Postgres superuser). Put it back afterwards with `alter system reset`.

   ```bash
   psql -c "alter system set log_statement='all'" -c "alter system set log_line_prefix='%m [%p] '" \
        -c "alter system set log_connections=on" -c "select pg_reload_conf()"
   ```

3. Run the app: `pnpm dev` (port 8787). The cron does not fire under `wrangler dev` unless asked,
   so it adds nothing to the counts.

4. Save the script below outside the repo and run it once per surface. It signs in with the `dev`
   adapter, loads each screen fresh and then again by moving inside the app, and prints API calls,
   SQL statements, repeated calls, the first paint (fresh loads) and when the last call finished.
   Set `LOG` to the Postgres log file and the three ids to rows in your database
   (`GET /api/ops/clients`, `GET /api/ops/runs?client=…`, `GET /api/ops/clients/:id/agents`).
   `LATENCY_MS=100` adds a delay to every request, which turns waits in a row into visible time.

   ```bash
   CLIENT_ID=… RUN_ID=… AGENT_ID=… node measure.mjs ops ops.json
   ```

   ```bash
   CLIENT_ID=… RUN_ID=… AGENT_ID=… node measure.mjs portal portal.json
   ```

   ```js
   import { createRequire } from "node:module";
   import fs from "node:fs";
   const { chromium } = createRequire(import.meta.url)("playwright");

   const LOG = process.env.LOG ?? "/var/log/postgresql/postgresql-16-main.log";
   const BASE = process.env.BASE ?? "http://localhost:8787";
   const LATENCY = Number(process.env.LATENCY_MS ?? 0);
   const CLIENT = process.env.CLIENT_ID; // Harbor Millwork
   const RUN = process.env.RUN_ID; // one of its runs
   const AGENT = process.env.AGENT_ID; // its Bill clerk
   const who = process.argv[2];

   const screens =
     who === "ops"
       ? [
           ["Home", "/ops"],
           ["Escalations", "/ops/inbox"],
           ["Runs", "/ops/runs"],
           ["Run page", `/ops/runs/${RUN}`],
           ["Agent lab", "/ops/lab"],
           ["Clients", "/ops/clients"],
           ["Client overview", `/ops/clients/${CLIENT}`],
           ["Client agents", `/ops/clients/${CLIENT}/agents`],
           ["Agent page", `/ops/clients/${CLIENT}/agents/bill-clerk`],
           ["Agent workflow tab", `/ops/clients/${CLIENT}/agents/bill-clerk/workflows/invoice-read`],
           ["Agent runs tab", `/ops/clients/${CLIENT}/agents/bill-clerk/runs`],
           ["Agent versions tab", `/ops/clients/${CLIENT}/agents/bill-clerk/versions`],
           ["Client connections", `/ops/clients/${CLIENT}/connections`],
           ["Client documents", `/ops/clients/${CLIENT}/documents`],
           ["Client settings", `/ops/clients/${CLIENT}/settings`],
           ["Skills", "/ops/skills"],
           ["Usage", "/ops/usage"],
         ]
       : [
           ["Home", "/"],
           ["Inbox", "/inbox"],
           ["Runs", "/runs"],
           ["Run page", `/runs/${RUN}`],
           ["Agent", `/agents/${AGENT}`],
           ["Agent runs tab", `/agents/${AGENT}/runs`],
           ["Agent access tab", `/agents/${AGENT}/access`],
           ["Accounts", "/accounts"],
           ["Contacts", "/contacts"],
           ["Records", "/records"],
           ["Settings", "/settings"],
           ["Settings team", "/settings/team"],
           ["Sloan", "/sloan"],
         ];
   const email = who === "ops" ? "operator@example.com" : "dana@harbor-millwork.example.com";

   // Statements logged since `offset`, leaving out begin, commit and rollback.
   const sqlSince = (offset) => {
     let work = 0;
     for (const line of fs.readFileSync(LOG, "utf8").slice(offset).split("\n")) {
       const m = line.match(/LOG:\s+(?:statement|execute [^:]*):\s*(.*)$/);
       if (m && !/^(begin|commit|rollback)/i.test(m[1].trim())) work++;
     }
     return work;
   };

   const browser = await chromium.launch();
   const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
   const page = await context.newPage();
   if (LATENCY > 0) {
     const cdp = await context.newCDPSession(page);
     await cdp.send("Network.enable");
     await cdp.send("Network.emulateNetworkConditions", {
       offline: false,
       latency: LATENCY,
       downloadThroughput: -1,
       uploadThroughput: -1,
     });
   }
   let calls = [];
   let lastCallAt = 0;
   page.on("requestfinished", (r) => {
     const u = new URL(r.url());
     if (!u.pathname.startsWith("/api/")) return;
     calls.push(`${r.method()} ${u.pathname}${u.search}`);
     lastCallAt = Date.now();
   });
   const signIn = await context.request.post(`${BASE}/api/auth/dev/sign-in`, { data: { email } });
   if (!signIn.ok()) throw new Error(`sign-in ${signIn.status()}`);

   // No new call for 800 ms (plus the added latency) counts as loaded. Polls of 2 s and more
   // fall outside it.
   const idle = async () => {
     let last = -1;
     let quiet = 0;
     for (let i = 0; i < 60 && quiet < 2; i++) {
       await page.waitForTimeout(400 + LATENCY);
       quiet = calls.length === last ? quiet + 1 : 0;
       last = calls.length;
     }
   };
   const plain = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id");

   const out = [];
   for (const mode of ["fresh", "move"]) {
     if (mode === "move") {
       await page.goto(BASE + (who === "ops" ? "/ops/billing" : "/knowledge"));
       await idle();
     }
     for (const [name, path] of screens) {
       calls = [];
       const offset = fs.statSync(LOG).size;
       const started = Date.now();
       lastCallAt = started;
       if (mode === "fresh") await page.goto(BASE + path, { waitUntil: "load" });
       else
         await page.evaluate((p) => {
           history.pushState({}, "", p);
           dispatchEvent(new PopStateEvent("popstate", { state: {} }));
         }, path);
       await idle();
       const settled = lastCallAt - started;
       const paint =
         mode === "fresh"
           ? await page.evaluate(() => {
               const e = performance.getEntriesByName("first-contentful-paint")[0];
               return e ? Math.round(e.startTime) : null;
             })
           : null;
       const counts = {};
       for (const c of calls) counts[plain(c)] = (counts[plain(c)] ?? 0) + 1;
       const repeated = Object.entries(counts)
         .filter(([, n]) => n > 1)
         .map(([k, n]) => `${k} x${n}`);
       const sql = sqlSince(offset);
       out.push({ mode, name, api: calls.length, sql, paint, settled, repeated, calls: Object.keys(counts) });
       console.log(
         mode.padEnd(6),
         name.padEnd(22),
         "api",
         String(calls.length).padStart(3),
         " sql",
         String(sql).padStart(4),
         " paint",
         String(paint ?? "-").padStart(5),
         " settled",
         String(settled).padStart(5),
         repeated.length ? ` repeated: ${repeated.join(" | ")}` : "",
       );
     }
   }
   fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
   await browser.close();
   ```

5. One request's statements: note the log's size, `curl` the route with the session cookie, and
   read what was added. The fixed cost is whatever a trivial route (`/api/feedback/status`) logs.

6. Bundles. Web: `pnpm --filter @countersign/web build` prints each chunk; build with
   `SENTRY_SOURCEMAPS=1` and sum `sourcesContent` by folder in each `.js.map` to see what is in a
   chunk. Worker: `cd apps/api && npx wrangler deploy --dry-run --outdir <dir> --env staging`.

7. What the person sees. Open the screen with the browser's network panel set to "Fast 4G" and
   record it. Note, per screen: what shows first and when; how many times a placeholder is
   replaced; whether anything moves when data arrives; what going to a row and back shows.

What local numbers cannot show: real time. For that, read the request durations on staging before
and after each phase (Cloudflare's Worker logs, or the browser's network panel on a cold and a
warm load), and note them under "Results".
