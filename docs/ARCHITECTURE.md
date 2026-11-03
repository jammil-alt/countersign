# Back Office Agent Platform — Architecture v0.1

> **For Claude Code:** this is the source of truth for the v1 build. Read it fully, then produce an implementation plan that follows the **Build plan** (section 18) in order. Where this doc says "decision", follow it. Where it says "open", choose the simplest option and leave a `// DECISION:` comment. Do not add features outside section 1's v1 scope.

Product design (screens, use case narrative) lives in the companion design doc. This file covers how to build it.

---

## 1. What we are building

A multi-tenant management layer that connects to a small business's systems (QuickBooks Online first), keeps a clean copy of their data, and runs **agents**: named, versioned, configurable workers that each own one back-office job.

First client: a ~$2M millwork shop. First job: **material cost management**. Pull purchases, get the supporting invoice, extract line items, match each line to a shared item catalog (e.g. "BB PLY 3/4 4X8" from vendor A and "Baltic Birch 18mm 48x96" from vendor B are the same item), record unit prices, and alert when prices change.

### v1 scope (build today)

In:
- Tenancy, auth, two roles (advisor, client)
- Connectors: QuickBooks Online (sandbox + production), plus **manual upload** (PDF/image invoices, CSV of purchases) so the demo works without a QBO connection
- Sync of Purchases, Bills, Vendor Credits, Vendors, Items, Attachables into raw + normalized tables
- Document pipeline: locate supporting document, extract header + lines with Claude, validate totals
- Item catalog, attribute parsing, cross-vendor matching, match-review queue
- Price observations, price-change alerts, Price watch screen
- Agent registry with **immutable versions**, rollback, and a **Builder** that drafts or edits an agent from plain language
- Agent runtime that loads an agent version and runs it with registered tools
- Workflow engine that executes **stored workflow definitions** (two seeded workflows). Workflows are data, but the visual builder UI is read-only in v1
- Run log: every workflow run, step, agent call, tool call, cost
- Threads: per-subject message log (agent and human), read + post

Out (designed for, not built):
- Visual workflow editing, custom collections and custom fields UI, dry-run sandbox, agent templates across tenants, A/B versions, outbound SMS, writes back to QuickBooks, card/bank connectors, Expenses/Bookkeeping/FP&A agents

---

## 2. Stack (decisions)

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript everywhere | One language for app, agents, workflows |
| App | Next.js (App Router), React, server actions + route handlers | |
| UI | Tailwind + shadcn/ui, themed with the Groundwork tokens (warm, earthy palette; dense data tables) | Swap in Groundwork components if they exist as a package |
| DB | Postgres 16 with `pgvector`, `pg_trgm` | Supabase or Neon; local via Docker |
| ORM / migrations | Drizzle | Schema in `packages/db` |
| Durable jobs / workflows | Inngest | Steps, retries, `waitForEvent`, cron. Runs locally with the Inngest dev server |
| LLM | Anthropic API via `@anthropic-ai/sdk`, tool use + JSON schema outputs | Models below |
| Object storage | S3-compatible (Supabase Storage or Cloudflare R2) | Original documents, never mutated |
| Auth | Supabase Auth or Clerk (open: pick one, keep behind `packages/auth`) | |
| Validation | Zod for every definition, tool input/output, API body | |
| Email (v1 only for purchaser requests, optional) | Resend | Behind an interface; SMS later |
| Tests | Vitest; Playwright for one happy-path e2e | |

Models (configurable per agent version, defaults):
- `claude-sonnet-5-5` — extraction, agent reasoning, Builder
- `claude-haiku-5-5` — high-volume match adjudication and classification
- `claude-opus-5-5` — optional for Builder on complex requests

---

## 3. Repository layout

pnpm monorepo.

