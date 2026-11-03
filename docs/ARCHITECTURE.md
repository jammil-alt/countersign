# Back Office Agent Platform — Architecture v0.5

> **v0.5 (2026-11-03, owner):** a **managed-agents service suite**, not each client's own agent layer.
> The operator (the owner and their team) builds a **catalogue** of agents, skills and workflows once, in
> a **back office** that reaches into every client, and **deploys** them to clients with per-client
> settings and connections. Clients get a **portal** with self-service around reports, runs, approvals,
> connections and requests; they never edit agents. "Advisor" becomes **operator**. Changed: §1, §3, §4,
> §5.3, §9.2, §9.3, §9.5, §9.6, §9.7, §10.1, §10.3–10.5, §11, §12.1, §12.2, §13–16, §18–20.
>
> **v0.4 (2026-11-03, owner):** a **managed service**, not self-serve. Advisors (our team) build, review and
> publish every agent, skill and workflow; clients connect their tools, approve what agents want to do,
> answer requests, see their agents' work read-only, and ask for changes. Connectors for v1:
> **QuickBooks Online and Gmail**, plus upload. Changed: §1, §4, §6.4 (new), §7, §9.2, §9.6, §10.5, §11,
> §12.2, §14, §15, §16, §17, §18, §20.
>
> **v0.3 (2026-11-03, owner):** the product is the **agent platform**. A business connects its tools in
> one place; people create agents from scratch, give them skills, and lay out their work as a
> drag-and-drop workflow; agents run that work, ask people when they must, and update the connected
> tools. Material cost management is no longer the product: it is the **first agent**, shipped as the
> Materials pack (§12) and built from the same parts any customer uses. The visual workflow editor and
> gated write-back to connected tools move into v1.
>
> **v0.2 (2026-11-03, owner):** the stack matches Plenary Labs: Vite + React + Hono on Cloudflare Workers,
> Cloudflare Workflows, Neon through Hyperdrive, R2, WorkOS.

> **For Claude Code:** this is the source of truth for the v1 build. Read it fully, then follow the
> implementation plan in `docs/plan.md`, which follows the **Build plan** (§18) in order. Where this doc
> says "decision", follow it. Where it says "open", choose the simplest option and leave a `// DECISION:`
> comment. Do not add features outside §1's v1 scope.

Product design (screens, use case narrative) lives in the companion design doc, built on the Groundwork
design system. This file covers how to build it.

---

## 1. What we are building

A **managed-agents service suite for back-office work.** The operator (the owner and their team) runs
agents for many client businesses from one back office. Agents are the operator's: built once, kept in a
catalogue, and deployed into each client that buys them. Clients connect their systems, approve what
agents want to do, and see the work in a portal.

Two surfaces, one platform:

- **The back office** (operator): every client in one place. Build and version agents, skills and
  workflows (drag-and-drop canvas), deploy them to clients with per-client settings and connections,
  test them against a client's own data, roll new versions out client by client, watch runs and failures
  across clients, work clients' requests, and see usage and model cost per client and per agent.
- **The client portal** (each client): self-service around the service they receive: what their agents
  did (reports and outcomes), runs as a plain-language timeline, the inbox (approve writes, answer
  requests, review matches), connections (connect or reconnect QuickBooks and Gmail), requests to the
  operator, and their users. No agent building, no prompts, no canvas, no model costs.

How the parts fit:

1. **Connections.** Each client connects its tools (QuickBooks Online and Gmail, plus upload) from a link
   the operator sends. A connection brings data in and exposes **tools**: actions agents can take
   against that system, reads and writes.
