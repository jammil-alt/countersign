# Countersign: v1 implementation plan

Source of truth for *what* to build: [`ARCHITECTURE.md`](ARCHITECTURE.md) (v0.2). This file says *how* and
*in what order*. It follows the Build plan (ARCHITECTURE §18) milestone by milestone. Each milestone
ends green: `pnpm typecheck && pnpm test` pass and its "done when" check is shown working.

Nothing here adds to the v1 scope in ARCHITECTURE §1. When this plan fills a gap the architecture leaves
open, it says **DECISION**, and the code carries a `// DECISION:` comment at the spot.

Status: **M0 not started.** Folder skeleton, workspace config, local Postgres and this plan exist. Stack decided: the same as Plenary Labs (§1.1).

---

## 1. Decisions

### 1.1 Open items from ARCHITECTURE §20

| Item | Decision | Why |
|---|---|---|
| Stack and hosting | **Same as Plenary Labs** (ARCHITECTURE v0.2). `apps/api`: one Hono Worker serving `/api/*`, the built `apps/web` as static assets (`run_worker_first: ["/api/*"]`), the Cloudflare Workflow classes and the cron handler. `apps/web`: React + Vite + React Router. Postgres 16 with pgvector on **Neon** (`main` = prod, `dev`, `pr-<n>` preview branches, reusing Plenary Labs' Neon branch and migration setup). Files in **R2** (Worker binding; S3 API only for signed URLs). Toolchain copied from Plenary Labs: pnpm, TypeScript, Biome, Vitest with `@cloudflare/vitest-pool-workers`. | One stack across projects: same accounts, deploy workflows, runbooks and habits. No Next.js-on-Workers adapter and no second job vendor. Supabase's extras (auth, realtime, storage) are covered by WorkOS, Durable Objects and R2. |
| DB driver from Workers | **Hyperdrive → Neon, with `postgres-js` + Drizzle.** Locally, Hyperdrive's `localConnectionString` points at Docker Postgres. Fallback: Neon's serverless driver in WebSocket `Pool` mode. | `withTenant()` needs interactive transactions (`set_config(..., true)` then queries). Hyperdrive supports them, and Neon's HTTP mode doesn't. Plenary Labs already reaches Neon through Hyperdrive with Drizzle; check `set_config` inside a transaction in the M0 deploy spike. |
| Auth provider | **WorkOS (AuthKit), as in Plenary Labs.** Port its `apps/api/src/identity/` (WorkOS client, AES-GCM sealed session cookie with a 5-minute refresh, provisioning on callback). Identity is the WorkOS user, mapped to `app_user`. A WorkOS organization maps to a `tenant` (`tenant.workos_organization_id`). Roles stay in our `membership` table, so an advisor can belong to many tenants. Behind `packages/auth` with two adapters: `workos` (deployed) and `dev` (local + e2e: seeded users, refused when `NODE_ENV=production`). | Already proven in your stack. Covers what Supabase Auth would add (invites, magic links, client self-serve) plus B2B extras for later (SSO, directory sync, an admin portal per client). |
| Purchaser doc requests | **Inbox only in v1, routed to an admin.** `docs.request_from_purchaser` creates an `inbox_item(kind='doc_request', assignee_role='client_admin')`. Owner: purchases come from several places (card spend, purchase orders, …), so per-purchaser routing waits until that's designed. A `Mailer` interface with a Resend adapter is wired up but used only when `RESEND_API_KEY` is set. | External side effects stay off by default (§16). The demo doesn't need email. |
| Embeddings | **Ship without vectors.** `catalog_item.embedding` stays nullable. Candidates come from key attributes plus `pg_trgm`. | §20 says trigram + attributes is enough for v1. Adding a provider later is one tool change. |

### 1.2 Gaps filled while planning

| Topic | Decision |
|---|---|
| IDs (uuid v7) | SQL function `uuid_generate_v7()` (plpgsql) as the column default, so seed scripts, raw SQL and Drizzle all get v7. Postgres 16 has no built-in v7. |
| DB roles and RLS | Two roles. The **owner** (`DIRECT_DATABASE_URL`) runs migrations and seed. **`app_user`** has no `BYPASSRLS` and owns no tables; the Worker, its Workflows and its cron connect as it. Create `app_user` (and a NOLOGIN `app_runtime` role holding all grants) **with SQL**, never through the Neon console/CLI/API: Neon-managed roles join `neon_superuser` and would skip RLS (Plenary Labs ADR 0002 §15). A test checks effective privileges. Every tenant table: `enable` + `force row level security`, policy `tenant_id = current_setting('app.tenant_id', true)::uuid`. All tenant reads and writes go through `withTenant(tenantId, tx => …)`, which opens a transaction and runs `set_config('app.tenant_id', $1, true)`. Queries also filter by `tenant_id` (§4). |
| Global tables | `tenant` and `app_user` have no `tenant_id`. They are read only by `packages/auth` through a narrow owner-side query module. `membership` is tenant-scoped like every other table. |
| Advisor across tenants | The session holds an *active tenant*. Every request checks it against `membership`. A tenant switcher sits in the header. |
| Migrations | `drizzle-kit generate` for tables. Hand-written custom SQL migrations (`drizzle-kit generate --custom`) for extensions, roles, `uuid_generate_v7`, the RLS loop, immutability triggers, and the `item_alias` expression unique index (`coalesce(...)`), which Drizzle can't express. |
| Immutability | One trigger function `forbid_update_except(variadic cols text[])`. Attached to `agent_version`, `workflow_version` (allow `status`), `raw_record` (allow `is_deleted`) and `doc_extraction` (allow nothing). `DELETE` is blocked on all four. |
| Money | `numeric(14,4)` maps to `string` in Drizzle. `packages/core/money` wraps `decimal.js`. No JS floats for money. |
| Senses outbox | `event` gets one extra column, `dispatched_at timestamptz null`. `emit()` inserts the row inside the caller's transaction. After commit, the Worker dispatches it in `ctx.waitUntil()` (router below) and stamps `dispatched_at`. The cron (every minute) re-dispatches anything undispatched for more than 30 s. Dispatching twice is harmless because run ids are deterministic (next row). |
| Starting runs | One Workflow class, **`RunWorkflow`**, executes any definition. A pure router in `packages/workflows` maps a sense event to the enabled workflows (live version) whose `trigger.event` and `filter` match. `apps/api` then calls `env.RUN_WORKFLOW.create({ id: runId, params })` for each. **Run ids are deterministic** for triggered runs: uuid v5 of (event id, workflow id) for events and of (workflow id, scheduled time) for schedules, so a re-dispatch or a repeated cron tick can't start a second run (`create` with a used id is refused). Command runs get a fresh v7. Schedules: the same every-minute cron checks each schedule trigger (`cron` + `tz`, via `cron-parser`). // DECISION: v5 for triggered run ids, v7 elsewhere. |
| Waiting on inbox items | `inbox_item` gets `run_id uuid null` (the workflow instance waiting on it). The step creates the item, then checks it isn't already resolved, then calls `step.waitForEvent(name, { type: 'inbox-<id without dashes>', timeout })`. `POST /api/inbox/:id/resolve` writes the resolution, then `env.RUN_WORKFLOW.get(runId).sendEvent({ type, payload })`. A timeout throws inside the step; the executor catches it and follows `onTimeout` (or marks the step `expired`). |
| Executor and Workers types | `packages/workflows` runs definitions against a small `StepRunner` interface (`do`, `waitForEvent`, `sleep`) and has no Workers types. `apps/api`'s `RunWorkflow` adapts Cloudflare's `WorkflowStep` to it, the way Plenary Labs' `run-group.ts` passes `step.sleep` in. Unit tests use a fake runner; one Workers-pool test drives the real class. Step outputs stay small (ids and short summaries), because step results have a size limit. `loop` runs items with bounded concurrency (10) through parallel `step.do` calls named `${stepId}:${index}`. |
| Expressions and templates | JSONLogic (`json-logic-js`) for `condition.if` and `map`. Templates `{{steps.<id>.output.<path>}}` / `{{trigger.<path>}}` use a small path resolver. No `eval`, no JS. |
| Agents vs `db` | §3 says agents never import `db` directly. Read as: **agent reasoning reaches business data only through tools**. Inside `packages/agents`, only `src/registry/` (agent, agent_version) and `src/log/` (step_run, tool_call) may import `@countersign/db`. Tool handlers call domain packages (`catalog`, `pricing`, …). A dependency check enforces this (§2). |
| Seeded agent definitions | JSON files in `packages/db/seed/agents/<slug>.v1.json`, validated by `AgentDefinition` and inserted as v1 rows by the seed. The runtime only ever reads `agent_version` rows (§9.2). The same goes for workflows: `packages/db/seed/workflows/*.v1.json`. |
| LLM record/replay | `packages/llm` hashes (model, system, messages, tools, tool_choice) into `fixtures/llm/<hash>.json`. `LLM_MODE=replay` is the test default and fails loudly on a miss. `record` calls the API and writes the file. `live` doesn't touch fixtures. |
| Cost | Per-model token price table in `packages/llm/pricing.ts`. Check the numbers against current Anthropic pricing when M4 starts; nothing is hard-coded from memory. |
| Extraction input | Send a PDF as a `document` content block (base64) and images as `image` blocks, with `tool_choice` forcing the `record_invoice` tool, whose schema is `InvoiceExtraction` (Zod → JSON Schema). Check page and size limits at M2 and split long PDFs by page if needed. |
| UI | Built from the owner's screen designs (coming), on the **Groundwork** design system. Tailwind + shadcn/ui primitives, themed by Groundwork tokens as CSS variables (one `tokens.css`, mapped into the Tailwind theme), so screens use token names, never raw colours. If Groundwork ships components, they replace the matching shadcn ones. Until the designs land, M0 builds only the shell and token plumbing; screen work (M6+) follows the designs. |
| Live updates | **v1 polls.** The run page polls every 2 s while a run is going; the inbox badge and thread view every 15–30 s. Every long job exposes a status the UI can poll. Later upgrade: push over WebSockets from a Durable Object, the way Plenary Labs' `GroupLog` streams sessions. |
| Page thumbnails (match review) | Render in the browser with pdf.js from the signed R2 URL. No server-side rendering, so no container is needed. |
| Invoices for fixtures | Synthetic invoices that look like normal vendor invoices. Swap in real (redacted) ones later and re-record. |

---

## 2. Package layering

Arrows point to allowed dependencies. Each package's `package.json` lists only these, and
`scripts/check-deps.mjs` (run by `pnpm lint:deps`) fails on any other workspace import.

```
apps/api ─▶ workflows ─▶ agents ─▶ documents ─▶ connectors ─▶ db ─▶ core
                │          │  ├──▶ catalog ────────────────▶ db
                │          │  ├──▶ pricing ────────────────▶ db
                │          │  └──▶ threads ────────────────▶ db
                │          └──▶ llm ─▶ core        (also used by documents, catalog)
                └──▶ senses ─▶ db                   (used by documents, catalog, pricing, threads)
auth ─▶ db                                          (used by apps/api only)
apps/web ─▶ core                                    (route contract + shared types; talks to apps/api over HTTP)
```

| Package | Workspace deps |
|---|---|
| `core` | none |
| `db` | core |
| `llm` | core |
| `auth` | db, core |
| `senses` | db, core |
| `connectors` | db, core |
| `documents` | connectors, llm, senses, db, core |
| `catalog` | llm, senses, db, core |
| `pricing` | senses, db, core |
| `threads` | senses, db, core |
| `agents` | documents, catalog, pricing, threads, llm, db\*, core |
| `workflows` | agents, threads, senses, db, core |
| `apps/api` | any |
| `apps/web` | core |

\* only from `agents/src/registry/` and `agents/src/log/` (see §1.2).

---

## 3. Today's demo cutline

ARCHITECTURE §18: if time is short, **M0–M8 with the upload connector is the demo**. M9 (QBO) follows.
The order below keeps something runnable at every step. A good fallback stop is after M6: upload → priced
lines → alerts on Price watch, with inbox decisions made through the API.

---

## 4. Milestones

Each milestone lists the work, the tests it adds, and the check that closes it.

### M0: Monorepo, Worker, app, DB, Workflows, auth

Work
- Deploy spike (do this first, against real Cloudflare + Neon): Worker `countersign-dev` on a custom domain with WorkOS sign-in; Hyperdrive → Neon `dev` with one `withTenant()` round trip (checks `set_config` stays inside the transaction); R2 put, get and a 5-minute signed URL; a `HelloWorkflow` instance that runs one `step.do` making a 60–90 s Claude call, waits on `step.waitForEvent`, resumes on `sendEvent`, and on a second instance takes the timeout path. Any surprise here changes this plan before M1.
- `apps/api`: Hono Worker. `wrangler.jsonc` with assets (`../web/dist`), Hyperdrive, R2 and Workflow bindings, cron `* * * * *`. `/api/health`, `/api/session`. Zod route contract in `packages/core/src/api/`.
- `apps/web`: Vite + React + React Router, Tailwind + shadcn primitives, Groundwork tokens in `tokens.css`. App shell: sidebar with the §15 screens (placeholders), header with tenant switcher. Typed client from the route contract.
- `packages/db`: Drizzle client (`postgres-js` over Hyperdrive), `drizzle.config.ts`, migration runner (direct URL), `withTenant()`. Migration `0000_platform`: extensions (`vector`, `pg_trgm`, `pgcrypto`), `uuid_generate_v7()`, `app_runtime` / `app_user` roles created with SQL, plus the `tenant`, `app_user` and `membership` tables (M1 adds the rest).
- `packages/auth`: `getSession()`, `requireRole()`, `activeTenant()`. `dev` and `workos` adapters (ported from Plenary Labs' `apps/api/src/identity/`).
- Seed: one tenant ("Millwork demo"), one advisor (`advisor@example.com`), one client_admin.
- Tooling: Plenary Labs' toolchain versions (pnpm, TypeScript, Biome, Vitest, `@cloudflare/vitest-pool-workers`), `scripts/check-deps.mjs`. `pnpm dev` builds the web app and runs `wrangler dev` on :8787 (Worker, Workflows, cron); `pnpm dev:web` runs Vite with `/api` proxied for fast UI work. CI modelled on Plenary Labs: install, lint, typecheck, check-deps, test against a `pgvector/pgvector:pg16` service; deploy and Neon branch workflows likewise.

Tests: `withTenant` sets and clears the setting; check-deps fails on a bad import (fixture); `HelloWorkflow` resumes on an event and times out without one (Workers pool).

**Done when** `pnpm dev` runs the Worker (API + Workflows) and the app, signing in as the seeded advisor lands on the shell, and the deployed spike signs in through WorkOS, reads a tenant row from Neon and resumes a waiting Workflow.

### M1: Full schema, RLS, immutability, seed

Work
- Drizzle schema for every table in ARCHITECTURE §5.1–5.3. Composite `(tenant_id, …)` indexes as listed. `ext jsonb default '{}'` on `vendor`, `transaction`, `catalog_item`. `event.dispatched_at` and `inbox_item.run_id` (§1.2).
- Custom migrations: RLS loop over every tenant table, `forbid_update_except` triggers, `item_alias` expression unique index, `price_observation` index.
- `packages/core`: Zod schemas `AgentDefinition` (§9.1) and `WorkflowDefinition` + `Step` (§10.1), exported as JSON Schema too (`zod-to-json-schema`). Units table and conversions (§12). Money.
- Seed: agent definitions for `document-clerk`, `catalog`, `purchasing` ("Pia"), `coordinator`, `builder` as v1 rows (live). Workflows `purchase-intake` and `weekly-price-review` as v1 (live, enabled). `definition_hash` = sha256 of canonical JSON (sorted keys).

Tests
- Migrations apply on an empty DB, and the seed runs twice without duplicates (idempotent).
- RLS: as `app_user`, tenant A sees nothing from tenant B on every tenant table (one test loops over the table list). No tenant set → no rows.
- Immutability: `UPDATE agent_version SET definition…` fails; `UPDATE … SET status` works; `DELETE` fails. Same for the other three tables.
- Every seeded definition parses with its Zod schema.

**Done when** migrations apply and the seed inserts the tenant, agents v1 and workflows v1.

### M2: Upload connector, storage, extraction, validation

Work
- `packages/connectors`: `Connector` interface (§6.1). `ObjectStore` (S3 client against R2; local filesystem adapter for dev and tests). `upload/`: files go to `document(source='upload')`, stored once per sha256. CSV of purchases goes to `raw_record(provider='upload')`, then `mapUploadPurchase` produces transactions.
- `packages/core/mappers`: raw → `TransactionInput` (upload now, QBO in M9).
- `packages/llm`: client wrapper, record/replay, cost accounting, `callTool<T>(schema)`.
- `packages/documents`: `extract(documentId)` → `doc_extraction` + `doc_line` (always a new row). `validateTotals()` per §7.1. On failure: `needs_review` + `inbox_item(extraction_review)`. `linkToTransaction()` by vendor + total + date ±7 days.
- `POST /api/uploads`, `GET /api/documents/:id` (5-minute signed URL + latest extraction).
- Fixtures: 3 synthetic millwork invoices (sheet goods, hardwood, hardware/finishes; one with freight + fuel surcharge; one multi-page) plus `*.expected.json`. Recorded LLM responses.

Tests: totals validation unit tests (tolerance edges); golden extraction in replay mode (header exact; each line: qty and prices within $0.01, description fuzzy ≥ 0.9); dedupe by sha256; linking window.

**Done when** uploading the 3 fixture invoices produces extractions that match the expected JSON within tolerance.

### M3: Catalog matching

Work in `packages/catalog`, following ARCHITECTURE §12 step by step.
- `normalize()` with the global abbreviation dictionary plus per-tenant/vendor learned abbreviations.
- Parsers: sheet goods, hardwood, hardware (required for M3). Mouldings/edgebanding and finishes/adhesives use a basic parser plus the LLM fallback. Each parser declares its **key attributes**.
- Alias lookup → candidate query (equal key attributes, then `pg_trgm` top-k) → Haiku adjudication → route by `match_confidence_auto` → hard rules last, as a veto the model can't override.
- `item_alias` learning on human decisions. `POST /api/catalog/:id/merge` sets `merged_into_id` and repoints aliases.
- Fixtures: `fixtures/matching/*.json`, ≥ 150 labeled pairs, heavy on near-misses (3/4 vs 1/2, BB/BB vs B/BB, 4x8 vs 5x5, prefinished vs not).

Tests: parser tables (`3/4"`, `.75`, `18MM`, `23/32` → `3/4in`; `4X8`, `48X96`, `4'X8'` → `48x96in`); golden precision ≥ 95% on "same" at the auto threshold, with recall reported; Baltic birch across 3 vendors resolves to one catalog item.

**Done when** golden tests show ≥ 95% precision and the Baltic birch example matches across 3 vendors.

### M4: Agent runtime and tools

Work in `packages/agents`.
- `registry/`: resolve `slug` or `slug@version`; `createVersion` (rejects a no-op by hash); `publish` (one transaction: new live, previous retired, `agent.live_version_id`); `rollback` (copy as a new version with `parent_version_id`).
- `tools/`: registry with the 16 v1 tools (§9.4). Each has Zod in/out, `sideEffect` and a handler that calls a domain package.
- `runtime/`: `runAgent()` per §9.3. Platform preamble; memory notes; `finish` tool typed to the command output; budget enforcement → `escalated` + inbox item; permission gate (`auto` / `approval` / `suggest_only` → `inbox_item(approval)` + pending marker); `sources` required for alert-producing commands. Document text always goes in tool results, never in the system prompt (§16).
- `log/`: `step_run` and `tool_call` rows with tokens and cost.
- `purchasing` commands: `record-prices` (mode `tool`), `price-check` (mode `agent`).

Tests: version publish/rollback/no-op; the permission gate gives each sideEffect × mode combination the right outcome; budget hit escalates; `price-check` in replay mode.

**Done when** `purchasing.price-check` runs end to end and logs cost.

### M5: Workflow executor, seeded workflows, senses

Work
- `packages/senses`: typed `emit()` (outbox), `undispatched()`, `markDispatched()`. Emitted from the mappers, documents, catalog and pricing.
- `packages/workflows`: the router, the `StepRunner` interface and step executors for all 8 step types (§1.2); each step writes `step_run`; cost rolls up to `run`. Every run appends to the subject's thread.
- `apps/api`: `RunWorkflow` class, after-commit dispatch in `ctx.waitUntil`, cron sweep and schedule check.
- `purchase-intake` and `weekly-price-review` run from their seeded definitions.

Tests: template resolution; JSONLogic conditions; executor with a fake `StepRunner` for condition branches, loop fan-out and a wait that resolves and one that times out; `RunWorkflow` in the Workers pool for one full run; a re-dispatched event doesn't start a second run; the cron sweep picks up an undispatched event.

**Done when** uploading an invoice runs intake to priced lines with alerts.

### M6: Pricing, alerts, Price watch

Work
- `packages/pricing`: `record()` (std unit price; freight not folded in; landed cost computed separately); the 6 alert rules (§13) with thresholds from the live `purchasing` version; `dollar_impact`; one open alert per (kind, item, vendor).
- `/prices` screen: item × vendor table with last price, Δ%, 90-day sparkline; alert list with evidence links (invoice page, observations). `GET /api/prices`, `GET/PATCH /api/alerts`.
- Seed script `seed:demo-prices`: 6 months of observations for ~10 items across 3 vendors.

Tests: one table-driven test per alert rule (fires / doesn't fire at the threshold edge); dedupe; UOM guard (no comparison across different `standard_uom`).

**Done when** seeded price history produces a `price_jump` and a `vendor_spread` alert, each with evidence links.

### M7: Inbox and match review

Work: `/inbox` filtered by role and assignee; match review UI (§15: line + page thumbnail, parsed attributes, candidates side by side with differing attributes highlighted, Match / New item / Skip); approval and extraction-review cards; `POST /api/inbox/:id/resolve` → writes the resolution (and `item_alias(source='human')`) and sends the event to the waiting run (`RUN_WORKFLOW.get(runId).sendEvent`).

Tests: resolving a match review resumes the waiting run (Workers pool); client_user sees only items assigned to them.

**Done when** resolving a match review continues the waiting run.

### M8: Agents UI and Builder

Work
- `/agents`, `/agents/[slug]` (definition view, version history with change notes, recent runs), publish and rollback actions.
- Builder: `draft-agent` and `revise-agent` (§9.6). Prompt context = tool registry (id, description, sideEffect), tenant connectors and entities, `AgentDefinition` JSON Schema. Server-side guards: Zod validation, `permissions.mode='suggest_only'` on new agents, `external` tools removed from `auto`, saved as `draft`. Field-level JSON diff rendered as sentences.
- `/agents/new` and `/agents/[slug]/revise`: describe → draft → review (summary, gaps, diff) → publish.

Tests: guards hold even when the model output violates them; diff sentences; the M8 script below in replay mode.

**Done when** "flag card charges over $500 missing receipts" produces a valid draft that lists gaps (no card connector), publish creates v1, revise creates v2 with a diff, and rollback works.

### M9: QuickBooks Online

First, check against Intuit's current developer docs: base URLs, minor version, CDC limits, webhook signature header and payload format (CloudEvents vs legacy), Attachable download, throttling limits and the current API terms. Record the findings in `packages/connectors/src/qbo/NOTES.md`.

Work: OAuth (authorize, callback, encrypted tokens with AES-256-GCM, refresh and persist the new refresh token every time); initial sync with paging; CDC every 15 min plus a webhook nudge; `POST /api/webhooks/qbo` verifies the HMAC and starts a `QboSyncWorkflow` instance for the realm (the cron starts one for CDC every 15 min); attachables fetched, stored once per sha256 and linked; per-realm throttle with backoff on 429; QBO mappers including both line detail types.

Tests: mappers on `fixtures/qbo/*`; webhook signature; token refresh rotation; sync is idempotent per `(connection, entity, id, SyncToken)`.

**Done when** a sandbox company syncs and a Bill with an attachment flows through intake.

### M10: Threads, run detail, Connectors polish

Work: `/threads/[id]` (messages with source links, post, `/command` parsing → `command` step); `/runs/[id]` (steps, agent versions, tool calls, cost); `/workflows` read-only step view and run history; `/connectors` (QBO connect/disconnect, last sync, upload); each alert links to its thread and run.

Tests: command parser; Playwright e2e: upload invoice → match review → Price watch shows the item (§19).

**Done when** every alert links to its thread and run.

---

## 5. Things to verify, not assume

- Intuit API details (M9, see above).
- Anthropic: PDF input limits, the tool-use output format with `tool_choice`, and current model prices (M2/M4). Model ids come from agent definitions, with defaults in §2 of the architecture.
- Cloudflare Workflows (the deploy spike): `waitForEvent` event-type naming rules and maximum timeout (the 5-day doc request must fit); whether an event sent just before the wait starts is kept or lost (the check-before-wait in §1.2 covers the common case); `create` refusing a used instance id; step result size and step count limits; testing waits in `@cloudflare/vitest-pool-workers`. Plenary Labs uses `step.do` and `step.sleep` but not `waitForEvent`, so this part is new.
- Neon + Hyperdrive: `app_user` role creation on Neon, `force row level security`, and that Hyperdrive's transaction pooling keeps `set_config(..., true)` inside the transaction (session-level settings would leak between requests).
- A Workflow step making a long Claude call (30–90 s) completes. Workers limit CPU time, not time spent waiting on I/O (Plenary Labs' ADR 0001 relies on this too).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Extraction accuracy on messy scans | Totals validation routes failures to review; re-extraction inserts new rows; goldens catch regressions. |
| Matcher false positives (the costly error) | Hard-rule veto on key attributes; precision gate in CI; auto-threshold set per agent version. |
| RLS bypassed by connecting as owner | App env only has `app_user`; a test asserts `current_user` isn't the owner in the request path. |
| Workflows' wait semantics differ from this plan | Checked in the M0 deploy spike, before the executor is built on them. The executor only sees `StepRunner`, so a change stays in `apps/api`. |
| QBO app approval delays | Upload connector is the demo path; M9 runs only against the sandbox. |

## 7. Owner answers and open questions

Answered (2026-11-03)
- Hosting: keep Cloudflare + Neon for consistency with Plenary Labs (§1.1). Sign-in: WorkOS, as in Plenary Labs.
- UI: the owner is designing the screens on Groundwork; designs to be uploaded.
- Invoices: build on synthetic invoices; real ones can be added later.
- Purchaser routing: undecided. Send all doc requests to an admin for now (§1.1).
- Stack: match Plenary Labs fully: Vite + React + Hono instead of Next.js, Cloudflare Workflows instead of Inngest (ARCHITECTURE v0.2).

Open
1. Groundwork: is there a package or token file to import, or should M0 copy the tokens in by hand? (Probably answered by the design upload.)
