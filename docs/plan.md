# Countersign: v1 implementation plan

Source of truth for *what* to build: [`ARCHITECTURE.md`](ARCHITECTURE.md) (v0.8). This file says *how* and
*in what order*. It follows the Build plan (ARCHITECTURE §18) milestone by milestone. Each milestone
ends green: `pnpm typecheck && pnpm test` pass and its "done when" check is shown working.

Nothing here adds to the v1 scope in ARCHITECTURE §1. When this plan fills a gap the architecture leaves
open, it says **DECISION**, and the code carries a `// DECISION:` comment at the spot.

Status: **Phase 1 (foundation, local only) built** (§3). Every platform package, `apps/api` and the `apps/web` shells are in, and `pnpm check` passes against local Postgres with `COUNTERSIGN_REQUIRE_DB=1`. The stack runs locally: migrations and seed, `wrangler dev` with the Worker, a real `RunWorkflow` and the cron on local Postgres (`docs/local-development.md`). Not started: cloud (phase 2) and the product screens, tools and use cases (phase 3; Pia and the Materials pack are not built, `packs/materials` is a stub). Stack: the same as Plenary Labs (§1.1). Product shape: ARCHITECTURE v0.8.

---

## 1. Decisions

### 1.1 Open items from ARCHITECTURE §20

| Item | Decision | Why |
|---|---|---|
| Stack and hosting | **Same as Plenary Labs** (ARCHITECTURE v0.2). `apps/api`: one Hono Worker serving `/api/*`, the built `apps/web` as static assets (`run_worker_first: ["/api/*"]`), the Cloudflare Workflow classes and the cron handler. `apps/web`: React + Vite + React Router. Postgres 16 with pgvector on **Neon** (branches `main` = production, `staging`, plus throwaway `ci-run*` branches per CI run, as in Plenary Labs; environments in `docs/operations.md`). Files in **R2** (Worker binding; S3 API only for signed URLs). Toolchain copied from Plenary Labs: pnpm, TypeScript, Biome, Vitest with `@cloudflare/vitest-pool-workers`. | One stack across projects: same accounts, deploy workflows, runbooks and habits. No Next.js-on-Workers adapter and no second job vendor. Supabase's extras (auth, realtime, storage) are covered by WorkOS, Durable Objects and R2. |
| DB driver from Workers | **Hyperdrive → Neon, with `postgres-js` + Drizzle.** Locally, Hyperdrive's `localConnectionString` points at Docker Postgres. Fallback: Neon's serverless driver in WebSocket `Pool` mode. | `withTenant()` needs interactive transactions (`set_config(..., true)` then queries). Hyperdrive supports them, and Neon's HTTP mode doesn't. Plenary Labs already reaches Neon through Hyperdrive with Drizzle; check `set_config` inside a transaction in the M0 deploy spike. |
| Auth provider | **WorkOS (AuthKit), as in Plenary Labs.** Port its `apps/api/src/identity/` (WorkOS client, AES-GCM sealed session cookie with a 5-minute refresh, provisioning on callback). Identity is the WorkOS user, mapped to `app_user`. A WorkOS organization maps to a `tenant` (`tenant.workos_organization_id`). Roles stay in our `membership` table, so an operator can serve many clients. Behind `packages/auth` with two adapters: `workos` (deployed) and `dev` (local + e2e: seeded users, refused when `NODE_ENV=production`). | Already proven in your stack. Covers what Supabase Auth would add (invites, magic links, client self-serve) plus B2B extras for later (SSO, directory sync, an admin portal per client). |
| Document requests | **Inbox first, routed to an admin.** A `person` step (ask) goes to the client admin's inbox: forward or upload the missing invoice. With Gmail connected (after the MVP) the workflow can also draft an email to the purchaser (approval on). Owner: purchases come from several places (card spend, purchase orders, …), so per-purchaser routing waits until that's designed. | No email leaves without a person. |
| Operating model | **Managed-agents service** (owner, 2026-11-03). One operator (the owner and their team) builds and runs agents for clients from the back office. Agents are built **per client**: reusable ones are **templates**, forked into a client as its own agent, customized for its data and flows, and versioned per client with lineage to the template (ARCHITECTURE v0.6). Clients get a portal and never edit agents. | Every client's data and flows differ, so agents are effectively custom; templates keep that from becoming copy-paste, and lineage lets improvements flow both ways. |
| v1 connectors | **QuickBooks Online and Gmail**, plus upload (owner, 2026-11-03). Gmail: one mailbox per connection (usually a shared `ap@`/`invoices@`), scopes `gmail.readonly`, `gmail.labels`, `gmail.compose`; only messages matching the connection's query are synced (headers, snippet, attachments); bodies fetched on demand; write tools are drafts and labels, each approved. | Email is where most invoices arrive; narrow ingestion keeps the privacy surface small. |
| Embeddings | **Ship without vectors.** `catalog_item.embedding` stays nullable. Candidates come from key attributes plus `pg_trgm`. | §20 says trigram + attributes is enough for v1. Adding a provider later is one tool change. |

### 1.2 Gaps filled while planning