2. **Skills.** Reusable capabilities ("extract an invoice", "find the receipt for a transaction", "match
   line items to the catalog", "write a weekly summary"): instructions plus the tools they need, typed
   input and output, settings. Built in (platform and packs) or written by the operator.
3. **Agents.** The operator creates an agent from scratch, or describes it and lets the Builder draft it:
   identity, instructions, skills, permissions, budgets. Every change is a new, immutable version.
4. **Workflows.** The operator lays out an agent's work on the canvas: triggers, skill steps, conditions,
   approvals, requests to people, tool actions, notifications.
5. **Deployments.** The operator deploys an agent (with its workflows) to a client: picks the version,
   binds the client's connections, sets per-client settings and approvers, test-runs it on the client's
   data, and switches it on. New versions roll out per client, never silently.
6. **Runs.** Agents do the work and update the client's tools; every run is logged step by step with cost
   (operator-only); every write to a client's system goes through a person's approval in v1.
7. **Requests.** A client asks for a change or a new service from the portal; it lands in the operator's
   queue.

### Concepts

| Concept | What it is | Defined in |
|---|---|---|
| Operator | The owner and their team; one back office across all clients | §4 |
| Client | A business served by the operator (a tenant); its data is isolated | §4 |
| Connection | One client's link to an external system (credentials, sync state) | §6 |
| Tool | One atomic action with typed input/output and a side-effect level (`none`, `internal`, `external`) | §6.1, §9.4 |
| Skill | A reusable capability: instructions + tools + input/output schema + settings; in the catalogue | §9.2 |
| Agent | Identity, instructions, skills, permissions, budgets; versioned; in the catalogue | §9.1 |
| Workflow | A graph of steps an agent runs, edited on the canvas; versioned; in the catalogue | §10 |
| Deployment | An agent running for one client: pinned versions, connection bindings, settings, approvers, status | §9.3 |
| Run | One execution of a deployed workflow, with every step, tool call and cost | §10.3 |
| Inbox | Where people approve, review and answer what agents ask | §11 |
| Request | A client's ask to the operator (change or new service) | §11 |
| Pack | A bundle of domain tools, skills, tables, reports and template agents (e.g. Materials) | §12 |

### First client and first agent

First client: a ~$2M millwork shop. First agent: **Pia, the Materials agent** (Materials pack, §12).
She pulls purchases, finds the supporting invoice, extracts line items, matches each line to a shared
item catalog (e.g. "BB PLY 3/4 4X8" from vendor A and "Baltic Birch 18mm 48x96" from vendor B are the
same item), records unit prices, and alerts when prices change. Pia is a catalogue agent built entirely
from platform parts, with two workflows on the same canvas the operator uses for everything; the
millwork shop gets her as a deployment. **Nothing in the platform core is material-specific;** a check
enforces that platform packages never import a pack (§3).

### v1 scope (build today)

In:
- Tenancy for many clients, one operator; roles `operator`, `client_admin`, `client_user`; operator-led
  onboarding (create client, invite users, send connect links); a **sandbox client** with fixture data
  for building and demos
- Connector framework (manifest: auth, synced entities, tools). Connectors: **QuickBooks Online**
  (sandbox + production; read sync plus write tools), **Gmail** (find invoices and receipts in a
  mailbox; drafts and labels as write tools), and **upload** (PDF/image documents, CSV)
- Documents capability: store originals, extract with Claude, validate, link to records
- **Catalogue** (operator): skills (built-in + operator-written, no code), agents (from scratch or the
  Builder), workflows on the **drag-and-drop canvas**; immutable versions, publish, rollback; items can
  be shared by all clients or built for one
- **Deployments** (operator): deploy, configure per client, test-run on the client's data, activate,
  pause, upgrade and roll back per client; see which clients run which version
- Workflow engine executing deployed graphs; triggers by event, schedule, manual and command
- **Write-back:** external tools act on client systems, always behind an approval in v1, with an audit
  record per action
- **Back office:** clients overview and health, client detail, runs and failures across clients, request
  queue, operator inbox, usage and model cost per client and agent
- **Client portal:** overview of their services and outcomes, reports (pack reports + activity, CSV
  export), run timeline, inbox, connections, requests, users and notification settings
- **Materials pack:** catalog, matching, prices, alerts, Price watch report; Pia and her two workflows,
  deployed to the millwork shop

Out (designed for, not built):
- Billing and invoicing clients (usage is metered so it can be added); client self-serve building;
  showing workflows or instructions to clients; other operators on the platform (one operator in v1)
- Connectors beyond QBO, Gmail and upload (Outlook, Google Drive, bank and card feeds, Slack); Gmail
  push notifications (v1 polls); sending email without a person's approval; code steps in workflows;
  per-tool auto-approval of external writes; A/B versions; outbound SMS; custom collections and fields UI
- Other packs (Expenses, Bookkeeping, FP&A); they plug in the same way as Materials

---

## 2. Stack (decisions)

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript everywhere | One language for app, agents, workflows |
| App | React + Vite single-page app, served as static assets by the API Worker | Same shape as Plenary Labs |
| API | Hono on Cloudflare Workers; one Zod route contract shared by API and client | |
| UI | Tailwind + shadcn/ui primitives, themed with Groundwork tokens | Owner's designs; Groundwork components replace shadcn ones where they exist |
| Workflow canvas | React Flow (`@xyflow/react`) with ELK (`elkjs`) for auto-layout | MIT; nodes are our own components |
| DB | Postgres 16 with `pgvector`, `pg_trgm` | Neon, reached from Workers through Hyperdrive; local via Docker |
| ORM / migrations | Drizzle | Platform schema in `packages/db`, pack schemas in their packs, one migration sequence |
| Durable jobs / workflows | Cloudflare Workflows | `step.do` with retries, `step.waitForEvent`, `step.sleep`; Worker cron for schedules |
| LLM | Anthropic API via `@anthropic-ai/sdk`, tool use + structured outputs | Models below |
| Object storage | Cloudflare R2 (Worker binding; S3 API for signed URLs) | Original documents, never mutated |
| Auth | WorkOS (AuthKit), sealed session cookie; behind `packages/auth` | Same as Plenary Labs |
| Validation | Zod for every definition, tool input/output, API body | Shared with the canvas through `packages/core` |
| Email (optional) | Resend | Behind an interface; SMS later |
| Tests | Vitest (`@cloudflare/vitest-pool-workers` for Worker and Workflow tests); Playwright e2e | |

Models (configurable per agent version and per skill, defaults):
- `claude-sonnet-5-5` — extraction, agent reasoning, Builder
- `claude-haiku-5-5` — high-volume classification and adjudication (e.g. item matching)
- `claude-opus-5-5` — optional for the Builder on complex requests

---

## 3. Repository layout

pnpm monorepo.

```
/apps
  /api                 Hono Worker: /api routes, auth, static assets, Workflow classes, cron;
                       registers connectors and packs
  /web                 React + Vite app: back office (incl. the canvas) and client portal, typed API client
/packages              the platform: never imports a pack
  /core                Domain types and Zod schemas (AgentDefinition, SkillDefinition, WorkflowGraph,
                       ToolSpec, ConnectorManifest, PackManifest), graph validation, route contract,
                       units, money
  /db                  Drizzle platform schema, migrations (platform + packs), seed, withTenant()
  /llm                 Anthropic client wrapper, cost tracking, record/replay
  /auth                Tenant + role helpers, WorkOS and dev adapters
  /senses              Event outbox
  /connectors          Connector framework + qbo/ + upload/; object storage
  /documents           Document store, extraction, validation, linking
  /threads             Threads + messages, command parsing
  /agents              Tool, skill and agent registries; versioning; runtime; Builder
  /workflows           Graph executor (against a StepRunner interface), trigger router
/packs
  /materials           Materials pack: catalog, matching, pricing and alert rules; its tools,
                       skills, tables, API routes and seeded agent + workflows
/fixtures
  /invoices            Sample millwork invoices (PDF/PNG) + expected extraction JSON
  /qbo                 Sample QBO API payloads
  /matching            Labeled line pairs for the matcher
  /llm                 Recorded model responses
/docs
```

Dependency rules (enforced by `scripts/check-deps.mjs`):
- Platform packages depend downward only: `workflows → agents → (documents, threads) → connectors → db → core`;
  `llm`, `senses` and `auth` sit just above `core`/`db`.
- **Platform packages never import `packs/*`.** A pack may import `core`, `db`, `llm`, `senses`,
  `documents` and `connectors`; never `agents` or `workflows`. A pack contributes tools and skills as
  data and handlers typed by `core`; the runtime finds them through the registries.
- `apps/api` is the only place that wires packages and packs together. `apps/web` imports only `core`.
- Agent reasoning never reaches the database directly; it goes through tools (§9.4).

---

## 4. Tenancy and auth

One operator, many clients. Each client is a tenant; the operator's staff reach into every client they
serve from the back office.

| Role | Who | Can |
|---|---|---|
| `operator` | The owner and their team | Everything in the back office: create clients, invite users, send connect links, enable packs; build, test, **publish** and roll back catalogue items; deploy, configure, upgrade and pause deployments; work requests; see runs, usage and cost across their clients; approve on a client's behalf when delegated |
| `client_admin` | The client's owner or manager | Portal: connect and disconnect tools (OAuth); approve external actions and reviews (default approver); answer requests; reports, runs and services; raise requests; invite client users; notification settings |
| `client_user` | Client staff | Portal: inbox items assigned to them, reports, runs; raise requests |

- Tables: `tenant(id, name, timezone, settings jsonb, workos_organization_id, created_at)` (a client),
  `app_user`, `membership(tenant_id, user_id, role)`. An operator's memberships list the clients they
  serve (the owner is a member of all); client users belong to exactly one client.
- **RLS:** every tenant table has `tenant_id uuid not null` and a policy
  `tenant_id = any(current_setting('app.tenant_ids', true)::uuid[])`, set per transaction. A client
  request sets one id; an operator request in the back office sets the ids of the clients they serve,
  so cross-client views are still enforced by the database. Queries also filter by tenant.
- Client setting `approvals.external_actions`: `client_admin` (default) or `operator` (delegated);
  overridable per deployment. Every approval records who approved.
- Catalogue tables (§5.3) belong to the operator, not to a client: no `tenant_id`, never readable through
  client routes. A catalogue item may carry `client_id` when it was built for one client only.

---

## 5. Data model

All timestamps `timestamptz`, all money `numeric(14,4)` + `currency char(3)`, all ids `uuid` (v7 unless
stated). Three groups: platform, shared business records, pack tables.

### 5.1 Connections and raw data

```
connection(id, tenant_id, connector /*'qbo'|'gmail'|'upload'*/, status, external_account_id
           /*QBO realmId, Gmail address*/, credentials_encrypted jsonb, config jsonb /*e.g. Gmail query*/,
           last_sync_at, sync_cursor jsonb /*QBO CDC time, Gmail historyId*/, connected_by, created_at)

raw_record(id, tenant_id, connection_id, connector, entity_type, external_id,
           external_version /*QBO SyncToken*/, payload jsonb, synced_at, is_deleted bool)
  unique(connection_id, entity_type, external_id, external_version)

external_action(id, tenant_id, connection_id, tool, run_id null, step_run_id null, agent_version_id null,
                input jsonb, idempotency_key, status /*proposed|approved|rejected|executing|done|failed*/,
                inbox_item_id null, approved_by null, approved_at, result jsonb, error jsonb,
                before jsonb null, created_at, executed_at)
  unique(tenant_id, idempotency_key)
```
Raw records are append-only; normalized tables are rebuildable from raw. Every write to an external
system is an `external_action` row: proposed by an agent, approved by a person, executed once
(idempotency key), with the result and, where the system allows, the record's state before the change.

### 5.2 Shared business records

Records more than one pack will use. Connectors map into them; packs read them.

```
vendor(id, tenant_id, name, normalized_name, aliases text[], external_refs jsonb, ext jsonb)

transaction(id, tenant_id, kind /*purchase|bill|vendor_credit*/, vendor_id, txn_date, total, currency,
            purchaser_ref text, payment_type, memo, source_raw_record_id, external_id,
            status /*needs_doc|doc_requested|doc_found|extracted|processed*/, ext jsonb)

transaction_line(id, tenant_id, transaction_id, line_no, detail_type /*account|item*/,
                 account_ref, item_ref, description, qty, unit_price, amount)

document(id, tenant_id, transaction_id null, source /*connector|upload|email|request*/, storage_key,
         mime_type, sha256, page_count, status /*stored|extracting|extracted|failed|needs_review*/,
         received_at)

doc_extraction(id, tenant_id, document_id, model, agent_version_id null, header jsonb, subtotal,
               freight, surcharges jsonb, tax, total, lines_sum, totals_match bool, confidence,
               created_at)

doc_line(id, tenant_id, extraction_id, line_no, vendor_sku, raw_description, qty, uom_raw,
         unit_price, ext_price, discount, page, bbox jsonb null)

alert(id, tenant_id, pack null, kind, subject_type, subject_id, severity, title, body,
      evidence jsonb /*record ids*/, dollar_impact, status /*open|accepted|dismissed*/,
      raised_by_run_id, created_at)
```

### 5.3 Platform

```
tenant_pack(tenant_id, pack, version, enabled_at)        -- packs switched on for a client

-- Catalogue: the operator's, shared across clients (client_id set = built for that client only)
skill(id, client_id null, slug, name, live_version_id null, status, created_at)   -- operator-written skills
skill_version(id, skill_id, version int, definition jsonb /*SkillDefinition*/, definition_hash,
              status /*draft|live|retired*/, change_note, author_id, parent_version_id null, created_at)
  unique(skill_id, version)          -- immutable except status (trigger)

agent(id, client_id null, slug, name, role, live_version_id null, status /*active|disabled*/, created_at)
agent_version(id, agent_id, version int, definition jsonb /*AgentDefinition*/, definition_hash,
              status /*draft|live|retired*/, change_note, author_type /*operator|builder|pack*/,
              author_id, parent_version_id null, created_at)
  unique(agent_id, version)          -- immutable except status (trigger)

workflow(id, agent_id, client_id null, slug, name, live_version_id null, created_at)
workflow_version(id, workflow_id, version int, definition jsonb /*WorkflowGraph*/, definition_hash,
                 status /*draft|live|retired*/, change_note, author_type /*operator|builder|pack*/,
                 author_id, parent_version_id null, created_at)
  unique(workflow_id, version)       -- immutable except status (trigger)

-- Deployments: an agent running for one client
deployment(id, tenant_id, agent_id, agent_version_id, track /*pinned|live*/,
           service_name, service_description,          -- what the client sees in the portal
           settings jsonb /*per-skill setting overrides*/, bindings jsonb /*connector → connection_id*/,
           approver /*null = client setting | client_admin | operator*/,
           status /*draft|testing|active|paused|retired*/, created_by, created_at, updated_at)
deployment_workflow(id, tenant_id, deployment_id, workflow_id, workflow_version_id, track, enabled,
                    trigger_overrides jsonb /*schedule tz/time, event filter*/)
deployment_change(id, tenant_id, deployment_id, actor_id, change jsonb, created_at)   -- append-only

run(id, tenant_id, deployment_id, deployment_workflow_id, workflow_version_id, agent_version_id,
    config jsonb /*settings + bindings snapshot*/, mode /*live|test*/, trigger jsonb, status,
    started_at, finished_at, cost_usd numeric(10,4), error jsonb)
step_run(id, tenant_id, run_id, node_id, node_type, skill_ref null, agent_version_id null, input jsonb,
         output jsonb, summary text null /*plain-language line for the client timeline*/, status,
         attempts, cost_usd, tokens_in, tokens_out, started_at, finished_at)
tool_call(id, tenant_id, step_run_id, tool, input jsonb, output jsonb, status, duration_ms,
          external_action_id null)

event(id, tenant_id, type, subject_type, subject_id, payload jsonb, created_at, dispatched_at null)

thread(id, tenant_id, subject_type, subject_id, title, status, step_budget int, steps_used int)
message(id, tenant_id, thread_id, sender_type /*agent|user|system*/, sender_id, agent_version_id null,
        kind /*text|command|result*/, command text null, body jsonb, sources jsonb,
        audience /*client|operator*/, created_at)

inbox_item(id, tenant_id, kind /*approval|review|request|extraction_review|external_action|change_request*/,
           pack null, deployment_id null, subject_type, subject_id, run_id null, assignee_user_id null,
           assignee_role, title, payload jsonb, status /*open|resolved|expired*/, resolution jsonb, due_at,
           created_at, resolved_at)

memory_note(id, tenant_id, deployment_id, scope, note, source_message_id null, created_at)
                                     -- an agent's memory is per client, never shared across clients

usage_daily(tenant_id, day, deployment_id, runs, steps, documents, external_actions, tokens_in,
            tokens_out, cost_usd)    -- rollup for the back office and future billing

schema_extension(id, tenant_id, target, json_schema jsonb, version, created_at)  -- UI later
custom_record(id, tenant_id, collection, data jsonb, created_at, updated_at)       -- v1 unused
```

Built-in tools and skills live in code (connectors, platform, packs) and are versioned with them;
operator-written skills are rows. Extensibility rule: `vendor`, `transaction` and pack tables that hold
client-facing records get `ext jsonb default '{}'`, validated against the latest `schema_extension`.

### 5.4 Pack tables

Each pack owns its tables (Drizzle schema inside the pack, migrations in the one shared sequence,
same tenancy and RLS rules). Materials: §12.

---

## 6. Connections and tools

### 6.1 Connector framework

```ts
const ConnectorManifest = z.object({
  id: z.string(),                         // 'qbo'
  name: z.string(), description: z.string(), icon: z.string(),
  auth: z.enum(['oauth2', 'api_key', 'none']),
  entities: z.array(z.string()),          // what sync brings in: ['Purchase', 'Bill', ...]
  tools: z.array(ToolSpec),               // reads and writes this connector offers agents
});

interface Connector {
  manifest: ConnectorManifest;
  authorize?(tenantId): Promise<{ redirectUrl: string }>;
  handleCallback?(params): Promise<Connection>;
  sync?(connection, opts: { since?: Date; full?: boolean }): AsyncIterable<RawRecordInput>;
  fetchAttachments?(connection, entityType, externalId): Promise<AttachmentRef[]>;
  downloadAttachment?(connection, ref): Promise<{ stream: ReadableStream; mime: string; filename: string }>;
  verifyWebhook?(headers, body): boolean;
  tools: Record<string, ToolHandler>;     // handlers for manifest.tools, given the connection
}
```

Connectors produce raw records, files and tool results. Normalization happens in `packages/core` mappers
per connector (`mapQboPurchase(raw) → TransactionInput`). The Connections screen lists every connector,
its status for the tenant, and the tools it gives agents. Tool ids are `<connector>.<entity>.<verb>`
(`qbo.purchase.query`, `qbo.attachable.upload`).

### 6.2 QuickBooks Online

- OAuth 2.0 authorization code flow, scope `com.intuit.quickbooks.accounting`. Store `realmId`, access +
  refresh tokens encrypted (AES-256-GCM, key from env). Refresh on 401 or before expiry and persist the
  new refresh token every time.
- Environments: sandbox vs production base URL from env. Develop against a sandbox company.
- Entities synced: `Purchase`, `Bill`, `VendorCredit`, `Vendor`, `Item`, `Attachable`. Optionally
  `PurchaseOrder`.
- Initial sync: query each entity with paging (`STARTPOSITION`/`MAXRESULTS`), ordered by
  `MetaData.LastUpdatedTime`.
- Incremental: Change Data Capture (`cdc?entities=...&changedSince=...`) every 15 min, plus webhooks as a
  trigger to run CDC early. Cursor in `connection.sync_cursor`.
- Webhooks: verify the HMAC-SHA256 signature with the app's verifier token; start a `qbo-sync` Workflow
  instance for the realm, never process inline.
- Lines: map `AccountBasedExpenseLineDetail` and `ItemBasedExpenseLineDetail` to `transaction_line.detail_type`.
- Attachables: query attachables referencing the transaction; download via the download endpoint. Store
  bytes in R2, dedupe by sha256.
- **Tools, read** (`none`): `qbo.purchase.query`, `qbo.bill.query`, `qbo.vendor.query`, `qbo.item.query`,
  `qbo.attachable.list`.
- **Tools, write** (`external`, approval required in v1): `qbo.attachable.upload` (attach a document to
  a transaction), `qbo.purchase.update_memo`, `qbo.item.update_purchase_cost`. Each write sends the
  current `SyncToken`, stores the prior state in `external_action.before`, and fails cleanly on a stale
  token (the record changed since the agent read it). // open: which writes ship first (§20).
- Rate limits: central throttle per realm with retry/backoff on 429.
- Verify endpoint shapes, minor version, and current Intuit API terms against Intuit's developer docs
  before coding.

### 6.3 Upload connector

- Upload PDF/JPG/PNG documents → `document` (no transaction yet) → linked to a transaction by vendor +
  total + date (±7 days) when possible. Unlinked documents still extract.
- Upload CSV of purchases (date, vendor, amount, memo) → `raw_record(connector='upload')` → transactions.
- The demo path when QBO is not connected.

### 6.4 Gmail

- OAuth 2.0 with Google, granted by the client for one mailbox (a shared `invoices@` / `ap@` box is the
  usual case; a person's mailbox works too). Scopes: `gmail.readonly` (search and read),
  `gmail.labels` (create and apply labels), `gmail.compose` (create drafts). Tokens encrypted like QBO's.
  Verify current scope classifications and Google's app verification rules before launch (§20).
- **What is ingested is narrow:** each connection has a Gmail search query set by the operator (default:
  messages with PDF or image attachments from the last 90 days, from vendor addresses/domains known in
  `vendor` plus any added by the operator, or carrying a chosen label). Only matching messages are
  synced: headers and snippet to `raw_record(entity_type='Message')`, attachments to `document(source=
  'email')`. Bodies are fetched on demand through a tool, never bulk-stored.
- Incremental sync: `users.history.list` from the stored `historyId` every 5 minutes (cron), falling back
  to a bounded search when the history id has expired. Push notifications (Pub/Sub `watch`) later.
- Matching: email attachments are linked to transactions like uploads (vendor + total + date), with the
  sender domain as an extra vendor signal.
- **Tools, read** (`none`): `gmail.message.search` (query within the connection's scope),
  `gmail.message.get` (headers, body text, attachment list), `gmail.attachment.get` (stores the file as a
  document).
- **Tools, write** (`external`, approval required): `gmail.draft.create` (e.g. ask a purchaser or vendor
  for a missing invoice; a person sends it from Gmail), `gmail.label.apply` (e.g. label processed
  invoices). Sending is out of v1 scope.
- Email content is untrusted input (§16): bodies and attachments reach agents only as tool results.

---

## 7. Documents capability

A platform capability any pack or custom skill can use; exposed as tools (`docs.*`, §9.4).

- Store: originals in R2 keyed by sha256, never mutated.
- Locate support for a transaction: connector attachments first (QBO Attachables), then email (Gmail
  documents already synced, then a scoped Gmail search), then uploaded documents (vendor + total + date
  match), then a request to a person (inbox, or a Gmail draft to the purchaser for approval).
- Extract: send the document to Claude as a PDF or image content block with a forced tool whose input
  schema is `InvoiceExtraction` (Zod → JSON Schema): header fields, lines[], subtotal, freight,
  surcharges[], tax, total, per-field confidence, page refs.
- Validate: `abs(sum(lines.ext_price) - subtotal) <= max(0.02, 0.5% of subtotal)` and
  `subtotal + freight + surcharges + tax ≈ total`. Fail → `document.status = needs_review` +
  `inbox_item(kind='extraction_review')`.
- Store the model and agent version on `doc_extraction`. Never overwrite; re-extraction inserts a row.

---

## 8. Senses (events)

A sense is a typed event emitted when data changes meaningfully. Written to `event` in the same
transaction as the change (outbox). After commit, a dispatcher hands it to the trigger router, which
starts a run for each enabled workflow whose trigger matches; a cron sweep re-dispatches anything left
behind.

Platform event types: `transaction.created`, `transaction.updated`, `document.received`,
`document.extracted`, `document.extraction_failed`, `inbox.resolved`, `external_action.done`,
`external_action.failed`, `alert.raised`, `schedule.tick`. Packs declare their own
(`materials.line.matched`, `materials.price.changed`, ...). The canvas's trigger picker lists the event
types available to the tenant (platform + enabled packs), each with a sample payload.

---

## 9. Tools, skills and agents

### 9.1 Agent definition (stored in `agent_version.definition`)

```ts
const AgentDefinition = z.object({
  schemaVersion: z.literal(2),
  identity: z.object({ name: z.string(), role: z.string(), mission: z.string(), avatar: z.string().optional() }),
  kind: z.enum(['functional', 'platform']),
  model: z.object({ id: z.string(), maxTokens: z.number().default(4096) }),
  instructions: z.string(),                       // plain language; how this agent works
  skills: z.array(z.object({
    skill: z.string(),                            // 'materials.match-line' | 'custom:<slug>' [@version]
    settings: z.record(z.unknown()).default({}),  // overrides the skill's settings defaults
  })),
  extraTools: z.array(z.string()).default([]),    // tools beyond those its skills bring
  canCommand: z.array(z.string()).default([]),    // agent slugs it may ask
  permissions: z.object({
    auto: z.array(z.string()),                    // tool ids allowed without approval
    approval: z.array(z.string()),                // tool ids that create an inbox approval
    mode: z.enum(['suggest_only', 'act']).default('suggest_only'),
  }),
  budgets: z.object({ maxSteps: z.number().default(12), maxCostUsd: z.number().default(0.5) }),
  memory: z.object({ enabled: z.boolean().default(true) }),
});
```

An agent's **commands** are its skills: anything that can be a workflow step can be invoked in a
thread as `/skill-slug args` or by another agent.

### 9.2 Skill definition

```ts
const SkillDefinition = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),                                 // 'docs.extract', 'materials.match-line', 'custom:<slug>'
  name: z.string(), description: z.string(), category: z.string(),
  mode: z.enum(['tool', 'agent']),                // 'tool' = deterministic handler; 'agent' = reasoning loop
  handler: z.string().optional(),                 // tool id when mode = 'tool' (built-ins only)
  instructions: z.string().optional(),            // added to the agent's prompt when mode = 'agent'
  tools: z.array(z.string()),                     // tools the agent may use while running this skill
  input: JsonSchema, output: JsonSchema,          // typed; the canvas builds forms from these
  settings: z.array(z.object({                    // e.g. match_confidence_auto: 0.9, price_change_pct: 5
    key: z.string(), label: z.string(), type: z.enum(['number', 'boolean', 'string', 'enum']),
    default: z.unknown(), options: z.array(z.string()).optional(),
  })).default([]),
  requiresConnectors: z.array(z.string()).default([]),
  requiresPacks: z.array(z.string()).default([]),
  producesAlerts: z.boolean().default(false),     // outputs must carry `sources`
});
```

- **Built-in skills** are code: platform skills (`docs.find-support`, `docs.extract`, `threads.summarize`,
  `inbox.ask`) and pack skills (`materials.*`). Their version is the package version.
- **Operator-written skills** are created in the back office's Skills library: name, description, instructions, a selection of
  existing tools, input and output fields (a form that produces the JSON Schema), settings. Always mode
  `agent`. Saved as `skill_version` rows with the same draft → publish → rollback rules as agents.
- Skills live in the catalogue for every client; a deployment can use a skill only when the client has
  the required connections bound and packs enabled. Deploying shows what's missing per client.

### 9.3 Versioning and deployments

- Creating or editing an agent, skill or workflow always inserts a new catalogue version (`draft`).
  Publishing sets it `live` and updates `live_version_id`, in one transaction. Publishing changes the
  catalogue only; **no client's deployment changes until the operator upgrades it**, except deployments
  set to `track: live`.
- Rollback in the catalogue = publish an older version by copying it as a new version with
  `parent_version_id`, so history stays linear. Rollback for one client = re-pin its deployment.
- `definition_hash` = sha256 of canonical JSON; no-op edits are rejected.
- **Deployments** bind a catalogue agent to a client: pinned agent and workflow versions, connection
  bindings (which of the client's connections serves each connector the agent needs), per-skill setting
  overrides (validated against each skill's settings schema), approver, status. Every change appends a
  `deployment_change` row. Activating requires every required connector bound and a passing test run.
- **Rollout:** each catalogue agent shows which clients run which version. The operator upgrades one
  deployment, several, or all; each upgrade can be test-run on that client's data first.
- A run records the deployment, the versions it ran and a snapshot of settings and bindings.
- Every `step_run`, `message`, `doc_extraction`, `external_action` and pack decision made by an agent
  records `agent_version_id`.
- Workflows reference skills by id (live version) or `id@version` (pinned).
- **The runtime never reads agent, skill or workflow settings from code.** Pack templates are inserted
  into the catalogue as v1 rows when the pack is installed.

### 9.4 Tool registry

Each tool: `{ id, description, input: Zod, output: Zod, sideEffect: 'none'|'internal'|'external', source:
'platform'|'<connector>'|'<pack>', handler }`. Agents touch data only through tools.

Platform tools:
| id | sideEffect | does |
| --- | --- | --- |
| `ledger.query` | none | Query transactions/lines/vendors with filters |
| `docs.find_support` | internal | Run the locate sequence for a transaction |
| `docs.get` | none | Document metadata + signed URL + latest extraction |
| `docs.extract` | internal | Run extraction |
| `docs.request_from_person` | internal | Create an inbox request for a document (email if configured) |
| `alerts.raise` | internal | Create an alert with evidence |
| `inbox.create` | internal | Create an inbox item |
| `threads.post` | internal | Post a message to a thread |
| `agents.ask` | internal | Ask another agent (routed by the Coordinator) |
| `memory.write` | internal | Save a memory note |

Connector tools come from manifests (§6); pack tools from packs (§12).

### 9.5 Runtime

```ts
runAgent({ tenantId, deploymentId, agentRef, skill | task, input, threadId?, runContext }): Promise<AgentResult>
```
1. Resolve `agentRef` through the deployment to its pinned `agent_version`, and the skill to its
   version; apply the deployment's setting overrides. Validate input.
2. If the skill's mode is `tool`: call the handler directly, log, return.
3. Else build the prompt: platform preamble (cite sources, use tools, never invent numbers) + agent
   `instructions` + the skill's `instructions` + the deployment's memory notes + task input. Expose only the skill's tools
   (and `extraTools`), `ask_agent` if `canCommand` is non-empty, and `finish(result)` typed to the skill
   output.
4. Loop: model call → tool calls → results, until `finish` or budget hit. Enforce `maxSteps` and
   `maxCostUsd`. On budget hit: return `{status:'escalated'}` and create an inbox item.
5. **Permission gate** per tool call: `none` → run. `internal` → run if in `auto` and mode is `act`;
   otherwise inbox approval. `external` → **always** an `external_action` (status `proposed`) plus an
   `inbox_item(kind='external_action')` in v1; the step waits for `inbox.resolved`; on approval the
   action executes once by idempotency key. Test runs (§10.4) never execute external actions.
6. Log `step_run`, `tool_call`, tokens, cost. Outputs of skills with `producesAlerts` must include
   `sources`; outputs without them are rejected.

### 9.6 Builder

- `draft-agent(input: { description, clientContext? })` → `{ definition: AgentDefinition, workflows:
  WorkflowGraph[], summary, gaps: string[] }`.
- The Builder receives the tool and skill registries (ids, descriptions, side effects, input/output
  schemas), the connectors and packs available (and, when drafting for a client, what that client has
  connected and enabled), event types, and the JSON Schemas of `AgentDefinition` and `WorkflowGraph`. It
  may only select existing skills and tools; anything that needs a missing capability goes in `gaps`
  (e.g. "no card feed connector").
- `revise-agent({ agentId, fromVersionId, instruction })` → new definition (and workflow changes) + a
  human-readable diff (field-level JSON diff rendered as sentences).
- Server guards: Zod validation, graph validation (§10.2), `permissions.mode='suggest_only'` for new
  agents, `external` tools never in `auto`, saved as `draft` in the catalogue. The operator adjusts,
  tests and publishes.
- The Builder is a back-office tool. A client's request can be handed to it as the description.

### 9.7 Platform agents (catalogue, seeded as v1 rows)

| slug | kind | skills |
| --- | --- | --- |
| `document-clerk` | platform | `docs.find-support`, `docs.extract` (used by other agents' workflows inside a client's run) |
| `coordinator` | platform | `route-ask`, `review` (multi-agent review: collect views, write one summary with disagreements) |
| `builder` | platform | `draft-agent`, `revise-agent` (back office only; runs outside any client) |

---

## 10. Workflows

### 10.1 Graph definition (stored in `workflow_version.definition`)

```ts
const WorkflowGraph = z.object({
  schemaVersion: z.literal(2),
  agent: z.string(),                              // owning agent slug; steps run as this agent
  nodes: z.array(Node),
  edges: z.array(z.object({
    id: z.string(), from: z.string(), to: z.string(),
    port: z.enum(['next', 'then', 'else', 'approved', 'rejected', 'timeout', 'each', 'done']).default('next'),
  })),
});

Node = { id, type, name, position: { x, y }, parent?: nodeId /*inside a loop*/,
         client?: { visible: boolean, label?: string } /*client run timeline*/, ...config } where type ∈
  'trigger'     { on: { type: 'event', event, filter? } | { type: 'schedule', cron, tz }
                       | { type: 'manual', input: JsonSchema } | { type: 'command', command } }
  'skill'       { skill: 'id[@v]', agent?: 'slug[@v]' /*default: owner*/, input: Template, settings? }
  'agent_task'  { task: Template, input: Template, agent?: 'slug[@v]', output?: JsonSchema }
  'tool'        { tool: 'id', input: Template }          // direct action; external tools need approval
  'condition'   { if: Expression }                        // ports: then, else
  'approval'    { title: Template, assigneeRole, payload: Template, timeout: Duration }
                                                          // ports: approved, rejected, timeout
  'request'     { to: Template /*role or user*/, channel: 'inbox'|'email', message: Template,
                  remindEvery: Duration, timeout: Duration }   // ports: next, timeout
  'wait'        { for: Duration }
  'loop'        { over: Template /*array*/, concurrency: number }   // ports: each (into children), done
  'notify'      { channel: 'thread'|'email'|'digest', message: Template }
  'end'         { status: 'succeeded'|'failed'|'cancelled' }
```

Templates reference the trigger and upstream outputs as `{{trigger.<path>}}` and
`{{nodes.<id>.output.<path>}}`; inside a loop, `{{item}}` and `{{index}}`. Expressions use JSONLogic,
never `eval`. `position` is for the canvas only; the executor ignores it. `client` controls the portal's
run timeline: by default skill, tool, approval, request and notify nodes are shown (with `label`, or the
node name), and logic nodes are hidden.

### 10.2 Validation (shared by canvas and server, in `packages/core`)

A graph can be saved as a draft with errors, but only a valid graph can be test-run or published.
- Exactly one trigger, and every node reachable from it.
- No cycles except through a `loop` node's children; loop children form a sub-graph with one entry.
- Ports: `condition` has `then` and `else`; `approval` has `approved`; every non-`end` node has an
  outgoing edge or is a leaf (implicit success).
- Every template path resolves to a field that exists on **every** path to the node (typed from the
  upstream skill or tool output schema and the trigger payload schema).
- Every `skill` node's input satisfies the skill's input schema; every skill and tool exists and is
  allowed by the owning agent (its skills plus `extraTools`). Per-client availability is checked when
  deploying (§9.3).
- A `tool` node with an `external` tool is always gated (§9.5); the canvas shows the approval on the
  node.
Errors carry the node id and field, so the canvas can mark the node and the inspector field.

### 10.3 Executor

- One Cloudflare Workflow class, `RunWorkflow`, executes any graph. Runs belong to a deployment:
  triggers start instances for **active** `deployment_workflow` rows: the senses router for `event`
  triggers (a client's event starts only that client's deployments), a Worker cron for `schedule`
  triggers (each `cron` in the client's timezone unless overridden), the API for `manual` and `command`
  triggers. The instance id is the `run` id, so starting the same run twice is refused.
- The instance loads the deployment's pinned versions, settings and bindings, and walks the graph from the trigger, running each node with
  `step.do(nodeId, ...)` so it is durable and retried. Branches that fan out run in parallel. Step
  outputs stay small (record ids); large data lives in Postgres.
- `approval`, `request` and gated tool calls create an inbox item, then `step.waitForEvent` with a type
  unique to that item and the node's timeout. Resolving the item (`POST /api/inbox/:id/resolve`) sends
  that event to the run's instance.
- `loop` runs its children once per item, with bounded concurrency, step names `${nodeId}:${index}:${childId}`.
- Every node writes a `step_run`. Run status and cost roll up to `run`.

### 10.4 Test runs

The operator test-runs a workflow version against a **client's data** through a deployment (draft or
active), choosing a trigger payload (a sample event, a recent real record, or manual input); or against
the **sandbox client**, which holds fixture data. A test run is a normal run with `mode='test'`: it reads
real data, writes its own steps and outputs, but **never executes external actions** (they are recorded
as proposed and shown as "would have done"), does not emit events that start other workflows, and is
hidden from the client portal. Internal writes made by test runs are tagged with the run.

### 10.5 The canvas (back office)

Route `/ops/catalog/agents/[slug]/workflows/[workflow]`; the owner's designs give the look. Operator
only; clients never see the canvas.
- **Palette** (left): Triggers (events, schedule, manual, command); Skills (the agent's skills first, then
  the library); Logic (condition, loop, wait); People (approval, request); Tools (connector actions,
  grouped by connector); Notify; End. Drag onto the canvas to add.
- **Canvas** (centre): React Flow; nodes show type, name, the skill or tool, and badges (invalid, needs
  approval, external write, hidden from client). Connect by dragging between ports. Auto-layout (ELK) on
  demand. Undo/redo. Loops render as a group containing their children.
- **Inspector** (right): the selected node's form, generated from the skill or tool input schema;
  template fields offer a picker of upstream outputs valid at this node; settings with defaults; the
  node's client timeline label and visibility.
- **Top bar**: validation summary (click to jump to the node), Save draft, Test run (pick a client
  deployment or the sandbox), Publish, version history with rollback and a visual diff, and "Deployed
  to" (which clients run which version, with upgrade actions).
- **Run view**: the same canvas read-only with each node coloured by its `step_run` status, cost per node,
  and a side panel with input, output, tool calls and inbox items for the selected node. Live runs poll.

### 10.6 The client run timeline (portal)

Clients see a run as a timeline of its client-visible steps: label, status, time, a one-line summary
(`step_run.summary`, written by the skill or tool from its output; never model reasoning or prompts),
links to the records and documents it touched (`sources`), approvals and who gave them, and actions taken
in their systems. No costs, no instructions, no internal steps.

---

## 11. Inbox and threads

- Inbox kinds: `approval`, `review` (a pack's review, e.g. match review), `request` (ask a person for a
  document or answer), `extraction_review`, `external_action` (approve a write to a connected tool:
  shows the tool, the target record, the change, and the record's current state), `change_request`
  (a client asks the operator for a change or a new service; it goes to the operator's request queue and
  is resolved by linking the deployment changes or catalogue versions made for it).
- Who sees what: clients see their own items (client_users only those assigned to them); operators see
  every item in the clients they serve, plus the operator inbox (delegated approvals, escalations,
  budget hits, failed runs).
- Resolving an item writes `resolution`, emits `inbox.resolved` and sends the event to the waiting run.
- Every run creates or appends to a thread for its subject (transaction, catalog item, vendor, week).
  Messages carry `sources` (record ids) rendered as links, and an `audience`: operator-only notes never
  appear in the portal.
- People can post in a thread and invoke an agent's skills with `/skill args` (parsed server-side into a
  `skill` step on that agent). `agents.ask` goes through `coordinator.route-ask`, which enforces
  `canCommand` and the thread `step_budget`.

---

## 12. Packs and the Materials pack

### 12.1 Pack contract

```ts
const PackManifest = z.object({
  id: z.string(), name: z.string(), version: z.string(), description: z.string(),
  requiresConnectors: z.array(z.string()).default([]),
  events: z.array(EventTypeSpec),           // sense types it emits, with payload schemas
  tools: z.array(ToolSpec),
  skills: z.array(SkillDefinition),
  templates: z.object({ agents: z.array(AgentDefinition), workflows: z.array(WorkflowGraph) }),
  screens: z.array(z.object({ route: z.string(), title: z.string(), roles: z.array(z.string()) })),
});
```
A pack is a package exporting its manifest, tool handlers, Drizzle schema and API routes. `apps/api`
registers it; `apps/web` has its screens under `src/packs/<id>/`: client reports in the portal, and
operator views in the back office. Installing a pack adds its template agents and workflows to the
catalogue once, as v1 rows the operator edits like any other. Enabling it for a client inserts
`tenant_pack` (its tables start holding that client's data) and allows deploying its agents there.

### 12.2 Materials pack

Tables:
```
catalog_item(id, tenant_id, category, canonical_name, attributes jsonb, standard_uom,
             embedding vector(1024) null, created_by, merged_into_id null, created_at, ext jsonb)

item_alias(id, tenant_id, vendor_id, vendor_sku null, description_hash null, catalog_item_id,
           source /*auto|human*/, created_at)
  unique(tenant_id, vendor_id, coalesce(vendor_sku,''), coalesce(description_hash,''))

item_match(id, tenant_id, doc_line_id, catalog_item_id null, decision /*matched|new_item|unsure*/,
           confidence, method /*alias|rules|llm|human*/, hinge_attribute, candidates jsonb,
           decided_by /*agent_version_id or user_id*/, decided_at)

price_observation(id, tenant_id, catalog_item_id, vendor_id, observed_on, unit_price_std, qty_std,
                  standard_uom, doc_line_id, transaction_id)
  index(tenant_id, catalog_item_id, vendor_id, observed_on desc)
```

Tools: `materials.catalog.search` (none), `materials.catalog.create_item` (internal),
`materials.match_line` (internal), `materials.prices.record` (internal), `materials.prices.history`
(none), `materials.prices.compare_vendors` (none).

Skills: `materials.match-line` (tool mode; settings `match_confidence_auto` 0.90),
`materials.review-merge`, `materials.record-prices` (tool mode), `materials.price-check` (agent mode;
settings `price_change_pct` 5, `vendor_spread_pct`, `creep_pct`; produces alerts),
`materials.vendor-compare`, `materials.materials-list`, `materials.weekly-digest`.

Events: `materials.line.matched`, `materials.line.needs_review`, `materials.match.decided`,
`materials.price.observed`, `materials.price.changed`.

Reports (portal): Price watch (`/reports/materials/prices`), Catalog (`/reports/materials/catalog`),
with CSV export. Match review in the Inbox (`review` kind). Back office: the same views for any client,
plus catalog merge.

Catalogue agent **Pia** (`purchasing`, functional; portal service name "Material cost monitoring"): skills `docs.find-support`, `docs.extract`,
`materials.match-line`, `materials.record-prices`, `materials.price-check`, `materials.vendor-compare`,
`materials.weekly-digest`; extra tools `qbo.attachable.upload`, `gmail.draft.create`, `gmail.label.apply`
(all approval).

Template workflows (graphs, editable on the canvas):

**purchase-intake** (trigger: event `transaction.created`)
1. skill `docs.find-support` (QBO attachments, then Gmail, then uploads)
2. condition found? else → request (inbox doc request to the client admin, plus a `gmail.draft.create`
   to the purchaser when Gmail is connected (approval); remind 2d; timeout 5d → notify the operator)
3. skill `docs.extract`
4. condition totals_match? else → approval (extraction review)
5. loop over lines → skill `materials.match-line` (auto-match ≥ threshold; else review in the inbox and
   wait)
6. skill `materials.record-prices`
7. skill `materials.price-check` (raise alerts with evidence)
8. tool `qbo.attachable.upload` when the document came from Gmail or upload and the transaction from
   QBO (external: approval) // only if a QBO connection exists
9. tool `gmail.label.apply` "Processed" when the document came from Gmail (external: approval)

**weekly-price-review** (trigger: schedule Mondays 7:00 client timezone)
1. skill `materials.weekly-digest` (changes, creep, vendor spread, new surcharges, dollar impact)
2. approval (the operator reviews the digest)
3. notify digest to the client (email + portal report)

### 12.3 Item matching

Deterministic first, model second, human last.

1. **Normalize** `raw_description`: uppercase, strip punctuation noise, expand abbreviations from a
   global dictionary plus per-tenant/per-vendor learned abbreviations (`BB`→`BALTIC BIRCH`,
   `MEL`→`MELAMINE`, `PLY`→`PLYWOOD`, `S2S`, `FAS`).
2. **Alias lookup**: `item_alias` by (vendor, vendor_sku) then (vendor, description_hash). Hit → matched,
   method `alias`, confidence 1.0.
3. **Parse attributes** with category parsers (regex + unit tables), falling back to an LLM parse with a
   strict schema:
   - Sheet goods: material, face/species, core, thickness (`3/4"`, `.75`, `18MM`, `23/32` → nominal
     `3/4in` with actual mm kept), width×length (`4X8`, `48X96`, `4'X8'` → `48x96in`), grade (`B/BB`,
     `BB/BB`, `CP`, `A1`), finish.
   - Hardwood: species, thickness quarters (`4/4`, `8/4`), grade, surfacing, UOM board foot.
   - Mouldings/edgebanding: profile or species, width, thickness, length or roll size, UOM linear foot.
   - Hardware: brand, model/SKU, finish, pack size.
   - Finishes/adhesives: brand, product line, sheen, container size.
4. **Candidates**: catalog items in the same category whose **key attributes** are equal; then top-k by
   trigram (+ embedding when present) as a backstop.
5. **Adjudicate** (Haiku): line + parsed attributes + top 5 candidates → `{ decision, catalog_item_id?,
   confidence, hinge_attribute }`.
6. **Route**: confidence ≥ `match_confidence_auto` → matched; `new_item` with high confidence → create
   catalog item; else match review in the inbox. Human decisions write `item_alias(source='human')`.
7. **Hard rules** (code, not model): never match when any key attribute differs; never compare prices
   across different `standard_uom` without a conversion rule.

UOM conversion table in `packages/core/units`: sheet, each, box(n), board foot, linear foot, roll(n ft),
gallon, quart. Pack sizes parsed from description (`BX/10`, `100PK`).

Golden tests: `fixtures/matching/*.json` with line pairs labeled same/different. Target ≥ 95% precision
on "same" at the auto threshold.

### 12.4 Pricing and alerts

- `materials.prices.record`: `unit_price_std = unit_price / conversion(uom_raw → standard_uom)`; freight
  and surcharges are not folded into unit price (landed cost computed separately: allocate freight by
  line amount share).
- Alert rules (thresholds from the skill settings on the agent version):
  | kind | rule |
  | --- | --- |
  | `price_jump` | change vs last observation for same item+vendor > `price_change_pct` |
  | `price_vs_avg` | vs trailing 90-day average > `price_change_pct` |
  | `vendor_spread` | same item, same month, another vendor cheaper by > `vendor_spread_pct` |
  | `price_creep` | cumulative change over 90 days > `creep_pct` with no single jump |
  | `new_fee` | surcharge type not seen on prior invoices from that vendor |
  | `outlier` | qty or unit price > 3 MAD from item history |
- `dollar_impact` = change × trailing 90-day quantity.
- Deduplicate: one open alert per (kind, item, vendor).

---

## 13. Usage, cost and observability

- Every model call records tokens and cost on its `step_run` (cost computed at write time, including
  failures and retries); runs roll up cost; `usage_daily` rolls up per client and deployment.
- **Cost is operator-only.** The back office shows model cost and usage per client, per agent and per
  deployment over time, to price the service; the portal shows activity and outcomes, never cost.
- Budgets: per agent version (`maxSteps`, `maxCostUsd` per skill invocation) and per thread
  (`step_budget`). Hitting one escalates to the operator inbox rather than failing silently.
- Every run, step, tool call and external action is queryable from the back office run view; nothing an
  agent did is visible only in logs.

---

## 14. API (Hono routes under `/api`)

Two route families. `/api/ops/*` is the back office (role `operator`, scoped to the clients they serve;
`?client=` selects one). `/api/*` is the portal (client roles, one client). The OAuth callbacks, the
QBO webhook and connect links are shared.

```
Back office (operator)
  Clients      GET  /api/ops/overview                     (needs attention across clients)
               GET  /api/ops/clients                      POST /api/ops/clients (create + sandbox data opt.)
               GET  /api/ops/clients/:id                  PATCH /api/ops/clients/:id/settings
               POST /api/ops/clients/:id/invites          POST /api/ops/clients/:id/connect-links {connector}
               POST /api/ops/clients/:id/packs/:pack/enable
  Connections  GET  /api/ops/clients/:id/connections      PATCH /api/ops/connections/:id {config}
               POST /api/ops/connections/:id/sync
  Catalogue    GET/POST /api/ops/skills                   POST /api/ops/skills/:id/versions
               POST /api/ops/skills/:id/versions/:vid/publish
               GET/POST /api/ops/agents                   POST /api/ops/agents/draft {description, clientId?}
               GET  /api/ops/agents/:id (+ versions, deployments)
               POST /api/ops/agents/:id/versions          POST /api/ops/agents/:id/revise {instruction, fromVersionId}
               POST /api/ops/agents/:id/versions/:vid/publish   POST /api/ops/agents/:id/rollback {versionId}
               GET/POST /api/ops/agents/:id/workflows     GET  /api/ops/workflows/:id (+ versions)
               POST /api/ops/workflows/:id/versions       POST /api/ops/workflows/validate {graph}
               POST /api/ops/workflows/:id/versions/:vid/publish   POST /api/ops/workflows/:id/rollback {versionId}
               GET  /api/ops/catalog/events               (event types + sample payloads)
  Deployments  POST /api/ops/deployments {clientId, agentId, version}   GET/PATCH /api/ops/deployments/:id
               POST /api/ops/deployments/:id/test-run {workflowId, versionId?, payload}
               POST /api/ops/deployments/:id/activate|pause|retire
               POST /api/ops/deployments/upgrade {agentId, toVersion, deploymentIds | all}
               POST /api/ops/deployments/:id/run {workflowId, input}   (manual trigger)
  Runs         GET  /api/ops/runs?client=&status=&agent=  GET  /api/ops/runs/:id (steps, tool calls, cost)
  Inbox        GET  /api/ops/inbox                        POST /api/ops/inbox/:id/resolve
  Requests     GET  /api/ops/requests                     POST /api/ops/requests/:id/resolve {links}
  Usage        GET  /api/ops/usage?client=&agent=&from=&to=

Portal (client)
  Overview     GET  /api/overview                         GET  /api/services (deployments as services)
  Reports      GET  /api/reports/activity?from=&to=       GET  /api/reports/:pack/:report (+ .csv)
  Runs         GET  /api/runs?service=&status=            GET  /api/runs/:id (client timeline)
  Inbox        GET  /api/inbox?kind=&status=              POST /api/inbox/:id/resolve
  Connections  GET  /api/connections                      POST /api/connections/:connector/authorize
               DELETE /api/connections/:id
  Documents    POST /api/uploads (multipart)              GET  /api/documents/:id (signed URL)
  Requests     GET/POST /api/requests {subject?, text}
  Settings     GET/POST /api/users (invite)               PATCH /api/settings/notifications

Shared         GET  /api/connections/qbo/callback         GET  /api/connections/gmail/callback
               POST /api/webhooks/qbo                     GET  /api/connect/:token (connect link)
```
All bodies validated with Zod. The route contract declares each route's roles; middleware sets
`app.tenant_ids` from the session (§4). No portal route returns a catalogue definition, instructions,
prompts, model output outside `summary`, or cost; a contract test enforces both.

---

## 15. Screens → routes

**Back office** (`/ops`, role `operator`)

| Screen | Route |
| --- | --- |
| Overview: needs attention across clients (failed runs, operator inbox, requests, connections to fix, deployments behind latest), usage this month | `/ops` |
| Clients: list with health; new client (onboarding) | `/ops/clients`, `/ops/clients/new` |
| Client: deployments, connections (incl. Gmail query), users, packs, settings, runs, usage | `/ops/clients/[id]` |
| Catalogue: agents (editor, versions, "Deployed to"), new agent (scratch or Builder) | `/ops/catalog/agents`, `/ops/catalog/agents/new`, `/ops/catalog/agents/[slug]` |
| Workflow canvas | `/ops/catalog/agents/[slug]/workflows/[workflow]` |
| Skills library | `/ops/catalog/skills`, `/ops/catalog/skills/[id]` |
| Packs | `/ops/packs` |
| Deployment: versions, bindings, settings, approver, test runs, activate/pause, upgrade | `/ops/deployments/[id]` |
| Runs across clients; run view on the canvas | `/ops/runs`, `/ops/runs/[id]` |
| Requests queue; operator inbox | `/ops/requests`, `/ops/inbox` |
| Usage and cost | `/ops/usage` |

**Client portal** (`/`, client roles)

| Screen | Route | Role |
| --- | --- | --- |
| Overview: your services, what they did this period, what needs you | `/` | all |
| Service: what it does (plain language), recent runs, related reports | `/services/[id]` | all |
| Reports: activity, plus pack reports (Materials: Price watch, Catalog), CSV export | `/reports`, `/reports/materials/prices`, `/reports/materials/catalog` | all |
| Runs: timeline list and detail | `/runs`, `/runs/[id]` | all |
| Inbox: approvals, reviews, requests | `/inbox` | all (filtered) |
| Connections: connect, reconnect, disconnect | `/connections` | client_admin |
| Requests: ask the operator | `/requests` | all |
| Settings: users, notifications | `/settings` | client_admin |

Match review (Materials, in the Inbox): invoice line with page thumbnail, parsed attributes, top
candidates side by side with attribute diffs highlighted; actions Match / New item / Skip.

---

## 16. Security and audit

- Secrets in env; connector tokens encrypted at rest; signed URLs for documents (5 min).
- RLS on every tenant table, keyed on `app.tenant_ids` (§4). Workflows, cron and the senses dispatcher
  run with no request session and set exactly one client id. Operator sessions get only the clients
  they serve.
- **Client isolation of what agents learn:** memory notes, aliases, catalogs and every other learned
  record are per client; nothing a deployment learns is used for another client.
- **The operator's work stays the operator's:** catalogue definitions, instructions, prompts and costs
  are never returned to client roles (contract test, §14).
- **Writes to connected systems:** only through `external` tools; every one is an `external_action`
  approved by a person in v1, executed once (idempotency key), with prior state and result recorded.
  Agents, the Builder and custom skills cannot put an `external` tool in `auto`.
- Immutable `agent_version`, `skill_version`, `workflow_version`, `raw_record`, `doc_extraction` (trigger
  blocks UPDATE except status columns).
- Email: only messages matching the connection's query are synced; bodies are fetched on demand, not
  stored in bulk; disconnecting revokes the token and stops sync. Gmail writes are drafts and labels
  only in v1, each approved.
- Prompt-injection hygiene: email bodies, document text and vendor descriptions are passed as data in tool results,
  never concatenated into instructions. Operator-written skill instructions run only with the tools the
  skill lists. Agents cannot change their own permissions.

---

## 17. Configuration (env)

```
HYPERDRIVE (binding → Neon), DIRECT_DATABASE_URL (migrations)
ANTHROPIC_API_KEY
RUN_WORKFLOW, QBO_SYNC (Workflow bindings), ARTIFACTS (R2 binding)
STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY   # R2 S3 API, for signed URLs
ENCRYPTION_KEY                         # 32 bytes base64
QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI, QBO_ENV=sandbox|production, QBO_WEBHOOK_VERIFIER
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
WORKOS_CLIENT_ID, WORKOS_API_KEY, WORKOS_COOKIE_PASSWORD
RESEND_API_KEY (optional)
```

---

## 18. Build plan (ordered; each milestone ends green)

Platform first; the Materials agent, deployed to the millwork shop, proves it.

| # | Milestone | Done when |
| --- | --- | --- |
| M0 | Monorepo, Vite app + Hono Worker, Drizzle, Postgres + pgvector, Cloudflare Workflows, WorkOS auth with a seeded operator and one client | `pnpm dev` runs the Worker (API + Workflows) and the app; the operator and a client user can sign in |
| M1 | Platform schema (§5): catalogue, deployments, runs, inbox, usage; RLS on `app.tenant_ids`; immutability triggers; core Zod schemas and graph validation; seed (operator, sandbox client, platform agents) | Migrations apply; RLS holds for client and operator sessions; validation unit tests pass |
| M2 | Connector framework, upload connector, documents capability (store, extract, validate) | Upload 3 fixture invoices → extractions match expected JSON within tolerance |
| M3 | Tool + skill registries, agent runtime through deployments, permission gate, external actions, run/step/tool logging, usage rollup | A test agent deployed to the sandbox client runs `docs.extract` end to end and logs cost; an external tool call creates an approval and executes once when approved |
| M4 | Graph executor, triggers per deployment (event, schedule in client timezone, manual, command), senses outbox, test runs | A graph with condition, loop and approval runs to the end for one client and never starts for another; a test run proposes but never executes external actions |
| M5 | Back office shell (overview, clients, onboarding, connect links, operator inbox, requests queue); client portal shell (overview, inbox, connections, requests, settings); inbox resolution resumes runs | The operator creates a client and invites its admin; the admin connects via a link, approves an item that resumes a run, and raises a request the operator sees |
| M6 | Catalogue UI (agents, skills, Builder) and deployments (deploy, bindings, settings, approver, test run, activate, pause, upgrade, rollback, "Deployed to") | The operator builds an agent from scratch, publishes it, deploys it to two clients with different settings, upgrades one to v2 and rolls it back; the Builder drafts "flag card charges over $500 missing receipts" with gaps listed |
| M7 | Workflow canvas (operator) and run view; client run timeline | The operator builds a 5-node workflow on the canvas, test-runs it on a client's data, publishes and upgrades the deployment; the operator watches the run on the canvas while the client sees the timeline without internals or cost |
| M8 | Materials pack: tables, matching (golden tests), pricing and alert rules, Pia + workflows in the catalogue, deployed to the millwork client; client reports (activity, Price watch, Catalog, CSV) | Golden tests ≥ 95% precision; Baltic birch matches across 3 vendors; an uploaded invoice runs purchase-intake to priced lines with a `price_jump` alert; the client sees it in Price watch |
| M9 | QBO connector: OAuth, sync, CDC, attachables, webhooks, read tools, write tools behind approval | Sandbox company syncs; a Bill with an attachment flows through intake; an approved `qbo.attachable.upload` attaches the invoice in the sandbox |
| M10 | Gmail connector: OAuth, scoped sync (query + history), attachments as documents, read tools, draft and label tools behind approval; Gmail step in `docs.find-support` | A test mailbox connects; an emailed invoice is found for its QBO transaction and flows through intake; an approved `gmail.draft.create` appears in the mailbox's drafts |
| M11 | Usage and cost views, activity report, notification emails, polish, Playwright e2e | e2e: the operator creates a client, deploys Pia, the client connects and uploads an invoice, approves in the portal, sees the report; the operator sees the run and its cost |

If time is short, M0–M8 with the upload connector is the demo; M9 (QBO) and M10 (Gmail) follow.

---

## 19. Testing

- Unit: graph validation (every rule, with node/field error locations), template typing, normalizer,
  attribute parsers, UOM conversion, alert rules, Zod schemas, version immutability, permission gate.
- Layering: platform packages never import packs (`scripts/check-deps.mjs`).
- Golden: extraction fixtures (`fixtures/invoices/*.pdf` + `*.expected.json`), matching pairs.
- Executor: a fake `StepRunner` for every node type and port; one Workers-pool test drives the real
  Workflow class through a wait, a resume and a timeout.
- LLM calls behind `packages/llm` with a record/replay mode so tests run offline.
- Canvas: component tests for drag, connect, delete, undo, and validation markers; Playwright e2e (M11).
- Isolation: RLS for single-client and operator sessions; portal routes never return catalogue
  definitions, prompts or cost (contract test); a deployment's memory never reaches another client.

---

## 20. Decisions and open items

Decided:
- Auth: WorkOS (v0.2). Hosting: Cloudflare Workers + Neon + R2 (v0.2).
- Document requests are inbox-first, routed to a client admin (`docs/plan.md` §1.1).
- Embeddings: optional; trigram + attributes is enough for v1.
- Writes to client systems: always approved by a person in v1 (v0.3); by default the client admin, or
  the operator when delegated (v0.4).
- v1 connectors: QuickBooks Online, Gmail, upload (v0.4).
- Managed-agents service: the operator's catalogue deployed to clients from a back office; clients get a
  portal for reports, runs, approvals, connections and requests (v0.5).
- Cost is operator-only; clients see activity and outcomes (v0.5).

Open:
- Which QBO writes ship first. Proposal: `qbo.attachable.upload` (attach the found invoice to its
  transaction); `update_memo` and `update_purchase_cost` follow.
- Gmail and Google's app verification: Gmail read scopes are restricted, so a public app needs Google's
  verification and a security assessment; an unverified app shows a warning and has a user cap, and in
  "testing" status its refresh tokens expire after 7 days. Check the current rules at M10 and choose:
  verify the app, or (for Google Workspace clients) domain-wide delegation granted by the client's admin.
- Whether to add sending email (approved) after drafts, and Gmail push notifications instead of polling.
- Billing: usage is metered per client from v1; how clients are charged (per agent, per month, usage)
  decides what the back office invoices later.
