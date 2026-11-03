# Countersign: v1 implementation plan

Source of truth for *what* to build: [`ARCHITECTURE.md`](ARCHITECTURE.md) (v0.5). This file says *how* and
*in what order*. It follows the Build plan (ARCHITECTURE §18) milestone by milestone. Each milestone
ends green: `pnpm typecheck && pnpm test` pass and its "done when" check is shown working.

Nothing here adds to the v1 scope in ARCHITECTURE §1. When this plan fills a gap the architecture leaves
open, it says **DECISION**, and the code carries a `// DECISION:` comment at the spot.

Status: **M0 not started.** Repo set up: workspace and package skeletons, Plenary Labs' toolchain (pnpm 11, TypeScript 7, Biome, Vitest), layering check, CI and deploy workflows (inert until provisioned, `docs/operations.md`), local Postgres with Neon's roles (`docs/local-development.md`). Stack decided: the same as Plenary Labs (§1.1). Product shape: a managed-agents service suite: the operator builds a catalogue of agents and deploys them into clients from a back office; clients get a portal for reports, runs, approvals, connections and requests. Materials (Pia) is the first agent; QuickBooks + Gmail are the v1 connectors (ARCHITECTURE v0.5).

---

## 1. Decisions

### 1.1 Open items from ARCHITECTURE §20

| Item | Decision | Why |
|---|---|---|
| Stack and hosting | **Same as Plenary Labs** (ARCHITECTURE v0.2). `apps/api`: one Hono Worker serving `/api/*`, the built `apps/web` as static assets (`run_worker_first: ["/api/*"]`), the Cloudflare Workflow classes and the cron handler. `apps/web`: React + Vite + React Router. Postgres 16 with pgvector on **Neon** (branches `main` = production, `staging`, plus throwaway `ci-run*` branches per CI run, as in Plenary Labs; environments in `docs/operations.md`). Files in **R2** (Worker binding; S3 API only for signed URLs). Toolchain copied from Plenary Labs: pnpm, TypeScript, Biome, Vitest with `@cloudflare/vitest-pool-workers`. | One stack across projects: same accounts, deploy workflows, runbooks and habits. No Next.js-on-Workers adapter and no second job vendor. Supabase's extras (auth, realtime, storage) are covered by WorkOS, Durable Objects and R2. |
| DB driver from Workers | **Hyperdrive → Neon, with `postgres-js` + Drizzle.** Locally, Hyperdrive's `localConnectionString` points at Docker Postgres. Fallback: Neon's serverless driver in WebSocket `Pool` mode. | `withTenant()` needs interactive transactions (`set_config(..., true)` then queries). Hyperdrive supports them, and Neon's HTTP mode doesn't. Plenary Labs already reaches Neon through Hyperdrive with Drizzle; check `set_config` inside a transaction in the M0 deploy spike. |
| Auth provider | **WorkOS (AuthKit), as in Plenary Labs.** Port its `apps/api/src/identity/` (WorkOS client, AES-GCM sealed session cookie with a 5-minute refresh, provisioning on callback). Identity is the WorkOS user, mapped to `app_user`. A WorkOS organization maps to a `tenant` (`tenant.workos_organization_id`). Roles stay in our `membership` table, so an operator can serve many clients. Behind `packages/auth` with two adapters: `workos` (deployed) and `dev` (local + e2e: seeded users, refused when `NODE_ENV=production`). | Already proven in your stack. Covers what Supabase Auth would add (invites, magic links, client self-serve) plus B2B extras for later (SSO, directory sync, an admin portal per client). |
| Document requests | **Inbox first, routed to an admin; Gmail draft when connected.** `docs.request_from_person` creates an `inbox_item(kind='request', assignee_role='client_admin')`; with Gmail connected, the workflow also proposes a `gmail.draft.create` to the purchaser (approval), which a person sends from Gmail. Owner: purchases come from several places (card spend, purchase orders, …), so per-purchaser routing waits until that's designed. | No email leaves without a person. |
| Operating model | **Managed-agents service** (owner, 2026-11-03). One operator (the owner and their team) builds a catalogue of agents, skills and workflows in the back office and deploys them into clients; clients get a portal for reports, runs, approvals, connections and requests, and never edit agents (ARCHITECTURE v0.5). | The agents are the operator's offering, sold to many clients; per-client copies would mean rebuilding every fix for every client. |
| v1 connectors | **QuickBooks Online and Gmail**, plus upload (owner, 2026-11-03). Gmail: one mailbox per connection (usually a shared `ap@`/`invoices@`), scopes `gmail.readonly`, `gmail.labels`, `gmail.compose`; only messages matching the connection's query are synced (headers, snippet, attachments); bodies fetched on demand; write tools are drafts and labels, each approved. | Email is where most invoices arrive; narrow ingestion keeps the privacy surface small. |
| Embeddings | **Ship without vectors.** `catalog_item.embedding` stays nullable. Candidates come from key attributes plus `pg_trgm`. | §20 says trigram + attributes is enough for v1. Adding a provider later is one tool change. |

### 1.2 Gaps filled while planning