| Topic | Decision |
|---|---|
| IDs (uuid v7) | SQL function `uuid_generate_v7()` (plpgsql) as the column default, so seed scripts, raw SQL and Drizzle all get v7. Postgres 16 has no built-in v7. |
| DB roles and RLS | Same layout as Plenary Labs. **`cs_owner`** (`DIRECT_DATABASE_URL`) owns the database and runs migrations and the seed. **`cs_runtime`** (NOLOGIN; created by the bootstrap workflow or the first migration, whichever runs first, both idempotently) holds every runtime grant. **`cs_worker`** is the Worker's login role: a member of `cs_runtime` only, no `BYPASSRLS`, owns nothing; the Worker, its Workflows and its cron connect as it. `cs_worker` is created **with SQL** (on Neon by `.github/workflows/bootstrap.yml`, locally and in CI by `packages/db/scripts/provision-worker-role.mjs`), never through the Neon console/CLI/API: Neon-managed roles join `neon_superuser` and would skip RLS (Plenary Labs ADR 0002 §15). `scripts/setup-postgres.sh` builds the same roles on a plain Postgres for CI and local work. A test checks effective privileges, inheritance included. (Role names avoid `app_user`, which is a table.) Every tenant table: `enable` + `force row level security`, policy `tenant_id = any(current_setting('app.tenant_ids', true)::uuid[])`. All tenant reads and writes go through `withTenants(ids, tx => …)` (and `withTenant(id, …)` for one), which opens a transaction and runs `set_config('app.tenant_ids', $1, true)`. Client sessions and every run set exactly one id; operator sessions set the clients they serve. Queries also filter by `tenant_id` (§4). |
| Global tables | `tenant` and `app_user` have no `tenant_id` and are read only by `packages/auth` through a narrow owner-side module. **Templates** and shared skills have `tenant_id` null and are visible only in operator sessions (`app.operator = on`, ARCHITECTURE §4). Client agents and client-only skills carry the client's `tenant_id` like any client data. |
| Operator across clients | Back-office sessions carry the set of clients the operator serves (from `membership`); every `/api/ops` request runs inside `withTenants(those ids)`, narrowed by `?client=` when one is selected. Portal sessions carry their one client. The back office has a client switcher; the portal has none. |
| Migrations | `drizzle-kit generate` for tables. Hand-written custom SQL migrations (`drizzle-kit generate --custom`) for extensions, roles, `uuid_generate_v7`, the RLS loop, immutability triggers, and the `item_alias` expression unique index (`coalesce(...)`), which Drizzle can't express. |
| Immutability | One trigger function `forbid_update_except(variadic cols text[])`. Attached to `agent_version`, `skill_version`, `workflow_version` (allow `status`), `raw_record` (allow `is_deleted`) and `doc_extraction` (allow nothing). `DELETE` is blocked on all five. |
| Money | `numeric(14,4)` maps to `string` in Drizzle. `packages/core/money` wraps `decimal.js`. No JS floats for money. |
| Senses outbox | `event` gets one extra column, `dispatched_at timestamptz null`. `emit()` inserts the row inside the caller's transaction. After commit, the Worker dispatches it in `ctx.waitUntil()` (router below) and stamps `dispatched_at`. The cron (every minute) re-dispatches anything undispatched for more than 30 s. Dispatching twice is harmless because run ids are deterministic (next row). |
| Starting runs | One Workflow class, **`RunWorkflow`**, executes any workflow for a client agent. A pure router in `packages/workflows` maps a client's sense event to the enabled workflows in the live version of that client's **active** agents whose trigger `event` and `filter` match. `apps/api` then calls `env.RUN_WORKFLOW.create({ id: runId, params })` for each. **Run ids are deterministic** for triggered runs: uuid v5 of (event id, agent id, workflow slug) for events and of (agent id, workflow slug, scheduled time) for schedules, so a re-dispatch or a repeated cron tick can't start a second run. Manual, command and test runs get a fresh v7. Schedules: the every-minute cron checks each active schedule trigger in the client's timezone (`cron-parser`). // DECISION: v5 for triggered run ids, v7 elsewhere. |
| Waiting on inbox items | The step (a `person` step, or an action that needs approval) creates the inbox item with `run_id`, checks it isn't already resolved, then calls `step.waitForEvent(name, { type: 'inbox-<id without dashes>', timeout })`. `POST /api/inbox/:id/resolve` writes the resolution, then `env.RUN_WORKFLOW.get(runId).sendEvent({ type, payload })`. A timeout throws inside the step; the executor catches it and follows the step's `onTimeout`. If that send fails, the cron re-sends it (§1.5 "Approval resume"). |
| Executor and Workers types | `packages/workflows` runs step lists against a small `StepRunner` interface (`do`, `waitForEvent`, `sleep`) and has no Workers types. `apps/api`'s `RunWorkflow` adapts Cloudflare's `WorkflowStep` to it, the way Plenary Labs' `run-group.ts` passes `step.sleep` in. Unit tests use a fake runner; one Workers-pool test drives the real class. Step outputs stay small (ids and short summaries), because step results have a size limit. A fork evaluates its paths in order and runs the first match; `for_each` runs its steps with the step's `concurrency` (default 10) under names `${stepId}:${index}:${childId}`. |
| Expressions and rules | Fork paths and trigger filters are **rules** (`field op value`, matched all/any), the form the builder shows; they compile to JSONLogic (`json-logic-js`) in `packages/core`. Templates `{{steps.<id>.output.<path>}}` / `{{trigger.<path>}}` / `{{item}}` use a small path resolver in `packages/core`, shared by the builder (field picker, validation) and the executor. No `eval`, no JS. |
| Agents vs `db` | **Agent reasoning reaches business data only through tools.** Inside `packages/agents`, only `src/registry/` (agent, skill and workflow versions) and `src/log/` (step_run, tool_call, external_action) may import `@countersign/db`. Tool handlers live with their owners (platform, connectors, packs). The dependency check enforces this (§2). |
| Seeded and template definitions | Platform templates (`document-clerk`, `coordinator`, `builder`): bundles in `packages/db/seed/agents/<slug>.v1.json`, inserted once as templates. Pack templates (Pia with her workflows) are inserted as templates when the pack is installed; forking them into a client is a separate step. Everything is validated by its Zod schema (and workflow validation) before insert. The runtime only ever reads version rows. |
| LLM record/replay | `packages/llm` hashes (model, system, messages, tools, tool_choice) into `fixtures/llm/<hash>.json`. `LLM_MODE=replay` is the test default and fails loudly on a miss. `record` calls the API and writes the file. `live` doesn't touch fixtures. |
| Cost | Per-model token price table in `packages/llm/pricing.ts`. Check the numbers against current Anthropic pricing when M4 starts; nothing is hard-coded from memory. |
| Extraction input | Send a PDF as a `document` content block (base64) and images as `image` blocks, with `tool_choice` forcing the `record_invoice` tool, whose schema is `InvoiceExtraction` (Zod → JSON Schema). Check page and size limits at M2 and split long PDFs by page if needed. |
| UI | The owner's v1 screens are in `docs/design/` (design file, captures, and `tokens.css` with the 137 Groundwork tokens); they are a starting point and will be reworked page by page. Tailwind + shadcn/ui primitives themed by those tokens (`tokens.css` mapped into the Tailwind theme), so screens use token names, never raw colours. Fonts: Archivo (UI), JetBrains Mono (figures, tags), Source Serif 4 (quotes), from Google Fonts. Agent avatars use the persona colours; Builder suggestions use the `--ai-*` tokens. |
| Live updates | **v1 polls.** The run page polls every 2 s while a run is going; the inbox badge and thread view every 15–30 s. Every long job exposes a status the UI can poll. Later upgrade: push over WebSockets from a Durable Object, the way Plenary Labs' `GroupLog` streams sessions. |
| Workflow model | A **structured step list** (owner's design): trigger, then steps run top to bottom; forks hold ordered paths with rules plus otherwise and join afterwards; `for_each` holds nested steps (ARCHITECTURE §10.1). No free-form edges, so validation, execution and merging all walk one tree. // DECISION: an editor session keeps one rolling draft version of the bundle, saved after 2 s of idle editing, so history isn't flooded; publish is what people see in history. |
| Builder | A nested sortable list with `@dnd-kit/core` + `@dnd-kit/sortable`: drag by handle to reorder, into and out of fork paths and `for_each` blocks; keyboard reordering for accessibility. The add-a-step palette and the inspector's forms are generated from skill and tool schemas, so a new skill appears without UI code. Validation runs in the browser on every change (same code as the server). |
| Packs | A pack is a workspace package under `packs/` exporting a `PackManifest` (ARCHITECTURE §12.1), tool handlers, a Drizzle schema and Hono routes. Its tables go in the one migration sequence (drizzle config lists every pack schema). `apps/api` registers packs in one list; installing a pack adds its templates once; enabling it for a client is a row in `tenant_pack` and allows forking its templates there. |
| External actions | Every write to a client's tool is an `external_action`. **Approval is on by default** (§ Step approvals): the action is written `proposed` with an inbox item in the same transaction; approval flips it to `approved`. When a step runs without approval (step `not_required` + connection `auto` + agent mode `act`), it's written `approved` by the system. Execution runs in its own `step.do` keyed by the idempotency key (`<run id>:<step id>:<index>`), so a retried step can't write twice. Connectors capture `before` where the API allows (QBO: read the record with its `SyncToken` first), automatic or not. |
| Operator skills | Written in the back office as a form (name, description, instructions, a tool picker over every registered tool, input/output field editors that produce JSON Schema, settings with an optional `clientSpecific` flag, an optional summary template). Always `agent` mode. No code. Shared by every agent, or written for one client (`tenant_id` set). |
| Role checks | The route contract in `packages/core` declares each route's roles; Hono middleware enforces them and sets `app.tenant_ids` (and `app.operator` for operators). Two contract tests: every `/api/ops` route is operator-only; no portal route's response schema includes an agent bundle, instructions, prompts or cost fields. |
| Connectors in the portal | The operator offers connectors per client (`tenant.settings.connectors_offered`); the client admin signs in to each from the portal's Connections page (provider OAuth; `connection.connected_by` records who). The operator never connects on a client's behalf and never sees credentials. "Remind" emails the client admin a link to the portal page for that connector; it carries no credentials or authority of its own. |
| Permission matrix | `connection.permissions` per verb (`auto` / `approval` / `off`) plus a connector-specific scope; for writes it's a **ceiling** (`auto` = steps may skip approval, not that they do). Defaults: read auto, create and update approval, delete off. The operator sets it in the back office; the client admin can tighten it in the portal (the API refuses loosening from a client role); each change is a `connection_change` row and applies to the next tool call, overriding any step set to skip approval. |
| Step approvals | (owner, 2026-11-03) Every `action` step, and every `skill` step whose tools can write to a client tool, carries `approval: { required: 'required' | 'not_required', approver?, timeout?, onReject }`, **`required` by default**: new steps, forks, Builder drafts and pack templates all start that way. The builder offers switching it off only where the client's connection allows `auto` for that verb; validation refuses `not_required` elsewhere. Approver: the step's, else the agent's, else the client's setting. Steps that only read or only write the platform's own records have no approval setting; a `person` step is the checkpoint for anything else. |
| Email forwarding (MVP) | Cloudflare Email Routing for `EMAIL_FORWARDING_DOMAIN` → the Worker's `email()` handler; one private address per client on its upload connection (`config.forwarding`), plus allowed senders; MIME parsed with `postal-mime`; PDF and image attachments become `document(source='email')`; headers kept, bodies not. Unknown senders are dropped and counted. // DECISION: forwarding is the MVP's email path; the Gmail connector comes after. |
| Requests | `inbox_item(kind='change_request')` in the operator's request queue, with the subject (a service, a run, or none for a new service) and the client's text. Resolution links the client agent or template versions made for it. The Builder can take the request text as an instruction for that client's agent. |
| Bundles and lineage | One `agent_version` holds the whole `AgentBundle` (definition + workflows + settings). Templates and client agents share the `agent` table (`kind`), so versioning, the editor, the builder, test runs and rollback are one code path. Client versions record `based_on_template_version_id`; merges and promotions record `merged_from_version_ids`. Operational fields (bindings, approver, service name, run status) live on the client `agent` row with an append-only `agent_change` log, so rebinding a connection isn't a new version. |
| Diff and three-way merge | Pure functions in `packages/core` (`diffBundles`, `mergeBundles(base, ours, theirs)`), shared by the server and the merge view. Keys: workflows by `slug`, steps and fork paths by `id` (wherever they sit in the tree), skills by `skill`; objects merge field by field; the order of each step list merges as a sequence (an insert keeps its neighbours; two different reorders, or the same step moved to different places, conflict); other arrays and scalars as whole values. Only-one-side changes are taken; identical changes once; otherwise a conflict `{ path, base, ours, theirs }`. The merged bundle must pass workflow validation before it can be saved. Step and path ids are uuids generated once, copied on fork, never regenerated. |
| Updates and promotion | "Update available" = linked client agent whose `based_on_template_version_id` is older than the template's live version. Applying: `mergeBundles(base = client's base template version, ours = client live, theirs = template live)` → merge draft (`author_type='merge'`) with resolutions applied → test run on that client → publish. Promotion runs the same merge into a template draft (base = client's base template version, ours = template live, theirs = client version) with client-specific values stripped: connection ids, record ids in templates and settings marked `clientSpecific` in the skill's settings schema. // DECISION: no automatic updates in v1. |
| Client agent activation | A client agent becomes `active` only with every required connector bound, a live version, and one passing test run on that client since its last publish. Pausing stops new runs; running ones finish. |
| Client run timeline | Each skill and tool may declare a `summary` template over its output (e.g. `Extracted {{lines.length}} lines from {{header.vendor_name}}`); the executor renders it into `step_run.summary`. No summary → the step's client label + status. Model text never reaches the portal except through these templates. |
| Back office and portal in one app | One SPA with two layouts: `/ops/*` (operator) and everything else (portal). The `/ops` bundle, including the workflow builder, is code-split, so client users never download it. Sign-in lands operators in `/ops` and clients in `/`. |
| Sandbox client | Seeded client "Sandbox" with fixture data (vendors, transactions, invoices, price history), used for building, test runs and demos without touching a real client. |
| Gmail sync | Cron every 5 minutes per connection: `users.history.list` from the stored `historyId`, filtered by the connection's query; if the history id has expired, a bounded `messages.list` with the query replaces it. Attachments are stored once per sha256 as `document(source='email')` and linked like uploads, with the sender domain as a vendor signal. // DECISION: poll, not Pub/Sub push, in v1. |
| Page thumbnails (match review) | Render in the browser with pdf.js from the signed R2 URL. No server-side rendering, so no container is needed. |
| Invoices for fixtures | Synthetic invoices that look like normal vendor invoices. Swap in real (redacted) ones later and re-record. |

### 1.3 Decisions made while building `packages/core`

| Topic | Decision |
|---|---|
| Durations | Cloudflare Workflows' own string form (`"30 seconds"`, `"5 days"`, units up to weeks), so the executor passes them to `step.sleep` / `waitForEvent` unchanged. `parseDuration()` gives milliseconds. |
| Budgets | `budgets.maxCostUsd` is a decimal string (default `"0.50"`), not a JS number, because cost is money (invariant 6). |
| External tools | A `ToolSpec` with `sideEffect: 'external'` must name its `connector`; the gate and the publish check find the connection matrix by it. A `none` tool's verb is `read`. |
| Pack templates | `PackManifest.templates` is a list of `{ slug, bundle: AgentBundle }` (whole bundles, the unit v0.6 versions), not separate agent and workflow lists. |
| Trigger payloads | Event triggers carry the event type's payload; manual triggers their declared input; schedule triggers `{ scheduledAt }`; command triggers `{ args }`. |
| Built-in step outputs | `person` → `{ approved, answer, by }`; `fork` → `{ pathId, pathName }` (which path ran); `for_each` → `{ count }`; `wait`, `notify`, `stop` → nothing. |
| Rule operators | `=` / `!=` compare loosely (JSONLogic `==`), so `"5"` from a form equals `5`; `is` is strict (for `true`, `false`, `null`); `contains` is substring or membership; a rule's value that is exactly one `{{ref}}` compares against that field. An empty `all` matches, an empty `any` doesn't; a fork path with no conditions is a validation error. |
| Merge details | Entity keys `skill:<id>`, `workflow:<slug>`, `step:<id>`, `path:<id>`, `otherwise:<id>`; conflict paths `<key>#<JSON pointer>`, `<key>#@exists`, `<key>#@location`, `<list>#@order`. Two inserts at the same spot are both kept, ours first. Deleting an item conflicts with any edit, insert or move-out inside it on the other side, reported once at the topmost deleted item. A move between lists counts as an edit; a reorder within a list doesn't. Unresolved conflicts keep ours so the draft is always complete. |
| Portal field check | The contract test refuses portal response fields named `bundle`, `definition`, `instructions`, `prompt(s)`, `systemPrompt`, `cost`, `costUsd`, `cost_usd`, `modelCost` and token counts; business figures such as `landedCost` are allowed. |
| Workers tests | `apps/api` pins Vitest 4 for `@cloudflare/vitest-pool-workers` (as Plenary Labs does); the rest of the repo is on Vitest 5. |

### 1.4 Decisions made while building `apps/api` and `apps/web`

| Topic | Decision |
|---|---|
| Route contract | Every route the API serves is declared in `packages/core/src/api/routes.ts` (`routes`); `apps/api` mounts each entry and the contract test checks all of them are mounted; `apps/web`'s typed client calls the same specs. |
| Active client | Sent with each request as `?client=` or the `x-countersign-client` header, never stored in the cookie. A portal user with one client needs neither. |
| Creating a client | The operator who creates a client serves it; the new id (never one from the request) joins the transaction's `app.tenant_ids` so the first membership passes RLS. |
| Invitations | An `app_user` row is the invitation. WorkOS sign-in finds the user by WorkOS id or lets a verified email claim an invited row; it never creates users. WorkOS organizations grant nothing in v1. |
| Auth adapter | `AUTH_PROVIDER` picks it (default: `workos` when `WORKOS_CLIENT_ID` is set). A misconfigured WorkOS answers 503 and never falls back to `dev`; `dev` is refused in production. `GET /api/auth/dev/users` lists seeded users for the dev sign-in screen. |
| Test connector | The testkit connector is registered everywhere except production, so the Sandbox client exercises connections and approvals before any real connector exists. |
| Run rows | Whoever starts a run (API or dispatcher) writes the run row before `RUN_WORKFLOW.create`; `RunWorkflow` writes it again idempotently. Skill and action steps retry 3 times (10 s, exponential), giving up after 15 minutes. |
| Test runs | A template is test-run as its test copy in the Sandbox client (§1.5); runs always belong to a client agent. A test run's person steps go to the operator. |
| Notify | Notify steps post to the run's thread; only `thread` notices of live runs are visible to the client. Email and digest notices stay operator-only until an email provider exists. |
| Model in the Worker | Live or nothing: record/replay is for tests. Without `ANTHROPIC_API_KEY` model calls fail with a clear error; tool-mode skills, actions and person steps still run. |
| Portal inbox | Client users never see operator-assigned items; a `client_user` sees items assigned to them or to `client_user`; a `client_admin` sees the rest. Payloads are stripped of forbidden fields at any depth. |
| Cron | Each client in its own `withTenant` transaction, over the window (previous minute, this minute]. |
| Event payloads | `packages/senses`' event catalog is the contract for payloads; `packages/agents` emits `inbox.resolved` and `external_action.done/failed` in those shapes through its injected `Emit`. |
| Web | React Router 7, Tailwind v4 mapped onto the Groundwork tokens with Tailwind's own palette removed; `/ops` is a separate lazy chunk loaded only after the operator check; a small `useApi` hook instead of a query library. |
| Local Worker | `pnpm dev` runs `wrangler dev --env-file ../../.env`, so the root `.env` gives the local Hyperdrive connection string. |

### 1.5 Decisions made in Track B

| Topic | Decision |
|---|---|
| Approval resume | Delivery of a resolution to its run is durable. A resolved inbox item with a `run_id` is pending until the run records that it took the resolution (`inbox_item.run_received_at`, written by the executor through `InboxPort.received` after the check before waiting or the event). Resolving sends the event after the commit as before; the every-minute cron re-sends the event of every pending item resolved more than a minute and less than a day ago whose run is still `queued`, `running` or `waiting` (`apps/api/src/runs/resume.ts`). Sending again is safe: each item's event type is waited on at most once, the run checks the item before waiting, and `sendEvent` sends nothing to an instance that has ended. A failed send is logged and retried on the next tick. |
| One `step_run` per step | `step_run (run_id, node_id)` is unique (migration 0003); the executor's step log and the agents runtime's `startStepRun` insert with `on conflict do update` (a no-op that returns the existing id), so a retried step, or a step's failure record, reuses its row. |
| Portal sign-in to a tool | `POST /api/connections/:connector/authorize` (client admin only) connects an **offered** connector. Only connectors that need no provider sign-in (`auth: 'none'`, today the testkit) connect from the portal; OAuth connectors answer 409 `not_available` and the portal shows "Not available yet" until the first OAuth connector brings its callback route and state secret (`canSignIn` in `apps/api/src/routes/portal.ts`). A client has at most one connection per connector: reconnecting reuses the row, so its matrix (with the client's tightenings) and the agents' bindings stay. Every status change is a `connection_change`. |
| Disconnect | `DELETE /api/connections/:id` (client admin) sets `disconnected` and drops the credentials; the row, matrix, history and bindings stay. Revoking at the provider (`Connector.revoke`) comes with the first OAuth connector. |
| Offering | `PUT /api/ops/clients/:id/connectors {offered}` sets `tenant.settings.connectors_offered` to registered connectors only (422 otherwise). Withdrawing an offer stops new sign-ins and leaves an existing connection listed in the portal. `GET /api/ops/clients/:id/connections` also answers the offering, every registered connector with its tools, and which agents use each connection. |
| Permission matrix in the UI | One editor for both surfaces (`apps/web/src/connections/`): the operator may choose any level, a client admin only the saved level or stricter, a client user sees badges; delete is shown off and never offered; read offers auto or off (reads run unless off). Edits collect in a draft and are saved together; clients never edit the scope. The API refuses the same things (403 `loosening` / `scope` from the portal). |
| Client timeline sources | `TimelineStep.sources` are the record ids a step's output cites (`output.sources`, invariant 10); nothing else of the output reaches the portal. Record pages to link them to come later; they show as ids. |
| Inbox and run views | The back-office lists carry the agents they name (`agents` on `GET /api/ops/runs` and `/api/ops/inbox`), and `GET /api/ops/runs/:id` the agent, version number and the workflow that ran, so the checklist names steps from the definition (loop nodes `loop:i:child` read as "item i+1"); while a run is going, its unreached top-level steps follow as "not started". "Now / after this change" is the action's `before` against its `input` field by field, hiding `id` and version tokens (`syncToken`, ETags). The operator resolves only items assigned to the operator (or to them); a client's own approvals show whom they wait on. The run page polls every 2 s while going; inboxes every 20 s; run lists every 5 s while any run is going. |
| Template test runs | `POST /api/ops/agents/:id/versions/:vid/test-run` on a template version runs it as the template's **test copy** in the Sandbox client (`tenant.settings.sandbox`, served by the operator; 409 `no_sandbox` otherwise): a client agent with `agent.test_copy`, one per template and client (unique index), forked on the first test run and given a new version holding the template version's bundle (step ids as they are) on later ones, reused when one already matches. The copy keeps its Sandbox bindings across test runs, is never activated (activation refuses it) and so is never routed. The template itself never runs. The response names the run's agent and version. Test-running a template on a chosen real client's data (ARCHITECTURE §10.4, `clientId?`) is not built: it would put a copy agent in a real client. |
| Agent pages' routes | Added to the contract (`apps/api/src/routes/ops-lineage.ts`): `POST /api/ops/agents/:id/retire`; `GET /api/ops/agents/:id/activation` (`ready`, every activation problem, the connectors its live, else latest, version needs bound) so the Settings tab shows the reasons before Activate is pressed; `GET /api/ops/agents/:id/skills` (built-in, shared and the client's own operator skills with live versions, each with its settings schema; a client's own skill shadows a shared one of the same slug, its `shared:` snapshot copies are not offered); `GET /api/ops/agents/:id/versions/:vid/diff?against=` (default: the parent; none for a first version); `GET /api/ops/agents/:id/customizations` (live, else latest, against its base template version); `GET /api/ops/templates/:id/used-by`. Diffs come with a label for every entity, so the screens write sentences without both bundles. |
| Used by | Lists the client agents forked from the template in the clients the operator serves, with base version, versions behind (linked only), customizations (the number of `diffBundles` changes base → current) and the conflicts an update to the template's live version would raise (`mergeBundles`, only when behind). Test copies are not listed: they are not uses of the template. |
| Definition editor | Edits the agent's latest version (draft or live) and saves a new draft with it as `parentVersionId`; workflows and fields the form does not show (extra tools, `canCommand`, avatar) are kept. Skill settings are overrides: an empty field means the skill's default and is dropped. The API's no-op refusal (`409 no_op`) is shown as "nothing changed, no version saved". The model list is the three ids `packages/llm` names, plus any id the bundle already has. |
| New agents | From scratch, a bundle starts with the schema's defaults (`suggest_only`) and one workflow `main`, triggered by hand, no steps, its trigger id a fresh uuid v7. A client agent can start from scratch, from any template version (fork), or as a copy of another served client's published agent. The Builder's "my description" option is shown disabled ("coming soon"). |
| Workflow builder routes | `/ops/templates/:slug/workflows/:workflow` and `/ops/clients/:id/agents/:slug/workflows/:workflow` render the builder inside the agent page (its header and tabs; the Workflow tab opens the first workflow). It edits the agent's **latest** version as a whole bundle, so switching workflows keeps unsaved edits; `/workflow?version=N` still shows an older version read-only. The builder is its own lazy chunk inside `/ops` (`apps/web/src/ops/builder/`). |
| Builder catalog | `GET /api/ops/agents/:id/builder-catalog` answers what the builder types and validates with, as the server does: every skill the agent may use with its full definition (input/output schemas, tools, settings; instructions left out), plus references the latest version already makes (pinned `@version`, snapshots), every registered tool and the connectors' names. `GET /api/ops/catalog/events` now also answers each event's payload schema. The browser runs core's `validateBundle` with that context (and, for a client agent, its bound connections' matrices, as `validateForPublish` does), plus the server's unknown-agent-skill check, so "valid" in the builder means publish will not refuse. |
| Rolling draft | Versions are immutable rows, so the editor session's rolling draft (§1.2 "Workflow model") is kept in the browser (`localStorage`, per agent and the version it was opened on), written after 2 s of idle editing and offered back ("Restored your unsaved changes", Discard) when the builder reopens. A version is written only on Save draft, Test run or Publish (unsaved changes are saved first), so history gets one version per deliberate save. |
| Placing steps | New step, path and trigger ids are uuid v7 made once (core's `uuidv7`) and never regenerated; a trigger keeps its id when what starts the workflow changes. Placing a library skill adds it to the agent's skills, and an action whose tool the agent can't use yet adds the tool to its extra tools, in the same edit (one undo). Every new write step starts with approval on. Remove fork removes the fork and what its paths hold (undo brings them back). Edits to one field within a second are one undo step. |
| Approval control | Shown on steps that change a client's tool. "Run without approval" is offered only on a client agent whose bound connection allows `auto` for every verb the step writes and whose mode is `act`; otherwise the checkbox is locked on with the reason (no binding, the connection requires approval or is off, suggest-only mode). Templates always keep approval on. Switching approval back on is always allowed. Approver: the agent's default, a role, or one of the client's people. |
| Drag and drop | `@dnd-kit/core` + `@dnd-kit/sortable`: one sortable context per list (top level, each fork path, otherwise, each for-each block), "Drop a step here" at the end of every list. Over a step in its own list a step takes that place (arrayMove); from another list it goes in before it; a container never moves into itself. Keyboard: Space on a handle, arrows, Space. Palette items drag in or append with +; a trigger dropped or added replaces how the workflow starts. |

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
apps/web ─▶ core                    (route contract, schemas, workflow validation; HTTP to apps/api)
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

## 3. Build order: the platform first

The **platform is the product** (owner, 2026-11-03). Use cases (Pia and the Materials pack, invoice
intake, collections) and the tools they need (QuickBooks, email forwarding, Gmail, documents
extraction, …) are built on it afterwards. Cloud setup (Neon, Cloudflare, WorkOS) comes after the
foundation.

**Phase 1: Foundation (now, local only).** Everything that every agent, tool and client will rely on,
tied together and tested against local Postgres and `wrangler dev`, with no cloud accounts and no
domain tools:
- toolchain, app and Worker scaffolds, the two UI shells with Groundwork tokens (M0 without the deploy
  spike)
- `packages/core`: every schema (bundle, agent, skill, workflow steps and rules, approvals, tools,
  connectors, packs, events), workflow validation and template typing, rules → JSONLogic, bundle diff
  and three-way merge, canonical hashing, the route contract and roles (M1 core)
- `packages/db`: the platform schema, roles, RLS on `app.tenant_ids` / `app.operator`, immutability
  triggers, migrations, `withTenant(s)`, seed (operator, Sandbox client, platform templates) (M1 db)
- `packages/llm`, `packages/auth` (dev + WorkOS adapters), `packages/senses`
- `packages/connectors`: the connector framework, permission matrix, credential encryption, object
  storage, and a test connector with a read and a write tool (M2 framework; no real connectors)
- `packages/agents`: registries, bundle versions, fork, publish, rollback, the runtime, the permission
  gate with per-step approvals, external actions, logging and usage (M3)
- `packages/workflows`: the step-list executor, trigger router and test runs (M4)
- `apps/api`: Hono routes for the foundation, middleware, `RunWorkflow`, cron; `apps/web`: back office
  and portal shells wired to the API (M5 shells)

Phase 1 progress (2026-11-03):

| Item | State |
|---|---|
| Toolchain, Worker and app scaffolds, UI shells on Groundwork tokens | Done (deploy spike is phase 2) |
| `packages/core` | Done |
| `packages/db` | Done: schema, roles, RLS, immutability triggers, migrations, seed (operator, Sandbox and Demo clients, Builder/Coordinator/Document clerk templates) |
| `packages/llm`, `packages/auth`, `packages/senses` | Done |
| `packages/connectors` | Done: framework, matrix, credential encryption, object storage, OAuth helpers, testkit connector |
| `packages/agents` | Done: registries, versions, fork, publish, rollback, runtime, gate, external actions, logging, usage. The Builder (draft/revise) is not built: its template is seeded, its routes and flows are not |
| `packages/workflows` | Done: executor, trigger router, schedules, test runs |
| `packages/threads`, `packages/documents` | Not started (empty packages; not in phase 1). Notify steps write thread messages through `packages/agents` for now; `/command` parsing and the documents capability come in phase 3 |
| `apps/api` | Done for the foundation routes (session, sign-in, clients, connections, templates, fork, client agents, versions, publish, rollback, operation, activate, pause, runs, test runs, validation, event catalog, inbox; portal overview, inbox, runs, connections, tighten). Track B added retire, activation check, agent skills, version diff, customizations, used-by, connector offering, portal connector authorize and disconnect, the builder catalog and event payload schemas (§1.5). Not yet: the other ARCHITECTURE §14 routes (skills, Builder, update/promote, detach, requests, usage, reports, uploads, documents, users, settings) |
| `apps/web` | Shells done: sign-in, both layouts, clients, client page, agent page. Track B's screens are listed below; the rest are placeholders (phase 3) |
| Local stack | Done: `setup-postgres.sh`, `wrangler dev`, health, session, ops and portal routes, and a test run through `RunWorkflow` checked by hand |
| Screens (Track B) | Done: templates list, new template, new client agent (blank, fork, copy), the agent page's Overview, Versions (diff as sentences, publish, roll back, update available, customizations, used by) and Settings (definition editor, bindings, activate/pause/retire, test run); back-office inbox, runs, run view and client connections (matrix, offering); portal inbox, runs, run timeline and connections. Open: merge view (apply update, promote, detach), OAuth sign-in, `/remind`, requests queue, record pages for sources, activation does not poll a running test run |
| Workflow builder (Track B) | Done (§1.5): the Workflow tab is the builder for templates and client agents; workflow switcher and "add workflow"; header with version badge, counts, Save draft, Test run (sample or manual payload; templates run as their Sandbox test copy) and Publish (refused while invalid); palette (event triggers, the agent's skills then the library, actions grouped by connector, people, logic) with search, drag in or +; numbered cards with kind tags and badges (invalid, approval or runs automatically, hidden from client, customized against the template), drag handles, forks as side-by-side paths with "Drop a step here" and "Paths join here", for-each blocks, delete, undo/redo; inspector with schema-generated input forms, template fields with an upstream-output picker, fork paths as ordered rule rows, skill settings with defaults and the template's value, client timeline label and visibility, and the Approval control; live validation with a clickable problem list that selects the step and focuses the field; the rolling draft in the browser. Checked in Chromium against `pnpm dev` (add, drag into a fork path, save, test run). Open: the merge view; a recent real record as a test-run payload; dragging a whole fork path's steps at once; a Playwright test of the M7 done-when script |
| Foundation follow-ups (Track B) | Done: durable approval resume (cron re-sends until the run takes the resolution), one `step_run` per (run, node) with an upserting step log, template test runs through a Sandbox test copy (§1.5). Open: a test run does not yet refuse a version whose workflow is invalid (ARCHITECTURE §10.2); template test runs on a chosen client's data |

**Phase 2: Cloud.** Bootstrap workflow, deploy spike, staging (M0's deploy spike, `docs/operations.md`).

**Phase 3: Product surfaces and tools, as needed.** The remaining M5–M7 screens (inbox, portal
connections, templates and client agents, the builder, run views), then tools and connectors (upload and
email forwarding, documents, QuickBooks, Gmail) and agents (the Materials pack and Pia, M8–M10).

---

## 4. Milestones

Each milestone lists the work, the tests it adds, and the check that closes it.

### M0: Monorepo, Worker, app, DB, Workflows, auth

Work
- Deploy spike (do this first, against real Cloudflare + Neon, on the resources the Bootstrap cloud workflow created): Worker `countersign-staging` with WorkOS sign-in; Hyperdrive → Neon `staging` with one `withTenant()` round trip (checks `set_config` stays inside the transaction); R2 put, get and a 5-minute signed URL; a `HelloWorkflow` instance that runs one `step.do` making a 60–90 s Claude call, waits on `step.waitForEvent`, resumes on `sendEvent`, and on a second instance takes the timeout path. Any surprise here changes this plan before M1.
- `apps/api`: Hono Worker. `wrangler.jsonc` with assets (`../web/dist`), Hyperdrive, R2 and Workflow bindings, cron `* * * * *`. `/api/health`, `/api/session`. Zod route contract in `packages/core/src/api/`.
- `apps/web`: Vite + React + React Router, Tailwind + shadcn primitives, Groundwork tokens copied from `docs/design/tokens.css`, fonts per §1.2. Two shells (header with client switcher and command-bar placeholder, sidebar as in `docs/design/screens/1-home.png`); the shells (§1.2): back office (`/ops`) and portal, with the ARCHITECTURE §15 screens as placeholders. Typed client from the route contract.
- `packages/db`: Drizzle client (`postgres-js` over Hyperdrive), `drizzle.config.ts` (platform + pack schemas), migration runner (direct URL), `withTenant()`. Migration `0000_platform`: extensions (`vector`, `pg_trgm`, `pgcrypto`), `uuid_generate_v7()`, the `cs_runtime` role and its grants, plus the `tenant`, `app_user` and `membership` tables (M1 adds the rest).
- `packages/auth`: `getSession()`, `requireRole()`, `activeTenant()`. `dev` and `workos` adapters (ported from Plenary Labs' `apps/api/src/identity/`).
- Seed: the operator (`operator@example.com`), clients "Sandbox" and "Millwork demo", one client_admin for the millwork client.
- `packages/db/scripts/provision-worker-role.mjs`: creates or re-keys `cs_worker` (used by `scripts/setup-postgres.sh` and on each Neon branch). Port Plenary Labs' `scripts/connect.sh` to wire Hyperdrive and local env files.
- Already done in repo setup: toolchain, Biome, `scripts/check-deps.mjs` (including the pack rules), `pnpm dev` / `dev:web` scripts, `ci.yml` / `checks.yml` / `deploy.yml`, `scripts/setup-postgres.sh`. M0 adds `wrangler`, `@cloudflare/vitest-pool-workers`, Vite and React, and the `staging` env in `apps/api/wrangler.jsonc`.

Tests: `withTenant` sets and clears the setting; check-deps fails on a bad import (fixture); `HelloWorkflow` resumes on an event and times out without one (Workers pool).

**Done when** `pnpm dev` runs the Worker (API + Workflows) and the app, signing in as the operator lands on the back office shell and as the client admin on the portal shell, and the deployed spike signs in through WorkOS, reads a tenant row from Neon and resumes a waiting Workflow.

### M1: Platform schema, core schemas, workflow validation, merge, seed

Work
- Drizzle schema for ARCHITECTURE §5.1–5.3: connections and raw data, `external_action`, shared business records, `tenant_pack`, skills, agents (templates and client agents) with bundle versions and lineage, `agent_change`, runs, events, threads, inbox, memory (per client agent), `usage_daily`.
- Custom migrations: RLS loop over every tenant table (`app.tenant_ids` policy; for `skill`, `skill_version`, `agent`, `agent_version`, `agent_change` also `tenant_id is null and app.operator`), `forbid_update_except` triggers (§1.2), grants to `cs_runtime`.
- `packages/core`: Zod schemas `AgentBundle`, `AgentDefinition` v2, `SkillDefinition`, `Workflow` + step kinds and rules, `ToolSpec`, `ConnectorManifest`, `PackManifest`, `EventTypeSpec`, each also exported as JSON Schema. **Workflow validation** (ARCHITECTURE §10.2) returning errors with node id and field, the template resolver + typer, and **`diffBundles` / `mergeBundles`** (§1.2). Units table and conversions. Money.
- Seed: operator, Sandbox and Millwork clients with users, platform templates (`document-clerk`, `coordinator`, `builder`) as v1 rows, Sandbox fixture data. `bundle_hash` = sha256 of canonical JSON (sorted keys).

Tests
- Migrations apply on an empty DB, roll back, re-apply; the seed runs twice without duplicates.
- RLS: as `cs_worker`, a session for client A sees nothing of client B on every tenant table (one test loops over the table list); an operator session for {A, B} sees both and nothing of C; no ids set → no rows. Privileges: `cs_worker` is not a member of `neon_superuser` and can't bypass RLS.
- Immutability: `UPDATE agent_version SET bundle…` fails; `UPDATE … SET status` works; `DELETE` fails. Same for the other version tables, `raw_record` and `doc_extraction`.
- Merge (may land with the update work after the MVP): golden cases (ARCHITECTURE §19) including a conflict per kind; merge never regenerates ids; fork → edit → merge → rollback round trip.
- Workflow validation: one failing fixture per rule, plus valid fixtures for every step kind; template typing across fork paths (a field produced inside a path is unavailable after the join); rules compile to the expected JSONLogic.

**Done when** migrations apply, RLS holds for client and operator sessions (templates invisible to client sessions), the seed inserts the operator, clients and platform templates, and the validation and merge suites pass.

### M2: Connector framework, upload, documents

Work
- `packages/connectors`: `Connector` interface and manifest (ARCHITECTURE §6.1), connector registry, `ObjectStore` (R2 binding; local adapter for tests). `upload/`: files go to `document(source='upload')`, stored once per sha256; **email forwarding** (§1.2): the `email()` handler, per-client addresses, allowed senders, attachments to `document(source='email')`; CSV of purchases goes to `raw_record(connector='upload')`, then `mapUploadPurchase` produces transactions.
- `packages/core/mappers`: raw → `TransactionInput` (upload now, QBO in M9).
- `packages/llm`: client wrapper, record/replay, cost accounting, `callTool<T>(schema)`.
- `packages/documents`: store, `findSupport(transactionId)`, `extract(documentId)` → `doc_extraction` + `doc_line` (always a new row), `validateTotals()` (ARCHITECTURE §7), `linkToTransaction()` by vendor + total + date ±7 days. Platform tools `docs.*` and skills `docs.find-support`, `docs.extract`.
- `POST /api/uploads`, `GET /api/documents/:id` (5-minute signed URL + latest extraction), `GET /api/connectors`.
- Fixtures: 3 synthetic millwork invoices (sheet goods, hardwood, hardware/finishes; one with freight + fuel surcharge; one multi-page) plus `*.expected.json`. Recorded LLM responses.

Tests: forwarding accepts only allowed senders, stores attachments once, keeps no bodies (fixture `.eml` files); totals validation (tolerance edges); golden extraction in replay mode (header exact; each line: qty and prices within $0.01, description fuzzy ≥ 0.9); dedupe by sha256; linking window; manifests validate.

**Done when** uploading the 3 fixture invoices produces extractions that match the expected JSON within tolerance.

### M3: Registries, agent runtime, permission gate, external actions

Work in `packages/agents`.
- `registry/`: tool registry (platform + connector + pack sources), skill registry (built-ins from code, operator-written skills from `skill_version` rows, shared or per client), agent registry (resolve a client agent's live or given version; availability per client; `createVersion` rejecting a no-op by hash; `publish` in one transaction; `rollback` as a copy), fork (template version → client agent v1, ids kept), and the operational fields with `agent_change`.
- `runtime/`: `runAgent()` per ARCHITECTURE §9.5: tool-mode skills call their handler; agent-mode skills run the loop with the skill's tools and a `finish` tool typed to the skill output; budgets → `escalated` + inbox item; `sources` required for skills that produce alerts. Document text only ever in tool results (§16).
- Permission gate and **external actions** (§1.2): `none` runs; `internal` runs if allowed, else approval; `external` needs approval unless the step says `not_required`, the connection allows `auto` and the agent's mode is `act` (§1.2 Step approvals); `off` is refused.
- `log/`: `step_run` (with `summary` from the skill's template), `tool_call`, `external_action` rows with tokens and cost; `usage_daily` rollup.
- A test-only connector (`testkit`) with one read tool and one external write tool, so external actions are tested without QBO.

Tests: version publish/rollback/no-op for agents and skills; the gate gives each verb × connection setting × step approval × agent mode the right outcome (approval whenever any of them says so); a client tightening the matrix overrides a step at once; an approved external action executes exactly once across a retried step; a rejected one never executes; budget hit escalates; a test agent with `docs.extract` in replay mode.

**Done when** a test template forked into the Sandbox client runs `docs.extract` end to end and logs cost, and its external tool call creates an approval and executes once when approved.

### M4: Workflow executor, triggers, senses, test runs

Work
- `packages/senses`: typed `emit()` (outbox), `undispatched()`, `markDispatched()`. Emitted by mappers, documents, inbox and external actions.
- `packages/workflows`: trigger router over the live versions of active client agents, `StepRunner` interface, executors for every step kind, fork path order and `for_each` (ARCHITECTURE §10.1, §10.3); each step writes `step_run`; cost rolls up to `run`; every run appends to its subject's thread.
- `apps/api`: `RunWorkflow` class, after-commit dispatch in `ctx.waitUntil`, cron sweep and schedule check, manual and command triggers. **Test runs** (`mode='test'`): external actions recorded as proposed only, no events emitted.
- Event catalogue (`GET /api/catalog/events`): platform + enabled pack event types with sample payloads.

Tests: template resolution; JSONLogic conditions; an event for client A starts only A's agents; a paused client agent starts nothing; a template never runs except as a test; schedules fire in the client's timezone; executor with a fake `StepRunner` for every step kind, first-match fork paths, otherwise, for_each with concurrency, a wait that resolves and one that times out; `RunWorkflow` in the Workers pool for one full run; a re-dispatched event doesn't start a second run; the cron sweep picks up an undispatched event; a test run never executes an external action.

**Done when** a workflow with a fork, a for_each and a person approval runs to the end for one client's agent and never starts for another client, and a test run proposes but never executes external actions.

### M5: Back office and portal shells, onboarding, inbox, requests

Work
- **Back office** (`/ops`): overview (needs attention across clients: failed runs, operator inbox, open requests, connections a client needs to reconnect, template updates waiting); clients list with health; new client (create, invite the client admin through WorkOS, offer connectors, packs, approval delegation); client detail shell with connectors offered, their health, permission matrix and configuration; operator inbox; requests queue.
- **Portal**: overview shell (services, what needs you); inbox (approval, external action with tool / target record / now and after this change, request, extraction review); **connections** (owner's design, screen 2): offered tools, sign in (provider OAuth), reconnect, disconnect, what agents may do in each tool (view; tighten only), used by, upload; requests (raise, see status); settings (users, notifications).
- `POST /api/inbox/:id/resolve` (and the `/ops` twin) → resolution + `inbox.resolved` + `sendEvent` to the waiting run. Approver from the client agent, else the client setting; every approval records who.
- Role checks and both contract tests (§1.2). Threads basics with `audience` (operator-only notes never in the portal).

Tests: resolving an approval resumes the waiting run (Workers pool); client_user sees only items assigned to them; a client admin can tighten but not loosen a permission matrix; only offered connectors can be connected; operator roles can't call the client's authorize route; the contract tests; an operator sees only the clients they serve.

**Done when** the operator creates a client, offers it the upload connector and invites its admin; the admin signs in to the portal, sees the offered connectors and their permissions, approves an item that resumes a run, and raises a request the operator sees in the queue.

### M6: Templates and client agents

Work
- **Templates** (`/ops/templates`): list; new (from scratch: name, role, mission, instructions, model; or describe → Builder); editor (identity, instructions, skills with settings, extra tools, permissions with the external-never-auto rule shown, budgets); versions with change and release notes, diffs, publish, rollback; "Used by" (each client agent: base version, versions behind, customizations, conflicts); skills library with the operator skill editor (ARCHITECTURE §9.2); packs.
- **Client agents** (`/ops/clients/[id]/agents`): fork a template (version, slug, service name), or create from scratch, or copy another client's agent; the same editor; customizations view (diff vs base template version); versions, publish, rollback; bindings, approver, test run on the client's data, activate, pause, retire; detach and re-link.
- **Updates and promotion**: update preview (merged result, conflicts), resolutions in a table view (step conflicts get the builder's merge view in M7), merge draft, test run, publish; promote selected changes into a template draft.
- Builder: `draft-agent` (template, or client agent with `clientId`) and `revise-agent` (ARCHITECTURE §9.6); server guards; drafts open in the editor and the canvas.
- Portal: services list and service page (name, description, status, recent runs) from active client agents.

Tests: guards hold even when the model output violates them (external tool in `auto`, unknown skill, invalid workflow); fork keeps ids and base version; activation refuses missing bindings or no passing test run; a template publish changes no client agent; update with and without conflicts; promotion strips client-specific values; rollback per client; client roles get 403 on every `/api/ops` route; the Builder script below in replay mode.

**Done when** the operator builds a template, forks it into two clients and customizes each differently, publishes template v2 and merges it into both (one clean, one with a resolved conflict) keeping each client's customizations, promotes one client's change into template v3, and rolls one client back; "flag card charges over $500 missing receipts" produces a valid draft with gaps listed (no card connector); each client sees only its own services in the portal.

### M7: Workflow builder, merge view and run view

Work (`apps/web`, ARCHITECTURE §10.5, owner's design screens 4–7)
- Builder: header (name, version badge, counts of steps, forks, actions and approvals; Test run; Publish; tabs); add-a-step palette (triggers from the event catalogue, the agent's skills then the library, actions grouped by tool, people, logic); numbered step list with drag handles, forks as side-by-side paths with "Drop a step here" and "paths join here", `for_each` blocks; delete, undo/redo, keyboard reordering.
- Inspector: forms generated from skill/tool input schemas; template field picker of upstream outputs valid at the step; fork path rule rows (+ Add condition, + Add path, remove fork); settings with defaults, and on a client agent the template's value beside a customized one; client timeline label and visibility; for steps that change a tool, the **Approval** control (on by default; "run without approval" offered only where the client's connection allows it) with the approver, and badges for which steps will wait and which run automatically.
- Live validation (shared `packages/core` code) with step badges and a clickable summary; save draft; test run with a chosen payload (sample event, recent record, manual input); publish; versions with a step-by-step diff and rollback; "Based on template vN" / "Used by"; updates and promotion.
- **Merge view**: the step list with each step marked added, removed, changed or moved per side; conflicts resolved per step or field; validation on the merged workflow.
- **Run view** (screen 6): what it did as a checklist with summaries, cost and links; changes to your tools as now / after this change with approve, reject, edit lines; full log.
- New agent flow (screen 4): describe → Builder's suggested steps → open in builder; or blank; or a template.
- Portal run timeline (ARCHITECTURE §10.6): client-visible steps with label, status, time, summary, sources and approvals; no costs, instructions or internal steps.

Tests: component tests for add, drag to reorder, move into and out of a fork path, delete, undo, invalid markers; a round trip (builder → workflow JSON → builder) keeps every step, path and id; the done-when script as a Playwright test against `pnpm dev`.

**Done when** the operator customizes a client's workflow in the builder (adds a step, adds a fork path with two rules), test-runs it on that client's data and publishes; resolves a conflict from a template update in the merge view; and watches the live run in the run view while the client sees the timeline without internals or cost.

### M8: Materials pack and Pia

Work in `packs/materials` (ARCHITECTURE §12.2–12.4).
- Schema (`catalog_item`, `item_alias`, `item_match`, `price_observation`) in the shared migration sequence, with RLS and grants; the `item_alias` expression unique index.
- Catalog: `normalize()`, parsers (sheet goods, hardwood, hardware required; mouldings/edgebanding and finishes/adhesives basic + LLM fallback), each declaring **key attributes**; alias lookup → candidates (equal key attributes, then `pg_trgm`) → Haiku adjudication → route by `match_confidence_auto` → hard rules as a veto; alias learning on human decisions; merge.
- Pricing: `record()` (std unit price; freight not folded in; landed cost separate); the 6 alert rules with thresholds from skill settings; `dollar_impact`; one open alert per (kind, item, vendor).
- Manifest: tools, skills (with summary templates and `clientSpecific` settings such as vendor lists), events, the Pia template with both workflows (validated by the same workflow validation); enabling the pack for the millwork client, forking Pia into it and customizing her (its vendors, categories, thresholds, approvers).
- Screens under `apps/web/src/packs/materials/`: portal reports Price watch (item × vendor table with last price, Δ%, 90-day sparkline; alerts with evidence links) and Catalog, with CSV export; the same views for any client in the back office, plus merge; match review card in the Inbox. Portal activity report (runs, documents processed, actions taken, alerts and dollar impact for the period).
- Fixtures: `fixtures/matching/*.json` (≥ 150 labeled pairs, heavy on near-misses: 3/4 vs 1/2, BB/BB vs B/BB, 4x8 vs 5x5, prefinished vs not); seed script `seed:demo-prices` (6 months, ~10 items, 3 vendors).

Tests: parser tables (`3/4"`, `.75`, `18MM`, `23/32` → `3/4in`; `4X8`, `48X96`, `4'X8'` → `48x96in`); golden precision ≥ 95% on "same" at the auto threshold, recall reported; Baltic birch across 3 vendors → one item; one table-driven test per alert rule at the threshold edge; dedupe; UOM guard; the pack's templates pass graph validation; layering (the pack imports no `agents`/`workflows`).

**Done when** golden tests pass, Baltic birch matches across 3 vendors, an invoice uploaded by the millwork client runs its own Pia's purchase-intake to priced lines with a `price_jump` alert, and the client sees it in Price watch.

### M9: QuickBooks Online

First, check against Intuit's current developer docs: base URLs, minor version, CDC limits, webhook signature header and payload format, Attachable download and upload, sparse updates and `SyncToken` rules, throttling limits and the current API terms. Record the findings in `packages/connectors/src/qbo/NOTES.md`.

Work: OAuth from the portal's Connections page (authorize, callback, encrypted tokens with AES-256-GCM, refresh and persist the new refresh token every time); initial sync with paging; CDC every 15 min plus a webhook nudge (`POST /api/webhooks/qbo` verifies the HMAC and starts a `QboSyncWorkflow` instance for the realm); attachables fetched, stored once per sha256 and linked; per-realm throttle with backoff on 429; QBO mappers including both line detail types; read tools; the MVP write tools `qbo.bill.update_lines` / `qbo.purchase.update_lines` (refused if the total would change) and `qbo.attachable.upload`, approval on by default, with `before` capture and stale-`SyncToken` handling.

Tests: mappers on `fixtures/qbo/*`; webhook signature; token refresh rotation; sync is idempotent per `(connection, entity, id, SyncToken)`; a write with a stale token fails cleanly and leaves the action `failed` with the reason.

**Done when** a sandbox company syncs, a Bill flows through intake, and approving in the portal itemizes its lines (total unchanged) and attaches the invoice in the sandbox. **MVP exit** (§3) follows on the shop's production QuickBooks.

### M10: Gmail (after the MVP)

First, check Google's current documentation: scope classifications for `gmail.readonly`, `gmail.labels` and `gmail.compose`; OAuth app verification and the security assessment for restricted scopes; the user cap and warning for unverified apps; refresh-token expiry for apps in "testing" status; `history.list` retention; quotas. Record the findings and the chosen route (verified app, or domain-wide delegation for Workspace clients) in `packages/connectors/src/gmail/NOTES.md`.

Work: OAuth (authorize, callback, encrypted tokens, refresh); the connection's ingestion query (operator-set, default per ARCHITECTURE §6.4) and its editor on `/connections`; sync per §1.2 (history polling, expiry fallback, attachments as documents, dedupe by sha256, link to transactions with the sender domain as a signal); read tools `gmail.message.search`, `gmail.message.get`, `gmail.attachment.get`; write tools `gmail.draft.create`, `gmail.label.apply` behind approval; the Gmail step in `docs.find-support`; disconnect revokes the token and stops sync. The Pia template gains the Gmail draft and label steps as a new version; each client's Pia gets it as a template update the operator merges when ready.

Tests: sync against recorded Gmail API fixtures (`fixtures/gmail/`): only query matches are stored, bodies are not; history expiry falls back to search; attachments dedupe; draft and label tools only run after approval and run once; email body text reaches agents only inside tool results.

**Done when** a test mailbox connects, an emailed invoice is found for its QBO transaction and flows through intake, and an approved `gmail.draft.create` appears in the mailbox's drafts.

### M11: Usage, reports, notifications, end-to-end

Work: back-office usage and cost (per client, client agent and template, by month; `usage_daily`); portal overview and activity report polish; notification emails to clients (weekly digest, items waiting); every alert and external action links to its run; empty states and first-run guidance for the operator (create client → invite → connect links → enable packs → deploy) and for clients (connect your tools → your inbox).

Tests: Playwright e2e: the operator creates a client, forks Pia into it and customizes her → the client admin signs in to its tools in the portal and uploads an invoice → approves in the portal → sees the activity and Price watch reports; the operator publishes a Pia template update and merges it into that client; the operator sees the runs and their cost (ARCHITECTURE §19).

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
| The builder grows into a project of its own | Scope is fixed by ARCHITECTURE §10.5 and the owner's design; a structured list is far simpler than a node canvas; forms and the palette come from schemas, not hand-built per skill; Pia's workflows are seeded as data, so M8 doesn't wait on builder polish. |
| An automatic write does something unwanted in a client's system | Writes default to approval and delete is off; only the operator loosens a matrix and the client can tighten it at any time; every write records its before state and the run that made it; actions show in the run view and the portal timeline. |
| Generic platform, nothing finished | Every milestone ends with something runnable; M8 (Pia) is the proof that the platform is enough to build a real agent; nothing in `packages/*` may special-case a pack (layering check). |
| A write to a client's system goes wrong | Every external write is approved by a person, idempotent, records the prior state, and fails on a stale `SyncToken`; test runs never write. |
| RLS bypassed by connecting as owner | The Worker only has `cs_worker`; a test asserts `current_user` isn't the owner in the request path. |
| Workflows' wait semantics differ from this plan | Checked in the M0 deploy spike, before the executor is built on them. The executor only sees `StepRunner`, so a change stays in `apps/api`. |
| QBO app approval delays | Upload connector is the demo path; M9 runs only against the sandbox. |
| Google verification for Gmail's restricted scopes takes weeks, or testing-mode tokens expire after 7 days | Start the Google app verification as soon as M10 begins, in parallel with the build; for Workspace clients, domain-wide delegation granted by their admin avoids it; upload and QBO attachments cover the demo meanwhile. |
| A malicious email steers an agent | Email text only ever reaches a model inside tool results; Gmail writes are drafts and labels, each approved; ingestion is limited to the connection's query. |
| The operator becomes the bottleneck | Templates mean a client agent starts from proven work; template updates reach every linked client as one review each; the back office ranks what needs attention across clients; the Builder drafts from requests. |
| A bad version reaches every client | Template publishes change no client; each client's update is a reviewed merge with a test run on that client; rollback is per client. |
| Merges lose or garble a client's customizations | Merge is pure, deterministic and covered by golden cases; conflicts are never auto-resolved; the merged workflows must validate; the merge draft is test-run before publish; the previous version stays one click away. |
| Forks drift until templates stop helping | The template page shows customizations and versions behind for every client; promotion folds good client changes back; detaching is explicit. |
| Client data or learning leaks across clients | RLS on `app.tenant_ids` with tests for client and operator sessions; memory and learned records are per client; runs set exactly one client. |

## 7. Owner answers and open questions

Answered (2026-11-03)
- Hosting: keep Cloudflare + Neon for consistency with Plenary Labs (§1.1). Sign-in: WorkOS, as in Plenary Labs.
- UI: the owner's v1 screens are in `docs/design/`, a starting point to rework page by page (2026-11-03).
- Connectors work at the client portal level: the operator builds and offers them, clients sign in to their own tools (2026-11-03).
- Approvals are on by default and set per step where a step changes a client's tool (2026-11-03).
- No Slack yet; build an MVP first (2026-11-03).
- Invoices: build on synthetic invoices; real ones can be added later.
- Purchaser routing: undecided. Send all doc requests to an admin for now (§1.1).
- Stack: match Plenary Labs fully: Vite + React + Hono instead of Next.js, Cloudflare Workflows instead of Inngest (ARCHITECTURE v0.2).

- Product shape: an agent platform (connections, skills, agents, drag-and-drop workflows, write-back); material cost management is the first agent, as a pack (ARCHITECTURE v0.3).
- Managed service: advisors review, build and publish; clients connect, approve and request changes (ARCHITECTURE v0.4).
- Managed-agents service suite: the operator builds and runs agents from a back office; clients get a portal for reports, runs, approvals, connections and requests (ARCHITECTURE v0.5).
- Templates and client agents: agents are built per client from reusable templates, versioned per client with lineage, template updates merged per client, client changes promotable to templates (ARCHITECTURE v0.6).
- Provisioning: GitHub Actions bootstrap (option 1), Neon in the same region as Plenary Labs.
- Separation: Countersign is fully separate from Plenary Labs (no runtime dependency, data, infrastructure, keys or secrets in common); it follows Plenary Labs' stack, rules and patterns for consistency (owner, 2026-11-03).
- Connectors: QuickBooks Online and Gmail first, plus upload (ARCHITECTURE v0.4).
- `main` created from the setup branch (2026-11-03).

Open
1. Email for the MVP: forwarding to a private address (built in, no Google review) instead of Gmail, with the Gmail connector right after. Confirm, or move Gmail into the MVP.
2. First QBO writes: proposal is `qbo.attachable.upload` first, then `update_memo` and `update_purchase_cost` (ARCHITECTURE §20).
3. Gmail: which mailbox the millwork shop uses for invoices (shared `ap@` box or a person's), and whether they're on Google Workspace (decides verified app vs domain-wide delegation, ARCHITECTURE §20).
4. Approvals: should external actions default to the client approving, or do some clients want the operator to approve on their behalf? (Both are supported; this sets the default.)
5. Billing: usage is metered per client from v1; how will clients be charged (per agent per month, usage, a mix)? This decides what the back office invoices later.