```
/apps
  /web                 Next.js app: UI, API routes, auth, Inngest serve endpoint
/packages
  /db                  Drizzle schema, migrations, seed, typed queries
  /core                Domain types, Zod schemas, units of measure, money
  /connectors          Connector interface + qbo/ + upload/
  /documents           Document locate, store, extract, validate
  /catalog             Normalizer, attribute parsers, matcher
  /pricing             Price observations, alert rules
  /agents              Agent definition schema, versioning, runtime, tool registry, Builder
  /workflows           Workflow definition schema, step executors, Inngest functions
  /senses              Event emitters on data changes
  /threads             Threads + messages, command dispatch
  /llm                 Anthropic client wrapper, cost tracking, prompt utilities
  /auth                Tenant + role helpers
/fixtures
  /invoices            Sample millwork invoices (PDF/PNG) + expected extraction JSON
  /qbo                 Sample QBO API payloads
/docs
  ARCHITECTURE.md
```

Rule: packages depend downward only: `web → workflows → agents → (catalog, pricing, documents, threads) → connectors → db → core`. Agents never import `db` directly; they go through tools (section 9.4).

---

## 4. Tenancy and auth

- Every table has `tenant_id uuid not null`. Enforce with Postgres Row Level Security keyed on a `app.tenant_id` session setting set per request; also scope in queries.
- Roles: `advisor` (sees all screens for tenants they're assigned to), `client_admin`, `client_user` (Connectors, Inbox items assigned to them, Price watch, digests).
- Tables: `tenant`, `app_user`, `membership(tenant_id, user_id, role)`.

---

## 5. Data model

Three groups. All timestamps `timestamptz`, all money `numeric(14,4)` + `currency char(3)`, all ids `uuid` (v7).

### 5.1 Synced (raw)

```
connection(id, tenant_id, provider, status, external_account_id /*QBO realmId*/,
           credentials_encrypted jsonb, last_sync_at, sync_cursor jsonb, created_at)

raw_record(id, tenant_id, connection_id, provider, entity_type, external_id,
           external_version /*QBO SyncToken*/, payload jsonb, synced_at, is_deleted bool)
  unique(connection_id, entity_type, external_id, external_version)
```
Raw records are append-only. A new SyncToken inserts a new row. Normalized tables are rebuildable from raw.

### 5.2 Understood (normalized)

```
vendor(id, tenant_id, name, normalized_name, aliases text[], external_refs jsonb)

transaction(id, tenant_id, kind /*purchase|bill|vendor_credit*/, vendor_id, txn_date,
            total, currency, purchaser_ref text, payment_type, memo,
            source_raw_record_id, external_id, status /*needs_doc|doc_requested|doc_found|extracted|priced*/)

transaction_line(id, tenant_id, transaction_id, line_no, detail_type /*account|item*/,
                 account_ref, item_ref, description, qty, unit_price, amount)

document(id, tenant_id, transaction_id null, source /*qbo_attachable|upload|email|request*/,
         storage_key, mime_type, sha256, page_count, status /*stored|extracting|extracted|failed|needs_review*/,
         received_at)

doc_extraction(id, tenant_id, document_id, model, agent_version_id null, header jsonb,
               subtotal, freight, surcharges jsonb, tax, total, lines_sum, totals_match bool,
               confidence, created_at)

doc_line(id, tenant_id, extraction_id, line_no, vendor_sku, raw_description, qty, uom_raw,
         unit_price, ext_price, discount, page, bbox jsonb null)

catalog_item(id, tenant_id, category, canonical_name, attributes jsonb, standard_uom,
             embedding vector(1024) null, created_by, merged_into_id null, created_at)

item_alias(id, tenant_id, vendor_id, vendor_sku null, description_hash null,
           catalog_item_id, source /*auto|human*/, created_at)
  unique(tenant_id, vendor_id, coalesce(vendor_sku,''), coalesce(description_hash,''))

item_match(id, tenant_id, doc_line_id, catalog_item_id null, decision /*matched|new_item|unsure*/,
           confidence, method /*alias|rules|llm|human*/, hinge_attribute, candidates jsonb,
           decided_by /*agent_version_id or user_id*/, decided_at)

price_observation(id, tenant_id, catalog_item_id, vendor_id, observed_on, unit_price_std,
                  qty_std, standard_uom, doc_line_id, transaction_id)
  index(tenant_id, catalog_item_id, vendor_id, observed_on desc)

alert(id, tenant_id, kind, subject_type, subject_id, severity, title, body,
      evidence jsonb /*refs to doc_line, price_observation ids*/, dollar_impact,
      status /*open|accepted|dismissed*/, raised_by_run_id, created_at)
```

### 5.3 Platform

```
agent(id, tenant_id, slug, name, role, live_version_id null, status /*active|disabled*/, created_at)

agent_version(id, tenant_id, agent_id, version int, definition jsonb /*AgentDefinition*/,
              definition_hash, status /*draft|testing|live|retired*/, change_note,
              author_type /*user|builder*/, author_id, parent_version_id null, created_at)
  unique(agent_id, version)
  -- immutable: no UPDATE except status; enforce with trigger

workflow(id, tenant_id, slug, name, live_version_id, enabled)
workflow_version(id, tenant_id, workflow_id, version, definition jsonb /*WorkflowDefinition*/,
                 status, change_note, author_id, created_at)   -- same immutability rule

run(id, tenant_id, workflow_version_id, trigger jsonb, status, started_at, finished_at,
    cost_usd numeric(10,4), error jsonb)
step_run(id, tenant_id, run_id, step_id, step_type, agent_version_id null, input jsonb,
         output jsonb, status, attempts, cost_usd, tokens_in, tokens_out, started_at, finished_at)
tool_call(id, tenant_id, step_run_id, tool, input jsonb, output jsonb, status, duration_ms)

event(id, tenant_id, type, subject_type, subject_id, payload jsonb, created_at)  -- senses

thread(id, tenant_id, subject_type, subject_id, title, status, step_budget int, steps_used int)
message(id, tenant_id, thread_id, sender_type /*agent|user|system*/, sender_id,
        agent_version_id null, kind /*text|command|result*/, command text null,
        body jsonb, sources jsonb, created_at)

inbox_item(id, tenant_id, kind /*approval|match_review|doc_request|extraction_review*/,
           subject_type, subject_id, assignee_user_id null, assignee_role, title, payload jsonb,
           status /*open|resolved|expired*/, resolution jsonb, due_at, created_at, resolved_at)

memory_note(id, tenant_id, agent_id, scope, note, source_message_id null, created_at)

schema_extension(id, tenant_id, target /*e.g. 'vendor' or 'collection:jobs'*/, json_schema jsonb,
                 version, created_at)   -- table exists in v1, UI later
custom_record(id, tenant_id, collection, data jsonb, created_at, updated_at)  -- v1 unused
```

Extensibility rule (future custom fields/collections): core tables get an `ext jsonb default '{}'` column validated against the latest `schema_extension` for that target. Add `ext` to `vendor`, `transaction`, `catalog_item` now.

---

## 6. Connectors

### 6.1 Interface

```ts
interface Connector {
  provider: 'qbo' | 'upload';
  authorize?(tenantId): Promise<{ redirectUrl: string }>;
  handleCallback?(params): Promise<Connection>;
  sync(connection: Connection, opts: { since?: Date; full?: boolean }): AsyncIterable<RawRecordInput>;
  fetchAttachments?(connection, entityType, externalId): Promise<AttachmentRef[]>;
  downloadAttachment?(connection, ref): Promise<{ stream: Readable; mime: string; filename: string }>;
  verifyWebhook?(headers, body): boolean;
}
```
Connectors only produce raw records and files. Normalization happens in `packages/core` mappers per provider (`mapQboPurchase(raw) → TransactionInput`).

### 6.2 QuickBooks Online

- OAuth 2.0 authorization code flow, scope `com.intuit.quickbooks.accounting`. Store `realmId`, access + refresh tokens encrypted (AES-256-GCM, key from env). Access tokens are short-lived; refresh on 401 or before expiry and persist the new refresh token every time.
- Environments: sandbox base URL vs production base URL from env. Develop against a sandbox company.
- Entities synced: `Purchase`, `Bill`, `VendorCredit`, `Vendor`, `Item`, `Attachable`. Optionally `PurchaseOrder`.
- Initial sync: query each entity with paging (`STARTPOSITION`/`MAXRESULTS`), ordered by `MetaData.LastUpdatedTime`.
- Incremental: Change Data Capture endpoint (`cdc?entities=...&changedSince=...`) on a schedule (every 15 min) plus webhooks as a trigger to run CDC early. Store cursor in `connection.sync_cursor`.
- Webhooks: verify the HMAC-SHA256 signature header with the app's verifier token; enqueue `qbo/webhook.received`, never process inline.
- Lines: map `AccountBasedExpenseLineDetail` and `ItemBasedExpenseLineDetail` to `transaction_line.detail_type`.
- Attachables: query attachables referencing the transaction; download via the download endpoint (returns a temporary URL). Store bytes in object storage, dedupe by sha256.
- Rate limits: central throttle per realm with retry/backoff on 429.
- Verify endpoint shapes, minor version, and current Intuit API terms against Intuit's developer docs before coding.

### 6.3 Upload connector

- Upload PDF/JPG/PNG invoices → `document` (no transaction yet) → pipeline tries to link it to a transaction by vendor + total + date (±7 days). Unlinked documents still extract and price.
- Upload CSV of purchases (date, vendor, amount, memo) → `raw_record(provider='upload')` → transactions.
- This is the demo path for today if QBO app approval or sandbox setup blocks.

---

## 7. Data pipeline

```
raw_record ──map──▶ vendor / transaction / transaction_line
                           │ sense: transaction.created
                           ▼
                Document Clerk: locate support
         (QBO attachable → upload match → request purchaser)
                           │ sense: document.received
                           ▼
          extract (Claude) → doc_extraction + doc_line → validate totals
                           │ sense: document.extracted
                           ▼
         Catalog: match each doc_line → item_match (+ inbox if unsure)
                           │ sense: line.matched
                           ▼
         Pricing: price_observation (std unit) → alert rules
                           │ sense: price.changed / alert.raised
                           ▼
                Purchasing agent: digest, vendor compare
```

### 7.1 Extraction

- Send the document to Claude as a PDF or image content block with a tool whose input schema is `InvoiceExtraction` (Zod → JSON schema): header fields, lines[], subtotal, freight, surcharges[], tax, total, per-field confidence, page refs.
- Validation: `abs(sum(lines.ext_price) - subtotal) <= max(0.02, 0.5% of subtotal)` and `subtotal + freight + surcharges + tax ≈ total`. Fail → `document.status = needs_review` + `inbox_item(kind='extraction_review')`.
- Store the model and agent version on `doc_extraction`. Never overwrite; re-extraction inserts a new row.

---

## 8. Senses (events)

A sense is a typed event emitted when the data layer changes meaningfully. Written to `event` and sent to Inngest in the same transaction boundary (outbox pattern: insert `event`, a poller or after-commit hook sends to Inngest).

v1 event types:
`transaction.created`, `transaction.updated`, `document.received`, `document.extracted`, `document.extraction_failed`, `line.matched`, `line.needs_review`, `match.decided` (human), `price.observed`, `price.changed`, `alert.raised`, `doc_request.timed_out`, `schedule.tick`.

Workflows subscribe to event types (section 10). New agents and workflows add subscriptions without code changes.

---

## 9. Agents

### 9.1 Definition (stored in `agent_version.definition`)

```ts
const AgentDefinition = z.object({
  schemaVersion: z.literal(1),
  identity: z.object({ name: z.string(), role: z.string(), mission: z.string(), avatar: z.string().optional() }),
  kind: z.enum(['functional', 'platform']),
  model: z.object({ id: z.string(), maxTokens: z.number().default(4096), temperature: z.number().default(0) }),
  instructions: z.string(),                      // system prompt body, plain language
  scope: z.object({ entities: z.array(z.string()), connectors: z.array(z.string()).default([]) }),
  tools: z.array(z.string()),                    // ids from the tool registry
  commands: z.record(z.object({                  // callable by people, workflows, other agents
    description: z.string(),
    input: JsonSchema, output: JsonSchema,
    mode: z.enum(['tool', 'agent']),             // 'tool' = deterministic handler, 'agent' = reasoning loop
    handler: z.string().optional(),              // tool id when mode = 'tool'
  })),
  canCommand: z.array(z.string()).default([]),   // agent slugs it may call
  permissions: z.object({
    auto: z.array(z.string()),                   // tool ids allowed without approval
    approval: z.array(z.string()),               // tool ids that create an inbox approval
    mode: z.enum(['suggest_only', 'act']).default('suggest_only'),
  }),
  thresholds: z.record(z.number()).default({}),  // e.g. match_confidence_auto: 0.9, price_change_pct: 5
  budgets: z.object({ maxSteps: z.number().default(12), maxCostUsd: z.number().default(0.5) }),
  memory: z.object({ enabled: z.boolean().default(true) }),
});
```

### 9.2 Versioning

- Creating or editing an agent always inserts a new `agent_version` (status `draft`). Publishing sets it `live`, retires the previous live version, updates `agent.live_version_id` in one transaction.
- Rollback = publish an older version (copy it as a new version with `parent_version_id` pointing at the original, so history stays linear).
- `definition_hash` = sha256 of canonical JSON; no-op edits are rejected.
- Every `step_run`, `message`, `doc_extraction`, `item_match` decided by an agent records `agent_version_id`.
- Workflows reference an agent by slug (live version) or `slug@version` (pinned).
- **The runtime never reads agent settings from code.** Seeded agents are inserted as v1 rows by the seed script.

### 9.3 Runtime

```ts
runAgent({ tenantId, agentRef, command | task, input, threadId?, runContext }): Promise<AgentResult>
```
1. Resolve `agentRef` to an `agent_version`. Validate input against the command schema.
2. If command `mode = 'tool'`: call the handler directly, log, return.
3. Else build the prompt: platform preamble (rules: cite sources, use tools, never invent numbers) + `instructions` + memory notes + task input. Expose only `tools` in the definition, plus `ask_agent` if `canCommand` is non-empty, plus `finish(result)` whose schema is the command output.
4. Loop: model call → tool calls → results, until `finish` or budget hit. Enforce `budgets.maxSteps` and `maxCostUsd`. On budget hit: return `{status:'escalated'}` and create an inbox item.
5. Permission gate per tool call: in `auto` → run. In `approval` or `mode='suggest_only'` for side-effecting tools → create `inbox_item(kind='approval')`, return a pending marker; the workflow waits on `approval.resolved`.
6. Log `step_run`, `tool_call`, tokens, cost. Output must include `sources` (ids of records used); reject outputs without sources for alert-producing commands.

### 9.4 Tool registry (`packages/agents/tools`)

Each tool: `{ id, description, input: Zod, output: Zod, sideEffect: 'none'|'internal'|'external', handler }`. Agents only touch data through tools.

v1 tools:
| id | sideEffect | does |
| --- | --- | --- |
| `ledger.query` | none | Query transactions/lines/vendors with filters |
| `docs.find_support` | internal | Run locate sequence for a transaction |
| `docs.get` | none | Document metadata + signed URL + extraction |
| `docs.extract` | internal | Run extraction |
| `docs.request_from_purchaser` | external | Create doc request (email via Resend or inbox-only in v1) |
| `catalog.search` | none | Candidates by attributes + trigram + vector |
| `catalog.match_line` | internal | Full match pipeline for one doc_line |
| `catalog.create_item` | internal | New catalog item from parsed attributes |
| `prices.record` | internal | Price observation from a matched line |
| `prices.history` | none | Series for item/vendor/period |
| `prices.compare_vendors` | none | Same item across vendors |
| `alerts.raise` | internal | Create alert with evidence |
| `inbox.create` | internal | Create inbox item |
| `threads.post` | internal | Post message to a thread |
| `agents.ask` | internal | Ask another agent (routed by Coordinator) |
| `memory.write` | internal | Save a memory note |

### 9.5 Seeded agents (v1 rows)

| slug | kind | commands |
| --- | --- | --- |
| `document-clerk` | platform | `find-support`, `extract` |
| `catalog` | platform | `match-line`, `review-merge` |
| `purchasing` (identity "Pia") | functional | `record-prices`, `price-check`, `vendor-compare`, `materials-list`, `weekly-digest` |
| `coordinator` | platform | `route-ask`, `review` (multi-agent review: collect views, write one summary with disagreements) |
| `builder` | platform | `draft-agent`, `revise-agent` |

### 9.6 Builder

- `draft-agent(input: { description: string, tenantContext })` → `{ definition: AgentDefinition, summary: string, gaps: string[] }`.
- Builder receives the tool registry (ids, descriptions, side effects), available connectors and entities for the tenant, and the AgentDefinition JSON schema. It may only select existing tools; requests needing missing capabilities go in `gaps`.
- `revise-agent(input: { agentId, fromVersionId, instruction })` → new definition + human-readable diff (field-level JSON diff rendered as sentences).
- Server validates with Zod, forces `permissions.mode='suggest_only'` for new agents, strips any `external` tool from `auto`, and saves as `draft`. UI: form + summary + "Publish".

---

## 10. Workflows

### 10.1 Definition (stored in `workflow_version.definition`)

```ts
const WorkflowDefinition = z.object({
  schemaVersion: z.literal(1),
  trigger: z.discriminatedUnion('type', [
    z.object({ type: z.literal('event'), event: z.string(), filter: z.record(z.any()).optional() }),
    z.object({ type: z.literal('schedule'), cron: z.string(), tz: z.string() }),
    z.object({ type: z.literal('command'), command: z.string() }),
  ]),
  steps: z.array(Step),   // ordered; steps reference earlier outputs via {{steps.<id>.output.<path>}}
});

Step = { id, type, name, ...config } where type ∈
  'agent_task'   { agent: 'slug[@v]', task: string, input: Template }
  'command'      { agent: 'slug[@v]', command: string, input: Template }
  'condition'    { if: Expression, then: StepId, else: StepId }
  'approval'     { title: Template, assigneeRole, payload: Template, timeout: Duration }
  'request'      { channel: 'email'|'inbox', to: Template, message: Template, remindEvery: Duration, timeout: Duration, onTimeout: StepId }
  'loop'         { over: Template /*array*/, steps: Step[] }
  'notify'       { channel: 'thread'|'email'|'digest', message: Template }
  'map'          { from: Template, mapping: Record<string, Expression> }   // data movement, v1 internal use
```
Expressions: a small safe evaluator (JSONLogic or `filtrex`), no `eval`.

### 10.2 Executor

- One Inngest function per trigger kind loads the live `workflow_version`, creates a `run`, and executes steps with `step.run(stepId, ...)` so each step is durable and retried.
- `approval` and `request` use `step.waitForEvent('inbox/item.resolved', { match: 'data.inboxItemId', timeout })`.
- `loop` fans out with per-item `step.run` keys (`${stepId}:${index}`).
- Every step writes a `step_run`. Run status and cost roll up to `run`.

### 10.3 Seeded workflows

**purchase-intake** (trigger: `transaction.created`, filter: vendor category materials or any for v1)
1. command `document-clerk.find-support`
2. condition found? else → request (inbox doc request to purchaser; email if configured; remind 2d; timeout 5d → notify advisor)
3. command `document-clerk.extract`
4. condition totals_match? else → approval (extraction review)
5. loop over lines → command `catalog.match-line` (auto-match ≥ threshold; else inbox match review and wait)
6. command `purchasing.record-prices`
7. agent_task `purchasing`: "check new observations for changes; raise alerts with evidence"

**weekly-price-review** (trigger: schedule Mondays 7:00 tenant tz)
1. command `purchasing.weekly-digest` (changes, creep, vendor spread, new surcharges, dollar impact)
2. approval (advisor reviews digest)
3. notify digest to client

---

## 11. Threads and commands

- Every run creates or appends to a thread for its subject (transaction, catalog item, vendor, week).
- Messages carry `sources` (record ids). UI renders sources as links to the invoice page or record.
- People can post in a thread and invoke commands with `/command args` (parsed server-side into a `command` step on the target agent).
- `agents.ask` goes through `coordinator.route-ask`, which enforces `canCommand` and the thread `step_budget`.

---

## 12. Item matching

Implemented in `packages/catalog`. Deterministic first, model second, human last.

1. **Normalize** `raw_description`: uppercase, strip punctuation noise, expand abbreviations from a global dictionary plus per-tenant/per-vendor learned abbreviations (`BB`→`BALTIC BIRCH`, `MEL`→`MELAMINE`, `PLY`→`PLYWOOD`, `S2S`, `FAS`).
2. **Alias lookup**: `item_alias` by (vendor, vendor_sku) then (vendor, description_hash). Hit → matched, method `alias`, confidence 1.0.
3. **Parse attributes** with category parsers (regex + unit tables), falling back to an LLM parse with a strict schema:
   - Sheet goods: material, face/species, core, thickness (normalize: `3/4"`, `.75`, `18MM`, `23/32` → nominal `3/4in` with actual mm kept), width×length (`4X8`, `48X96`, `4'X8'` → `48x96in`), grade (`B/BB`, `BB/BB`, `CP`, `A1`), finish.
   - Hardwood: species, thickness quarters (`4/4`, `8/4`), grade, surfacing, UOM board foot.
   - Mouldings/edgebanding: profile or species, width, thickness, length or roll size, UOM linear foot.
   - Hardware: brand, model/SKU, finish, pack size.
   - Finishes/adhesives: brand, product line, sheen, container size.
4. **Candidates**: catalog items in the same category whose **key attributes** are equal; then top-k by trigram + embedding similarity as a backstop.
5. **Adjudicate** (Haiku): line + parsed attributes + top 5 candidates → `{ decision, catalog_item_id?, confidence, hinge_attribute }`.
6. **Route**: confidence ≥ `thresholds.match_confidence_auto` (default 0.90) → matched; `new_item` with high confidence → create catalog item; else inbox match review. Human decisions write `item_alias(source='human')`.
7. **Hard rules** (code, not model): never match when any key attribute differs; never compare prices across different `standard_uom` without a conversion rule.

UOM conversion table in `packages/core/units`: sheet, each, box(n), board foot, linear foot, roll(n ft), gallon, quart. Pack sizes parsed from description (`BX/10`, `100PK`).

Golden tests: `fixtures/matching/*.json` with line pairs labeled same/different. Target ≥ 95% precision on "same" at the auto threshold.

---

## 13. Pricing and alerts

- `prices.record`: `unit_price_std = unit_price / conversion(uom_raw → standard_uom)`; freight and surcharges are not folded into unit price (landed cost computed separately: allocate freight by line amount share).
- Alert rules (all thresholds from the Purchasing agent version):
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

## 14. API (route handlers under `/api`)

```
POST /api/connections/qbo/authorize        GET /api/connections/qbo/callback
POST /api/connections/:id/sync             POST /api/webhooks/qbo
POST /api/uploads (multipart)              GET  /api/documents/:id (signed URL + extraction)
GET  /api/transactions?status=&vendor=     GET  /api/catalog?category=&q=
POST /api/catalog/:id/merge                GET  /api/prices?item=&vendor=&from=&to=
GET  /api/alerts?status=                   PATCH /api/alerts/:id
GET  /api/inbox?kind=&status=              POST /api/inbox/:id/resolve
GET  /api/agents                           POST /api/agents/draft   {description}
GET  /api/agents/:id/versions              POST /api/agents/:id/revise {instruction, fromVersionId}
POST /api/agents/:id/versions/:vid/publish POST /api/agents/:id/rollback {versionId}
GET  /api/workflows                        GET  /api/workflows/:id/runs
GET  /api/runs/:id (steps, tool calls)     GET  /api/threads/:id   POST /api/threads/:id/messages
POST /api/inngest (Inngest serve)
```
All bodies validated with Zod; all handlers resolve tenant from session.

---

## 15. Screens → routes

| Screen | Route | Role |
| --- | --- | --- |
| Connectors | `/connectors` | client_admin, advisor |
| Agents directory | `/agents` | advisor |
| Agent detail (definition, versions, runs) | `/agents/[slug]` | advisor |
| Agent builder (describe → draft → review → publish; revise) | `/agents/new`, `/agents/[slug]/revise` | advisor |
| Workflows (read-only steps + run history) | `/workflows`, `/workflows/[slug]` | advisor |
| Run detail | `/runs/[id]` | advisor |
| Inbox (approvals, match review, doc requests, extraction review) | `/inbox` | all (filtered) |
| Catalog | `/catalog`, `/catalog/[id]` | advisor |
| Price watch | `/prices` | all |
| Thread | `/threads/[id]` | all |

Match review UI: invoice line (with page thumbnail), parsed attributes, top candidates side by side with attribute diffs highlighted, actions: Match / New item / Skip.

---

## 16. Security and audit

- Secrets in env; QBO tokens encrypted at rest; signed URLs for documents (5 min).
- RLS on every tenant table. Service role only in Inngest functions, which set `app.tenant_id` explicitly.
- Read-only toward client systems in v1. No QBO write scopes used.
- Immutable `agent_version`, `workflow_version`, `raw_record`, `doc_extraction` (trigger blocks UPDATE except status columns).
- Prompt-injection hygiene: document text and vendor descriptions are passed as data in tool results, never concatenated into instructions; agents cannot change their own permissions; external side effects always gated.

---

## 17. Configuration (env)

```
DATABASE_URL, DIRECT_DATABASE_URL
ANTHROPIC_API_KEY
INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY
STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY
ENCRYPTION_KEY                         # 32 bytes base64
QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI, QBO_ENV=sandbox|production, QBO_WEBHOOK_VERIFIER
AUTH_* (provider-specific)
RESEND_API_KEY (optional)
```

---

## 18. Build plan (ordered; each milestone ends green)

| # | Milestone | Done when |
| --- | --- | --- |
| M0 | Monorepo, Next.js app, Drizzle, Postgres + pgvector via Docker, Inngest dev server, auth with one seeded tenant + advisor | `pnpm dev` runs app + Inngest; login works |
| M1 | Schema for sections 5.1–5.3, RLS, immutability triggers, seed script | Migrations apply; seed inserts tenant, agents v1, workflows v1 |
| M2 | Upload connector + document storage + extraction + validation | Upload 3 fixture invoices → extractions match expected JSON within tolerance |
| M3 | Catalog: normalizer, sheet-goods + hardwood + hardware parsers, matcher, alias learning, golden tests | Golden tests ≥ 95% precision; Baltic birch example matches across 3 vendors |
| M4 | Agent runtime, tool registry, seeded agents, run/step/tool logging | `purchasing.price-check` runs end to end and logs cost |
| M5 | Workflow executor + `purchase-intake` + `weekly-price-review` + senses outbox | Uploading an invoice runs intake to priced lines with alerts |
| M6 | Pricing + alert rules + Price watch screen | Seeded price history produces a `price_jump` and a `vendor_spread` alert with evidence links |
| M7 | Inbox + match review UI + approval resolution resumes workflows | Resolving a match review continues the waiting run |
| M8 | Agents UI: directory, detail with version history, Builder draft/revise/publish/rollback | Describe "flag card charges over $500 missing receipts" → valid draft with gaps listed; publish creates v1; revise creates v2 with diff; rollback works |
| M9 | QBO connector: OAuth, initial sync, CDC, attachables, webhooks | Sandbox company syncs; a Bill with an attachment flows through intake |
| M10 | Threads view, run detail view, Connectors screen polish | Every alert links to its thread and run |

If time is short today, M0–M8 with the upload connector is the demo; M9 follows.

---

## 19. Testing

- Unit: normalizer, attribute parsers, UOM conversion, alert rules, Zod schemas, version immutability.
- Golden: extraction fixtures (`fixtures/invoices/*.pdf` + `*.expected.json`), matching pairs.
- LLM calls behind `packages/llm` with a record/replay mode so tests run offline.
- One Playwright e2e: upload invoice → match review → price watch shows the item.

---

## 20. Open decisions

- Auth provider (Supabase Auth vs Clerk).
- Hosting (Vercel + managed Postgres vs single container on Fly/Render).
- Whether purchaser requests go out by email in v1 or stay inbox-only.
- Embedding model/provider for `catalog_item.embedding` (can ship without vectors; trigram + attributes is enough for v1).