| Topic | Decision |
|---|---|
| IDs (uuid v7) | SQL function `uuid_generate_v7()` (plpgsql) as the column default, so seed scripts, raw SQL and Drizzle all get v7. Postgres 16 has no built-in v7. |
| DB roles and RLS | Same layout as Plenary Labs. **`cs_owner`** (`DIRECT_DATABASE_URL`) owns the database and runs migrations and the seed. **`cs_runtime`** (NOLOGIN, created by the first migration) holds every runtime grant. **`cs_worker`** is the Worker's login role: a member of `cs_runtime` only, no `BYPASSRLS`, owns nothing; the Worker, its Workflows and its cron connect as it. `cs_worker` is created **with SQL** (`packages/db/scripts/provision-worker-role.mjs`), never through the Neon console/CLI/API: Neon-managed roles join `neon_superuser` and would skip RLS (Plenary Labs ADR 0002 §15). `scripts/setup-postgres.sh` builds the same roles on a plain Postgres for CI and local work. A test checks effective privileges, inheritance included. (Role names avoid `app_user`, which is a table.) Every tenant table: `enable` + `force row level security`, policy `tenant_id = any(current_setting('app.tenant_ids', true)::uuid[])`. All tenant reads and writes go through `withTenants(ids, tx => …)` (and `withTenant(id, …)` for one), which opens a transaction and runs `set_config('app.tenant_ids', $1, true)`. Client sessions and every run set exactly one id; operator sessions set the clients they serve. Queries also filter by `tenant_id` (§4). |
| Global tables | `tenant` and `app_user` have no `tenant_id` and are read only by `packages/auth` through a narrow owner-side module. The **catalogue** (`skill`, `agent`, `workflow` and their versions) has no `tenant_id` either: it is the operator's, reached only through back-office routes and the runtime; `cs_runtime` gets read on it and write only through the registry code paths. `membership` and everything per client are tenant-scoped. |
| Operator across clients | Back-office sessions carry the set of clients the operator serves (from `membership`); every `/api/ops` request runs inside `withTenants(those ids)`, narrowed by `?client=` when one is selected. Portal sessions carry their one client. The back office has a client switcher; the portal has none. |
| Migrations | `drizzle-kit generate` for tables. Hand-written custom SQL migrations (`drizzle-kit generate --custom`) for extensions, roles, `uuid_generate_v7`, the RLS loop, immutability triggers, and the `item_alias` expression unique index (`coalesce(...)`), which Drizzle can't express. |
| Immutability | One trigger function `forbid_update_except(variadic cols text[])`. Attached to `agent_version`, `skill_version`, `workflow_version` (allow `status`), `raw_record` (allow `is_deleted`) and `doc_extraction` (allow nothing). `DELETE` is blocked on all five. |
| Money | `numeric(14,4)` maps to `string` in Drizzle. `packages/core/money` wraps `decimal.js`. No JS floats for money. |
| Senses outbox | `event` gets one extra column, `dispatched_at timestamptz null`. `emit()` inserts the row inside the caller's transaction. After commit, the Worker dispatches it in `ctx.waitUntil()` (router below) and stamps `dispatched_at`. The cron (every minute) re-dispatches anything undispatched for more than 30 s. Dispatching twice is harmless because run ids are deterministic (next row). |
| Starting runs | One Workflow class, **`RunWorkflow`**, executes any graph for a deployment. A pure router in `packages/workflows` maps a client's sense event to that client's **active** `deployment_workflow` rows whose pinned workflow version's trigger `event` and `filter` match (plus overrides). `apps/api` then calls `env.RUN_WORKFLOW.create({ id: runId, params })` for each. **Run ids are deterministic** for triggered runs: uuid v5 of (event id, deployment_workflow id) for events and of (deployment_workflow id, scheduled time) for schedules, so a re-dispatch or a repeated cron tick can't start a second run. Manual, command and test runs get a fresh v7. Schedules: the every-minute cron checks each active schedule trigger in the client's timezone (`cron-parser`). // DECISION: v5 for triggered run ids, v7 elsewhere. |
| Waiting on inbox items | The node (approval, request, or a gated tool call) creates the inbox item with `run_id`, checks it isn't already resolved, then calls `step.waitForEvent(name, { type: 'inbox-<id without dashes>', timeout })`. `POST /api/inbox/:id/resolve` writes the resolution, then `env.RUN_WORKFLOW.get(runId).sendEvent({ type, payload })`. A timeout throws inside the step; the executor catches it and follows the node's `timeout` port (or marks the step `expired`). |
| Executor and Workers types | `packages/workflows` walks graphs against a small `StepRunner` interface (`do`, `waitForEvent`, `sleep`) and has no Workers types. `apps/api`'s `RunWorkflow` adapts Cloudflare's `WorkflowStep` to it, the way Plenary Labs' `run-group.ts` passes `step.sleep` in. Unit tests use a fake runner; one Workers-pool test drives the real class. Step outputs stay small (ids and short summaries), because step results have a size limit. Parallel branches run as concurrent `step.do` calls; `loop` children run with the node's `concurrency` (default 10) under names `${nodeId}:${index}:${childId}`. |
| Expressions and templates | JSONLogic (`json-logic-js`) for `condition.if`. Templates `{{nodes.<id>.output.<path>}}` / `{{trigger.<path>}}` / `{{item}}` use a small path resolver in `packages/core`, shared by the canvas (template picker, validation) and the executor. No `eval`, no JS. |
| Agents vs `db` | **Agent reasoning reaches business data only through tools.** Inside `packages/agents`, only `src/registry/` (agent, skill and workflow versions) and `src/log/` (step_run, tool_call, external_action) may import `@countersign/db`. Tool handlers live with their owners (platform, connectors, packs). The dependency check enforces this (§2). |
| Seeded and template definitions | Platform agents (`document-clerk`, `coordinator`, `builder`): JSON in `packages/db/seed/agents/<slug>.v1.json`, inserted once into the catalogue. Pack templates (Pia and her workflows) are inserted into the catalogue when the pack is installed; deploying them to a client is a separate step. Everything is validated by its Zod schema (and graph validation) before insert. The runtime only ever reads version rows. |
| LLM record/replay | `packages/llm` hashes (model, system, messages, tools, tool_choice) into `fixtures/llm/<hash>.json`. `LLM_MODE=replay` is the test default and fails loudly on a miss. `record` calls the API and writes the file. `live` doesn't touch fixtures. |
| Cost | Per-model token price table in `packages/llm/pricing.ts`. Check the numbers against current Anthropic pricing when M4 starts; nothing is hard-coded from memory. |
| Extraction input | Send a PDF as a `document` content block (base64) and images as `image` blocks, with `tool_choice` forcing the `record_invoice` tool, whose schema is `InvoiceExtraction` (Zod → JSON Schema). Check page and size limits at M2 and split long PDFs by page if needed. |
| UI | Built from the owner's screen designs (coming), on the **Groundwork** design system. Tailwind + shadcn/ui primitives, themed by Groundwork tokens as CSS variables (one `tokens.css`, mapped into the Tailwind theme), so screens use token names, never raw colours. If Groundwork ships components, they replace the matching shadcn ones. Until the designs land, M0 builds only the shell and token plumbing; screen work (M5+) follows the designs. |
| Live updates | **v1 polls.** The run page polls every 2 s while a run is going; the inbox badge and thread view every 15–30 s. Every long job exposes a status the UI can poll. Later upgrade: push over WebSockets from a Durable Object, the way Plenary Labs' `GroupLog` streams sessions. |
| Workflow graph model | Graph (`nodes` + `edges` with ports), not an ordered step list, so the canvas and the executor share one shape (ARCHITECTURE §10.1). `position` lives on each node and is ignored by the executor; moving a node is still a new draft version, because the definition changed. // DECISION: drafts save every 2 s of idle editing as one rolling draft version per editor session, so history isn't flooded; publish creates the version people see in history. |
| Canvas | React Flow (`@xyflow/react`) for the canvas, ELK (`elkjs`, in a web worker) for auto-layout. Nodes are our components styled with Groundwork tokens. The palette, inspector and node forms are generated from skill and tool schemas, so a new skill appears in the palette without UI code. Graph validation runs in the browser on every change (same code as the server). |
| Packs | A pack is a workspace package under `packs/` exporting a `PackManifest` (ARCHITECTURE §12.1), tool handlers, a Drizzle schema and Hono routes. Its tables go in the one migration sequence (drizzle config lists every pack schema). `apps/api` registers packs in one list; installing a pack adds its templates to the catalogue once; enabling it for a client is a row in `tenant_pack`. |
| External actions | A gated tool call writes `external_action(status='proposed')` and an inbox item in the same transaction; approval flips it to `approved`; execution runs in its own `step.do` keyed by the idempotency key (`<run id>:<node id>:<index>`), so a retried step can't write twice. Connectors implement `before` capture where the API allows (QBO: read the record with its `SyncToken` first). |
| Operator skills | Written in the back office as a form (name, description, instructions, a tool picker over every registered tool, input/output field editors that produce JSON Schema, settings, an optional summary template). Always `agent` mode. No code. Stored in the catalogue, usable by any agent. |
| Role checks | The route contract in `packages/core` declares each route's roles; Hono middleware enforces them and sets `app.tenant_ids`. Two contract tests: every `/api/ops` route is operator-only; no portal route's response schema includes a catalogue definition, instructions, prompts or cost fields. |
| Connect links | The operator generates a link per connector and client: signed, single use, 7-day expiry, bound to the client. The client admin signs in, opens it and goes through the provider's OAuth; `connection.connected_by` records who granted access. |
| Requests | `inbox_item(kind='change_request')` in the operator's request queue, with the subject (a service, a run, or none for a new service) and the client's text. Resolution links the deployment changes or catalogue versions made for it. The Builder can take the request text as its description. |
| Deployments and rollout | `deployment` rows pin agent and workflow versions per client, with bindings, setting overrides (validated against skill settings schemas), approver and status; every change appends `deployment_change`. Activation requires all required connectors bound and one passing test run on that client. Publishing a catalogue version changes no deployment except those on `track: live`; the agent page lists deployments by version with "upgrade" (one, many, all; optional test run each) and per-deployment rollback. |
| Client run timeline | Each skill and tool may declare a `summary` template over its output (e.g. `Extracted {{lines.length}} lines from {{header.vendor_name}}`); the executor renders it into `step_run.summary`. No summary → the node's client label + status. Model text never reaches the portal except through these templates. |
| Back office and portal in one app | One SPA with two layouts: `/ops/*` (operator) and everything else (portal). The `/ops` bundle, including React Flow and ELK, is code-split, so client users never download it. Sign-in lands operators in `/ops` and clients in `/`. |
| Sandbox client | Seeded client "Sandbox" with fixture data (vendors, transactions, invoices, price history), used for building, test runs and demos without touching a real client. |
| Gmail sync | Cron every 5 minutes per connection: `users.history.list` from the stored `historyId`, filtered by the connection's query; if the history id has expired, a bounded `messages.list` with the query replaces it. Attachments are stored once per sha256 as `document(source='email')` and linked like uploads, with the sender domain as a vendor signal. // DECISION: poll, not Pub/Sub push, in v1. |
| Page thumbnails (match review) | Render in the browser with pdf.js from the signed R2 URL. No server-side rendering, so no container is needed. |
| Invoices for fixtures | Synthetic invoices that look like normal vendor invoices. Swap in real (redacted) ones later and re-record. |

---

## 2. Package layering

Arrows point to allowed dependencies. Each package's `package.json` lists only these, and
`scripts/check-deps.mjs` (run by `pnpm lint:deps`) fails on any other workspace import, on a platform
package that depends on a pack, and on a pack that depends on anything outside its allowed set.

```
apps/api ─▶ workflows ─▶ agents ─▶ documents ─▶ connectors ─▶ db ─▶ core
   │            │          └─▶ threads ─────────────────────▶ db
   │            │          └─▶ llm, senses, connectors
   │            └─▶ senses ─▶ db
   ├─▶ auth ─▶ db
   └─▶ packs/materials ─▶ documents, connectors, llm, senses, db, core   (never agents or workflows)
apps/web ─▶ core                    (route contract, schemas, graph validation; HTTP to apps/api)
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
| `threads` | senses, db, core |
| `agents` | documents, threads, connectors, llm, senses, db\*, core |
| `workflows` | agents, threads, senses, db, core |
| `packs/materials` | documents, connectors, llm, senses, db, core |
| `apps/api` | any |
| `apps/web` | core |

\* only from `agents/src/registry/` and `agents/src/log/` (see §1.2).

The registries in `agents` hold tools and skills from three sources: the platform, connectors and packs.
`apps/api` builds them at startup from the platform's own list, each registered connector's manifest,
and each pack's manifest; nothing in `packages/*` names a pack.

---

## 3. Demo cutline

ARCHITECTURE §18: if time is short, **M0–M8 with the upload connector is the demo**: the operator builds
and deploys agents from the back office, and Pia runs purchase-intake on uploaded invoices for the millwork
shop while the shop approves in its portal.
M9 (QBO) and M10 (Gmail) follow.
Fallback stops that still demo the platform:
- after **M7**: build an agent from scratch on the canvas with platform skills (extract a document,
  ask for approval, post to a thread), deploy it to the sandbox client, watch it run in the back office
  and on the client timeline;
- after **M8**: the same, plus Pia end to end on uploaded invoices with Price watch.

---

## 4. Milestones

Each milestone lists the work, the tests it adds, and the check that closes it.

### M0: Monorepo, Worker, app, DB, Workflows, auth

Work
- Deploy spike (do this first, against real Cloudflare + Neon): Worker `countersign-staging` with WorkOS sign-in; Hyperdrive → Neon `staging` with one `withTenant()` round trip (checks `set_config` stays inside the transaction); R2 put, get and a 5-minute signed URL; a `HelloWorkflow` instance that runs one `step.do` making a 60–90 s Claude call, waits on `step.waitForEvent`, resumes on `sendEvent`, and on a second instance takes the timeout path. Any surprise here changes this plan before M1.
- `apps/api`: Hono Worker. `wrangler.jsonc` with assets (`../web/dist`), Hyperdrive, R2 and Workflow bindings, cron `* * * * *`. `/api/health`, `/api/session`. Zod route contract in `packages/core/src/api/`.
- `apps/web`: Vite + React + React Router, Tailwind + shadcn primitives, Groundwork tokens in `tokens.css`. Two shells (§1.2): back office (`/ops`, client switcher) and portal, with the ARCHITECTURE §15 screens as placeholders. Typed client from the route contract.
- `packages/db`: Drizzle client (`postgres-js` over Hyperdrive), `drizzle.config.ts` (platform + pack schemas), migration runner (direct URL), `withTenant()`. Migration `0000_platform`: extensions (`vector`, `pg_trgm`, `pgcrypto`), `uuid_generate_v7()`, the `cs_runtime` role and its grants, plus the `tenant`, `app_user` and `membership` tables (M1 adds the rest).
- `packages/auth`: `getSession()`, `requireRole()`, `activeTenant()`. `dev` and `workos` adapters (ported from Plenary Labs' `apps/api/src/identity/`).
- Seed: the operator (`operator@example.com`), clients "Sandbox" and "Millwork demo", one client_admin for the millwork client.
- `packages/db/scripts/provision-worker-role.mjs`: creates or re-keys `cs_worker` (used by `scripts/setup-postgres.sh` and on each Neon branch). Port Plenary Labs' `scripts/connect.sh` to wire Hyperdrive and local env files.
- Already done in repo setup: toolchain, Biome, `scripts/check-deps.mjs` (including the pack rules), `pnpm dev` / `dev:web` scripts, `ci.yml` / `checks.yml` / `deploy.yml`, `scripts/setup-postgres.sh`. M0 adds `wrangler`, `@cloudflare/vitest-pool-workers`, Vite and React, and the `staging` env in `apps/api/wrangler.jsonc`.

Tests: `withTenant` sets and clears the setting; check-deps fails on a bad import (fixture); `HelloWorkflow` resumes on an event and times out without one (Workers pool).

**Done when** `pnpm dev` runs the Worker (API + Workflows) and the app, signing in as the operator lands on the back office shell and as the client admin on the portal shell, and the deployed spike signs in through WorkOS, reads a tenant row from Neon and resumes a waiting Workflow.

### M1: Platform schema, core schemas, graph validation, seed

Work
- Drizzle schema for ARCHITECTURE §5.1–5.3: connections and raw data, `external_action`, shared business records, `tenant_pack`, the catalogue (skills, agents, workflows and versions, no `tenant_id`), deployments, runs, events, threads, inbox, memory (per deployment), `usage_daily`. Composite `(tenant_id, …)` indexes. `ext jsonb default '{}'` where §5 says.
- Custom migrations: RLS loop over every tenant table (`app.tenant_ids` policy), `forbid_update_except` triggers (§1.2), grants to `cs_runtime` (catalogue: read, plus write for the registry paths).
- `packages/core`: Zod schemas `AgentDefinition` v2, `SkillDefinition`, `WorkflowGraph` + node types, `ToolSpec`, `ConnectorManifest`, `PackManifest`, `EventTypeSpec`, each also exported as JSON Schema. **Graph validation** (ARCHITECTURE §10.2) returning errors with node id and field, and the template resolver + typer. Units table and conversions. Money.
- Seed: operator, Sandbox and Millwork clients with users, platform agents (`document-clerk`, `coordinator`, `builder`) as v1 catalogue rows, Sandbox fixture data. `definition_hash` = sha256 of canonical JSON (sorted keys).

Tests
- Migrations apply on an empty DB, roll back, re-apply; the seed runs twice without duplicates.
- RLS: as `cs_worker`, a session for client A sees nothing of client B on every tenant table (one test loops over the table list); an operator session for {A, B} sees both and nothing of C; no ids set → no rows. Privileges: `cs_worker` is not a member of `neon_superuser` and can't bypass RLS.
- Immutability: `UPDATE agent_version SET definition…` fails; `UPDATE … SET status` works; `DELETE` fails. Same for the other version tables, `raw_record` and `doc_extraction`.
- Graph validation: one failing fixture per rule, plus valid fixtures for every node type and port; template typing across branches (a field produced on only one branch is an error after the merge).

**Done when** migrations apply, RLS holds for client and operator sessions, the seed inserts the operator, clients and platform agents, and the validation suite passes.

### M2: Connector framework, upload, documents

Work
- `packages/connectors`: `Connector` interface and manifest (ARCHITECTURE §6.1), connector registry, `ObjectStore` (R2 binding; local adapter for tests). `upload/`: files go to `document(source='upload')`, stored once per sha256; CSV of purchases goes to `raw_record(connector='upload')`, then `mapUploadPurchase` produces transactions.
- `packages/core/mappers`: raw → `TransactionInput` (upload now, QBO in M9).
- `packages/llm`: client wrapper, record/replay, cost accounting, `callTool<T>(schema)`.
- `packages/documents`: store, `findSupport(transactionId)`, `extract(documentId)` → `doc_extraction` + `doc_line` (always a new row), `validateTotals()` (ARCHITECTURE §7), `linkToTransaction()` by vendor + total + date ±7 days. Platform tools `docs.*` and skills `docs.find-support`, `docs.extract`.
- `POST /api/uploads`, `GET /api/documents/:id` (5-minute signed URL + latest extraction), `GET /api/connectors`.
- Fixtures: 3 synthetic millwork invoices (sheet goods, hardwood, hardware/finishes; one with freight + fuel surcharge; one multi-page) plus `*.expected.json`. Recorded LLM responses.

Tests: totals validation (tolerance edges); golden extraction in replay mode (header exact; each line: qty and prices within $0.01, description fuzzy ≥ 0.9); dedupe by sha256; linking window; manifests validate.

**Done when** uploading the 3 fixture invoices produces extractions that match the expected JSON within tolerance.

### M3: Registries, agent runtime, permission gate, external actions

Work in `packages/agents`.
- `registry/`: tool registry (platform + connector + pack sources), skill registry (built-ins from code, operator-written skills from `skill_version` rows), deployment resolution (pinned versions, setting overrides, bindings; availability per client), agent registry (resolve `slug[@version]`, `createVersion` rejecting a no-op by hash, `publish` in one transaction, `rollback` as a copy with `parent_version_id`). Same version operations for skills and workflows.
- `runtime/`: `runAgent()` per ARCHITECTURE §9.5: tool-mode skills call their handler; agent-mode skills run the loop with the skill's tools and a `finish` tool typed to the skill output; budgets → `escalated` + inbox item; `sources` required for skills that produce alerts. Document text only ever in tool results (§16).
- Permission gate and **external actions** (§1.2): `none` runs; `internal` runs if allowed, else approval; `external` always proposes an action and waits.
- `log/`: `step_run` (with `summary` from the skill's template), `tool_call`, `external_action` rows with tokens and cost; `usage_daily` rollup.
- A test-only connector (`testkit`) with one read tool and one external write tool, so external actions are tested without QBO.

Tests: version publish/rollback/no-op for agents, skills and workflows; the gate gives each sideEffect × permission × mode the right outcome; an approved external action executes exactly once across a retried step; a rejected one never executes; budget hit escalates; a test agent with `docs.extract` in replay mode.

**Done when** a test agent deployed to the Sandbox client runs `docs.extract` end to end and logs cost, and its external tool call creates an approval and executes once when approved.

### M4: Graph executor, triggers, senses, test runs

Work
- `packages/senses`: typed `emit()` (outbox), `undispatched()`, `markDispatched()`. Emitted by mappers, documents, inbox and external actions.
- `packages/workflows`: trigger router over active `deployment_workflow` rows, `StepRunner` interface, executors for every node type and port (ARCHITECTURE §10.1, §10.3); each node writes `step_run`; cost rolls up to `run`; every run appends to its subject's thread.
- `apps/api`: `RunWorkflow` class, after-commit dispatch in `ctx.waitUntil`, cron sweep and schedule check, manual and command triggers. **Test runs** (`mode='test'`): external actions recorded as proposed only, no events emitted.
- Event catalogue (`GET /api/catalog/events`): platform + enabled pack event types with sample payloads.

Tests: template resolution; JSONLogic conditions; an event for client A starts only A's deployments; a paused deployment starts nothing; schedules fire in the client's timezone; executor with a fake `StepRunner` for every node type and port, parallel branches, loop with concurrency, a wait that resolves and one that times out; `RunWorkflow` in the Workers pool for one full run; a re-dispatched event doesn't start a second run; the cron sweep picks up an undispatched event; a test run never executes an external action.

**Done when** a graph with a condition, a loop and an approval runs to the end for one client's deployment and never starts for another client, and a test run proposes but never executes external actions.

### M5: Back office and portal shells, onboarding, inbox, requests

Work
- **Back office** (`/ops`): overview (needs attention across clients: failed runs, operator inbox, open requests, connections to fix, deployments behind latest); clients list with health; new client (create, invite the client admin through WorkOS, connect links, packs, approval delegation); client detail shell; operator inbox; requests queue.
- **Portal**: overview shell (services, what needs you); inbox (approval, external action with tool / target record / change / current state, request, extraction review); connections (connect via link or directly, reconnect, disconnect, upload); requests (raise, see status); settings (users, notifications).
- `POST /api/inbox/:id/resolve` (and the `/ops` twin) → resolution + `inbox.resolved` + `sendEvent` to the waiting run. Approver from the deployment, else the client setting; every approval records who.
- Role checks and both contract tests (§1.2). Threads basics with `audience` (operator-only notes never in the portal).

Tests: resolving an approval resumes the waiting run (Workers pool); client_user sees only items assigned to them; a connect link is single use, expires, and can't be used for another client; the contract tests; an operator sees only the clients they serve.

**Done when** the operator creates a client and invites its admin; the admin connects via a link, approves an item that resumes a run, and raises a request the operator sees in the queue.

### M6: Catalogue and deployments

Work
- Catalogue (`/ops/catalog`): agents list; new agent (from scratch: name, role, mission, instructions, model; or describe → Builder, optionally from a client request); agent editor (identity, instructions, skills with default settings, extra tools, permissions with the external-never-auto rule shown, budgets, versions with change notes and diffs, publish, rollback, "Deployed to"); skills library with the operator skill editor (ARCHITECTURE §9.2); packs.
- Deployments (`/ops/deployments/[id]`): deploy an agent to a client, bind connections, per-client settings and approver, portal service name and description, test run on the client's data, activate, pause, retire; upgrade (one, many, all) and per-deployment rollback from the agent page.
- Builder: `draft-agent` and `revise-agent` (ARCHITECTURE §9.6) producing an agent definition **and** workflow graphs; server guards; drafts open in the editor and the canvas.
- Portal: services list and service page (name, description, status, recent runs) from deployments.

Tests: guards hold even when the model output violates them (external tool in `auto`, unknown skill, invalid graph); diff sentences; activation refuses missing bindings or no passing test run; publishing doesn't change pinned deployments; upgrade and rollback per deployment; client roles get 403 on every `/api/ops` route; the Builder script below in replay mode.

**Done when** the operator builds an agent from scratch, publishes it, deploys it to two clients with different settings, upgrades one to v2 and rolls it back; "flag card charges over $500 missing receipts" produces a valid draft with gaps listed (no card connector); each client sees only its own service in the portal.

### M7: Workflow canvas and run view

Work (`apps/web`, ARCHITECTURE §10.5)
- Canvas with React Flow: palette (triggers from the event catalogue, the agent's skills then the library, logic, people, tools by connection, notify, end), drag to add, connect ports, delete, multi-select, undo/redo, ELK auto-layout, loop groups.
- Inspector: forms generated from skill/tool input schemas; template picker of upstream outputs valid at the node; settings with defaults.
- Live validation (shared `packages/core` code) with node badges and a clickable summary; save draft; test run with a chosen payload (sample event, recent record, manual input); publish; version history with rollback and a visual diff.
- Run view: the canvas read-only, nodes coloured by `step_run` status, cost per node, side panel with input, output, tool calls and inbox items; polls while running.
- Inspector also sets each node's client timeline label and visibility; the top bar test-runs on a chosen client deployment or the Sandbox and shows "Deployed to".
- Portal run timeline (ARCHITECTURE §10.6): client-visible steps with label, status, time, summary, sources and approvals; no costs, instructions or internal steps.

Tests: component tests for add, connect, delete, undo, invalid markers; a round trip (canvas → graph JSON → canvas) keeps every node, edge and position; the done-when script as a Playwright test against `pnpm dev`.

**Done when** the operator builds a 5-node workflow (trigger → skill → condition → approval → notify) on the canvas, test-runs it on a client's data, publishes it and upgrades that client's deployment; the operator watches the live run on the canvas while the client sees the timeline without internals or cost.

### M8: Materials pack and Pia

Work in `packs/materials` (ARCHITECTURE §12.2–12.4).
- Schema (`catalog_item`, `item_alias`, `item_match`, `price_observation`) in the shared migration sequence, with RLS and grants; the `item_alias` expression unique index.
- Catalog: `normalize()`, parsers (sheet goods, hardwood, hardware required; mouldings/edgebanding and finishes/adhesives basic + LLM fallback), each declaring **key attributes**; alias lookup → candidates (equal key attributes, then `pg_trgm`) → Haiku adjudication → route by `match_confidence_auto` → hard rules as a veto; alias learning on human decisions; merge.
- Pricing: `record()` (std unit price; freight not folded in; landed cost separate); the 6 alert rules with thresholds from skill settings; `dollar_impact`; one open alert per (kind, item, vendor).
- Manifest: tools, skills (with summary templates), events, Pia and both workflow graphs (validated by the same graph validation), installed into the catalogue; enabling the pack for the millwork client and deploying Pia there.
- Screens under `apps/web/src/packs/materials/`: portal reports Price watch (item × vendor table with last price, Δ%, 90-day sparkline; alerts with evidence links) and Catalog, with CSV export; the same views for any client in the back office, plus merge; match review card in the Inbox. Portal activity report (runs, documents processed, actions taken, alerts and dollar impact for the period).
- Fixtures: `fixtures/matching/*.json` (≥ 150 labeled pairs, heavy on near-misses: 3/4 vs 1/2, BB/BB vs B/BB, 4x8 vs 5x5, prefinished vs not); seed script `seed:demo-prices` (6 months, ~10 items, 3 vendors).

Tests: parser tables (`3/4"`, `.75`, `18MM`, `23/32` → `3/4in`; `4X8`, `48X96`, `4'X8'` → `48x96in`); golden precision ≥ 95% on "same" at the auto threshold, recall reported; Baltic birch across 3 vendors → one item; one table-driven test per alert rule at the threshold edge; dedupe; UOM guard; the pack's templates pass graph validation; layering (the pack imports no `agents`/`workflows`).

**Done when** golden tests pass, Baltic birch matches across 3 vendors, an invoice uploaded by the millwork client runs Pia's purchase-intake to priced lines with a `price_jump` alert, and the client sees it in Price watch.

### M9: QuickBooks Online

First, check against Intuit's current developer docs: base URLs, minor version, CDC limits, webhook signature header and payload format, Attachable download and upload, sparse updates and `SyncToken` rules, throttling limits and the current API terms. Record the findings in `packages/connectors/src/qbo/NOTES.md`.

Work: OAuth (authorize, callback, encrypted tokens with AES-256-GCM, refresh and persist the new refresh token every time); initial sync with paging; CDC every 15 min plus a webhook nudge (`POST /api/webhooks/qbo` verifies the HMAC and starts a `QboSyncWorkflow` instance for the realm); attachables fetched, stored once per sha256 and linked; per-realm throttle with backoff on 429; QBO mappers including both line detail types; read tools; write tools behind approval with `before` capture and stale-`SyncToken` handling (first write: `qbo.attachable.upload`, ARCHITECTURE §20).

Tests: mappers on `fixtures/qbo/*`; webhook signature; token refresh rotation; sync is idempotent per `(connection, entity, id, SyncToken)`; a write with a stale token fails cleanly and leaves the action `failed` with the reason.

**Done when** a sandbox company syncs, a Bill with an attachment flows through intake, and an approved `qbo.attachable.upload` attaches the invoice in the sandbox.

### M10: Gmail

First, check Google's current documentation: scope classifications for `gmail.readonly`, `gmail.labels` and `gmail.compose`; OAuth app verification and the security assessment for restricted scopes; the user cap and warning for unverified apps; refresh-token expiry for apps in "testing" status; `history.list` retention; quotas. Record the findings and the chosen route (verified app, or domain-wide delegation for Workspace clients) in `packages/connectors/src/gmail/NOTES.md`.

Work: OAuth (authorize, callback, encrypted tokens, refresh); the connection's ingestion query (operator-set, default per ARCHITECTURE §6.4) and its editor on `/connections`; sync per §1.2 (history polling, expiry fallback, attachments as documents, dedupe by sha256, link to transactions with the sender domain as a signal); read tools `gmail.message.search`, `gmail.message.get`, `gmail.attachment.get`; write tools `gmail.draft.create`, `gmail.label.apply` behind approval; the Gmail step in `docs.find-support`; disconnect revokes the token and stops sync. Pia's catalogue workflow gains the Gmail draft and label steps as a new version; the operator upgrades each client's deployment when ready.

Tests: sync against recorded Gmail API fixtures (`fixtures/gmail/`): only query matches are stored, bodies are not; history expiry falls back to search; attachments dedupe; draft and label tools only run after approval and run once; email body text reaches agents only inside tool results.

**Done when** a test mailbox connects, an emailed invoice is found for its QBO transaction and flows through intake, and an approved `gmail.draft.create` appears in the mailbox's drafts.

### M11: Usage, reports, notifications, end-to-end

Work: back-office usage and cost (per client, agent and deployment, by month; `usage_daily`); portal overview and activity report polish; notification emails to clients (weekly digest, items waiting); every alert and external action links to its run; empty states and first-run guidance for the operator (create client → invite → connect links → enable packs → deploy) and for clients (connect your tools → your inbox).

Tests: Playwright e2e: the operator creates a client and deploys Pia → the client admin connects and uploads an invoice → approves in the portal → sees the activity and Price watch reports; the operator sees the run on the canvas and its cost (ARCHITECTURE §19).

**Done when** the e2e passes against `pnpm dev`.

---

## 5. Things to verify, not assume

- Intuit API details (M9) and Google's Gmail and verification rules (M10), see those milestones.
- Anthropic: PDF input limits, the tool-use output format with `tool_choice`, and current model prices (M2/M4). Model ids come from agent definitions, with defaults in §2 of the architecture.
- Cloudflare Workflows (the deploy spike): `waitForEvent` event-type naming rules and maximum timeout (the 5-day doc request must fit); whether an event sent just before the wait starts is kept or lost (the check-before-wait in §1.2 covers the common case); `create` refusing a used instance id; step result size and step count limits; testing waits in `@cloudflare/vitest-pool-workers`. Plenary Labs uses `step.do` and `step.sleep` but not `waitForEvent`, so this part is new.
- Neon + Hyperdrive: `cs_worker` created with SQL on Neon, `force row level security`, and that Hyperdrive's transaction pooling keeps `set_config(..., true)` inside the transaction (session-level settings would leak between requests).
- A Workflow step making a long Claude call (30–90 s) completes. Workers limit CPU time, not time spent waiting on I/O (Plenary Labs' ADR 0001 relies on this too).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Extraction accuracy on messy scans | Totals validation routes failures to review; re-extraction inserts new rows; goldens catch regressions. |
| Matcher false positives (the costly error) | Hard-rule veto on key attributes; precision gate in CI; auto-threshold set per agent version. |
| The canvas grows into a project of its own | Scope is fixed by ARCHITECTURE §10.5; nodes and forms come from schemas, not hand-built per skill; React Flow does the canvas mechanics. Pia's workflows are seeded as graphs, so M8 doesn't wait on canvas polish. |
| Generic platform, nothing finished | Every milestone ends with something runnable; M8 (Pia) is the proof that the platform is enough to build a real agent; nothing in `packages/*` may special-case a pack (layering check). |
| A write to a client's system goes wrong | Every external write is approved by a person, idempotent, records the prior state, and fails on a stale `SyncToken`; test runs never write. |
| RLS bypassed by connecting as owner | The Worker only has `cs_worker`; a test asserts `current_user` isn't the owner in the request path. |
| Workflows' wait semantics differ from this plan | Checked in the M0 deploy spike, before the executor is built on them. The executor only sees `StepRunner`, so a change stays in `apps/api`. |
| QBO app approval delays | Upload connector is the demo path; M9 runs only against the sandbox. |
| Google verification for Gmail's restricted scopes takes weeks, or testing-mode tokens expire after 7 days | Start the Google app verification as soon as M10 begins, in parallel with the build; for Workspace clients, domain-wide delegation granted by their admin avoids it; upload and QBO attachments cover the demo meanwhile. |
| A malicious email steers an agent | Email text only ever reaches a model inside tool results; Gmail writes are drafts and labels, each approved; ingestion is limited to the connection's query. |
| The operator becomes the bottleneck | One catalogue serves every client, so a fix is built once and rolled out; the back office ranks what needs attention across clients; bulk upgrades; the Builder drafts from requests. |
| A bad version reaches every client | Deployments are pinned; publishing changes nothing until a deployment is upgraded; upgrades can be test-run per client; rollback is per deployment. |
| Client data or learning leaks across clients | RLS on `app.tenant_ids` with tests for client and operator sessions; memory and learned records are per client; runs set exactly one client. |

## 7. Owner answers and open questions

Answered (2026-11-03)
- Hosting: keep Cloudflare + Neon for consistency with Plenary Labs (§1.1). Sign-in: WorkOS, as in Plenary Labs.
- UI: the owner is designing the screens on Groundwork; designs to be uploaded.
- Invoices: build on synthetic invoices; real ones can be added later.
- Purchaser routing: undecided. Send all doc requests to an admin for now (§1.1).
- Stack: match Plenary Labs fully: Vite + React + Hono instead of Next.js, Cloudflare Workflows instead of Inngest (ARCHITECTURE v0.2).

- Product shape: an agent platform (connections, skills, agents, drag-and-drop workflows, write-back); material cost management is the first agent, as a pack (ARCHITECTURE v0.3).
- Managed service: advisors review, build and publish; clients connect, approve and request changes (ARCHITECTURE v0.4).
- Managed-agents service suite: the operator's catalogue deployed into clients from a back office; clients get a portal for reports, runs, approvals, connections and requests (ARCHITECTURE v0.5).
- Provisioning: GitHub Actions bootstrap (option 1), Neon in the same region as Plenary Labs.
- Connectors: QuickBooks Online and Gmail first, plus upload (ARCHITECTURE v0.4).
- `main` created from the setup branch (2026-11-03).

Open
1. Groundwork: is there a package or token file to import, or should M0 copy the tokens in by hand? (Probably answered by the design upload.)
2. First QBO writes: proposal is `qbo.attachable.upload` first, then `update_memo` and `update_purchase_cost` (ARCHITECTURE §20).
3. Gmail: which mailbox the millwork shop uses for invoices (shared `ap@` box or a person's), and whether they're on Google Workspace (decides verified app vs domain-wide delegation, ARCHITECTURE §20).
4. Approvals: should external actions default to the client approving, or do some clients want the operator to approve on their behalf? (Both are supported; this sets the default.)
5. Billing: usage is metered per client from v1; how will clients be charged (per agent per month, usage, a mix)? This decides what the back office invoices later.
