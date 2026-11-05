# Mezonas — Architecture v0.10

> **Name and design (2026-11-03, owner):** the product is **Mezonas** (mezonas.com; `countersign` is the
> code name), built with the Mezonas design system in `packages/design-system`, which replaces Groundwork.
> Domains: `app.mezonas.com` (production), `staging.mezonas.com`.

> **v0.10 (2026-11-05, owner):** **Access: a vault per client, grants per agent, a separate code
> service, and browser logins.** Agents may sign in to a client's websites on their own, through a
> **dedicated agent account** whose login the client admin enters into the client's **vault**; the
> operator never sees it and agents never hold it (our code signs in, not the model). Every way into a
> client's tools (OAuth connections, API keys, browser logins) is a vault item encrypted with **that
> client's own key**; every agent reaches only the items bound to it, within **grant** limits set per
> agent. Second factors (codes by text or email, authenticator secrets) live in a **separate code
> service**, its own Worker with its own key and storage, which hands a code once to a login in progress.
> Sites are allowed by the operator with a **risk tier**; banks, payments, email accounts and identity
> providers are never signed in to by an agent. Changed: §1, §3, §6.9 and §6.10 (new), §16, §17, §18
> (M12), §20; CLAUDE.md invariant 8 and a new invariant 13.
>
> **v0.9 (2026-11-04, owner):** **Pia and the millwork shop are built separately**, outside this plan
> (the Materials pack, M8, stays in its own branches and is not merged here). The MVP is the platform
> with its tools: **Gmail moves into the MVP** (start Google's app verification now and measure how long
> it takes), and **QuickBooks Online** ships its reads plus the planned writes (attach a document,
> itemize lines with the total unchanged, update memo, update purchase cost), each behind approval.
> **Approver rules** decide who approves each change (`docs/plan.md` §1.17), and **billing through
> Stripe** comes into v1: a monthly base fee per active agent with a credit allowance, then usage
> beyond it. **Languages:** the portal and agents' client-facing text in six languages (§1); translating
> messages comes next. **Texts and calls:** Twilio (SMS, voice, numbers, WhatsApp), then WhatsApp via Meta, and ElevenLabs connectors
> (§1). Changed: §1 (MVP and v1 scope), §6.2,
> §9.5, §20.
>
> **v0.8 (2026-11-03, owner):** **approvals are on by default and set step by step.** Every step that
> changes a client's tool waits for a person unless that step is explicitly set to run without approval,
> which is only possible where the client's connection allows it. A **MVP** is defined (§1): Pia live
> for the millwork shop on its own QuickBooks; everything else follows. Slack stays out until later.
> Changed: §1, §6.1, §6.2, §6.5 (new), §9.1, §9.5, §9.6, §10.1, §10.2, §10.5, §16, §18, §20.
>
> **v0.7 (2026-11-03, owner's v1 screens, `docs/design/`):** workflows are **structured step lists**
> (numbered steps, drag to reorder, forks with ordered paths that join again), not free-form graphs, and
> the builder is a sortable list rather than a node canvas. Each connection has a **permission matrix**
> per client (read / create / update / delete: auto, approval or off, plus scope); writes are automatic
> only where it says so. **Connections live in the client portal:** the operator builds connectors and
> chooses which ones a client is offered; the client signs in to each of its own tools there. Changed:
> §1, §2, §4, §5.1, §6.1, §9.1, §9.3, §9.4, §9.5, §10, §12.2, §14, §15, §16, §18–20.
>
> **v0.6 (2026-11-03, owner):** **templates and client agents.** Agents are effectively built per client.
> What the operator reuses is a **template**; putting it into a client **forks** it into that client's own
> agent, which is then customized (different data, different flows) and has its own version history. A
> client agent remembers the template version it is based on, so template improvements reach each client
> as a reviewable **update** (a three-way merge), and a client's improvement can be **promoted** back into
> the template. One version = the whole agent (definition + workflows + settings). Replaces v0.5's
> deployments. Changed: §1, §4, §5.3, §9.1, §9.3, §9.5–9.7, §10.1, §10.3–10.5, §12.1, §12.2, §13–15,
> §18–20.
>
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
agents for many client businesses from one back office. Agents are built **per client**, but not from
scratch each time: the operator keeps **templates** of proven agents and puts them into a client by
**forking** one into that client's own agent, then customizing it for the client's data and flows.
Clients connect their systems, approve what agents want to do, and see the work in a portal.

Two surfaces, one platform:

- **The back office** (operator): every client in one place. Build and version templates and skills;
  fork templates into clients and customize each client's agents in the drag-and-drop workflow builder; test them
  against the client's own data; publish, pause and roll back per client; see which clients run which
  template version and how far each has been customized; offer template updates to clients and merge
  them; promote a good client change back into its template; watch runs and failures across clients; work
  clients' requests; see usage and model cost per client and per agent.
- **The client portal** (each client): self-service around the service they receive: what their agents
  did (reports and outcomes), runs as a plain-language timeline, the inbox (approve writes, answer
  requests, review matches), connections (connect or reconnect QuickBooks and Gmail), requests to the
  operator, and their users. No agent building, no prompts, no workflow builder, no model costs.

How the parts fit:

1. **Connections.** The operator builds the connectors (QuickBooks Online and Gmail, plus upload) and
   chooses which ones each client is offered; the client signs in to each of its own tools from the
   portal's Connections page. A connection brings data in and exposes **tools**: actions agents can take
   against that system, reads and writes, within the permissions set for it.
2. **Skills.** Reusable capabilities ("extract an invoice", "find the receipt for a transaction", "match
   line items to the catalog", "write a weekly summary"): instructions plus the tools they need, typed
   input and output, settings. Built in (platform and packs) or written by the operator; shared by every
   agent, or written for one client.
3. **Templates.** A reusable agent: identity, instructions, skills and settings, permissions, budgets, and
   its workflows (step lists in the builder). Created from scratch or by the Builder. Versioned as a whole.
4. **Client agents.** Forking a template into a client creates that client's agent at the template's
   current version. The operator customizes it (settings, instructions, skills, workflows, steps) for
   that client, binds the client's connections, test-runs it on the client's data, publishes and
   activates it. Every change is a new version of **that client's** agent. Client agents can also be
   built from scratch for one client.
5. **Lineage and updates.** Each client-agent version records the template version it is based on. When
   the template moves on, the back office shows which clients are behind and what the update changes;
   applying it is a three-way merge (template base → new template, against the client's customizations),
   reviewed, test-run and published per client. A client change worth keeping for everyone can be
   promoted into a new template draft. A client agent can be detached from its template.
6. **Runs.** Agents do the work and update the client's tools; every run is logged step by step with cost
   (operator-only); every write to a client's system follows that connection's permissions: automatic,
   approved by a person, or off.
7. **Requests.** A client asks for a change or a new service from the portal; it lands in the operator's
   queue.

### Concepts

| Concept | What it is | Defined in |
|---|---|---|
| Operator | The owner and their team; one back office across all clients | §4 |
| Client | A business served by the operator (a tenant); its data is isolated | §4 |
| Connection | One client's link to an external system (credentials, sync state) | §6 |
| Tool | One atomic action with typed input/output and a side-effect level (`none`, `internal`, `external`) | §6.1, §9.4 |
| Skill | A reusable capability: instructions + tools + input/output schema + settings | §9.2 |
| Agent bundle | One agent version: definition + workflows + settings, versioned as a whole | §9.1 |
| Template | An operator agent kept for reuse; not run for clients directly | §9.3 |
| Client agent | A client's own agent, usually forked from a template, customized and versioned per client | §9.3 |
| Workflow | A structured list of steps (with forks) inside an agent bundle, edited in the builder | §10 |
| Run | One execution of a client agent's workflow, with every step, tool call and cost | §10.3 |
| Inbox | Where people approve, review and answer what agents ask | §11 |
| Request | A client's ask to the operator (change or new service) | §11 |
| Pack | A bundle of domain tools, skills, tables, reports and templates (e.g. Materials) | §12 |

### First client and first agent

First client: a ~$2M millwork shop. First template: **Pia, the Materials agent** (Materials pack, §12).
She pulls purchases, finds the supporting invoice, extracts line items, matches each line to a shared
item catalog (e.g. "BB PLY 3/4 4X8" from vendor A and "Baltic Birch 18mm 48x96" from vendor B are the
same item), records unit prices, and alerts when prices change. Pia is a template built entirely from
platform parts; the millwork shop gets its own fork of her, customized to its vendors, categories and
approvals. **Nothing in the platform core is material-specific;** a check enforces that platform packages
never import a pack (§3).

### First use case (built after the platform foundation)

The platform is the product; this is the first thing it will be used for (`docs/plan.md` §3 sets the
build order: foundation, cloud, then surfaces, tools and agents). **Goal:** Pia running for the millwork shop on its own QuickBooks. A new bill or purchase arrives; Pia
finds the invoice (attached in QuickBooks, uploaded, or forwarded by email), reads it, matches the lines
to the shop's item catalog, records prices and raises alerts, and proposes the QuickBooks update
(itemized lines and the invoice attached). The shop approves it in the portal and QuickBooks is updated.
The shop sees the run and Price watch in the portal; the operator runs it all from the back office and
can change Pia's workflow, publish a new version and roll it back.

In the MVP:
- Sign-in (WorkOS), one operator, clients (the millwork shop and the sandbox), back office and portal
  shells, inbox and approvals, the portal's Connections page
- Connectors: **QuickBooks Online** (sync, read tools, and the writes in v0.9: attach, itemize lines,
  update memo, update purchase cost), **Gmail** (moved into the MVP in v0.9), and **upload, with email
  forwarding** (§6.5); documents capability
- Templates and client agents: create, fork, edit, versions, publish, rollback, bindings, activation
  (lineage is recorded from the start so updates can come later without a migration)
- Workflow engine and the step-list builder with forks, person steps and **per-step approvals**; test
  runs; back-office run view and portal run timeline
- Approver rules and Stripe billing (v0.9). Pia and the Materials pack are built separately (v0.9).

After the MVP, in this order unless the owner reorders: template updates and promotion (three-way merge
and merge view); Gmail connector; the Builder (drafting agents and skills from a description);
operator-written skills; requests from clients; usage and cost views beyond per-run cost; notification
emails and CSV export; threads and `/skill` commands; agents asking other agents. Later still: Slack,
Google Drive and the other connectors in the design, and the header command bar.

### v1 scope (the full target)

In:
- Tenancy for many clients, one operator; roles `operator`, `client_admin`, `client_user`; operator-led
  onboarding (create client, invite users, offer connectors); a **sandbox client** with fixture data
  for building and demos
- Connector framework (manifest: auth, synced entities, tools). Connectors: **QuickBooks Online**
  (sandbox + production; read sync plus write tools), **Gmail** (find invoices and receipts in a
  mailbox; drafts and labels as write tools), and **upload with email forwarding** (PDF/image
  documents, CSV, forwarded emails). Added by the owner, 2026-11-04: **webhooks** (in and out; works
  with Zapier, Make and n8n; a published Zapier app later) and **Zoho CRM** (OAuth; read and write
  tools; sync later) (§6.6, §6.7); and **Podio** (OAuth; workspaces, apps, items, comments, tasks) (§6.8)
- Documents capability: store originals, extract with Claude, validate, link to records
- **Skills** (operator): built-in plus operator-written (no code), shared or for one client; versioned
- **Templates** (operator): from scratch or the Builder; workflows in the **drag-and-drop builder**;
  immutable versions, release notes, publish, rollback
- **Client agents** (operator): fork from a template or build from scratch; customize in the same editor
  and builder; bind connections; test-run on the client's data; publish, activate, pause, roll back;
  **diff against the template**; **template updates** by three-way merge with conflict resolution;
  **promote** a client change into a template draft; detach
- Workflow engine executing client agents' workflows; triggers by event, schedule, manual and command
- **Write-back:** external tools act on client systems with **approval on by default, set per step**,
  within each connection's permission matrix, with an audit record and the before state for every write
- **Back office:** clients overview and health, client detail, template lineage ("used by", versions
  behind, customizations), runs and failures across clients, request queue, operator inbox, usage and
  model cost per client and agent
- **Client portal:** overview of their services and outcomes, reports (pack reports + activity, CSV
  export), run timeline, inbox, connections, requests, users and notification settings
- **Approver rules** (v0.9): per client, set by the operator, tightened by the client admin; they name
  who approves each change (`docs/plan.md` §1.17)
- **Billing** (v0.9): Stripe customers per client; a monthly base fee per active agent that includes a
  credit allowance, then metered usage from `usage_daily` beyond it, invoiced by Stripe
- ~~Materials pack~~: built separately from this plan (v0.9)
- **Texts and calls** (v0.9): **Twilio** (SMS, voice, phone numbers and WhatsApp first), then
  **WhatsApp through Meta's Cloud API** (the client's own number and account), and **ElevenLabs** (voice
  agents for live calls) as connectors whose tools agents use, drawing on the client's knowledge;
  sending a text or placing a call is an external action behind approval (`docs/plan.md` §1.19)
- **Reach out** (v0.9): agents know the people they work with and contact them by email, text,
  WhatsApp or call, in their language, under conditions, through channels each agent is given (a
  mailbox of its own, Mezonas' sending service or a person's Gmail; the client's numbers). Sending
  email from Gmail comes into v1, behind approval (`docs/plan.md` §1.25)
- **Languages** (v0.9): the portal and agents' client-facing text in English, Spanish, French,
  Portuguese (Brazil), Italian and German, per client with a per-user choice; the back office stays in
  English. Next: agents translating incoming and outgoing messages (`docs/plan.md` §1.18)
- **Access** (v0.10): a **vault** per client (every connection, API key and browser login, encrypted
  with the client's own key, secrets write-only); **grants** that narrow what each agent may do with
  each connection bound to it; a separate **code service** for second factors; **browser connections**
  that sign in to sites the operator allows, by risk tier, as a dedicated agent account; optional
  **human release** of any vault item with a one-time code to a named person (§6.9, §6.10,
  `docs/plan.md` §1.26)

Out (designed for, not built):
- Client self-serve building;
  showing workflows or instructions to clients; other operators on the platform (one operator in v1);
  automatic template updates (every update is reviewed per client)
- Connectors beyond QBO, Gmail and upload (Slack, Google Drive, Outlook, bank and card feeds, Ramp,
  HubSpot); Gmail push notifications (v1 polls); sending email without a person's approval; code steps
  in workflows; A/B versions; custom collections and fields UI
- Other packs (Expenses, Bookkeeping, FP&A); they plug in the same way as Materials

---

## 2. Stack (decisions)

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript everywhere | One language for app, agents, workflows |
| App | React + Vite single-page app, served as static assets by the API Worker | Same shape as Plenary Labs |
| API | Hono on Cloudflare Workers; one Zod route contract shared by API and client | |
| UI | The Mezonas design system (`packages/design-system`: tokens, component CSS, logos, icons, Geist fonts) with Tailwind mapped to its tokens | Plain CSS from the owner; light and dark themes; brand book in its README |
| Workflow builder | A nested sortable list (`@dnd-kit/core` + `@dnd-kit/sortable`) | Structured steps and forks (owner's design); no node canvas |
| DB | Postgres 16 with `pgvector`, `pg_trgm` | Neon, reached from Workers through Hyperdrive; local via Docker |
| ORM / migrations | Drizzle | Platform schema in `packages/db`, pack schemas in their packs, one migration sequence |
| Durable jobs / workflows | Cloudflare Workflows | `step.do` with retries, `step.waitForEvent`, `step.sleep`; Worker cron for schedules |
| LLM | Anthropic API via `@anthropic-ai/sdk`, and OpenAI's Responses API for `openai:` model ids (owner, 2026-11-04), tool use + structured outputs | Models below |
| Object storage | Cloudflare R2 (Worker binding; S3 API for signed URLs) | Original documents, never mutated |
| Auth | WorkOS (AuthKit), sealed session cookie; behind `packages/auth` | Same as Plenary Labs |
| Validation | Zod for every definition, tool input/output, API body | Shared with the builder through `packages/core` |
| Email (optional) | Resend | Behind an interface; SMS later |
| Tests | Vitest (`@cloudflare/vitest-pool-workers` for Worker and Workflow tests); Playwright e2e | |

Models (configurable per agent version and per skill, defaults):
- `claude-sonnet-5-5` — extraction, agent reasoning, Builder
- `claude-haiku-5-5` — high-volume classification and adjudication (e.g. item matching)
- `claude-opus-5-5` — optional for the Builder on complex requests
- `openai:gpt-5.5` — OpenAI, for any agent or skill the operator sets to it (the `openai:` prefix routes the call)

---

## 3. Repository layout

pnpm monorepo.

```
/apps
  /api                 Hono Worker: /api routes, auth, static assets, Workflow classes, cron;
                       registers connectors and packs
  /web                 React + Vite app: back office (incl. the workflow builder) and client portal, typed API client
  /mfa                 The code service (v0.10, §6.9): a separate Worker with its own key and Durable Object
                       storage; receives second-factor codes by text and email and hands each one once to a
                       login in progress; reached by apps/api only through a service binding; imports core only
/packages              the platform: never imports a pack
  /core                Domain types and Zod schemas (AgentBundle, AgentDefinition, SkillDefinition,
                       Workflow, ToolSpec, ConnectorManifest, PackManifest), workflow validation,
                       bundle diff and three-way merge (shared with the merge view), route contract,
                       units, money
  /db                  Drizzle platform schema, migrations (platform + packs), seed, withTenant()
  /llm                 model client (Anthropic, OpenAI), cost tracking, record/replay
  /auth                Tenant + role helpers, WorkOS and dev adapters
  /senses              Event outbox
  /connectors          Connector framework + qbo/ + upload/; object storage
  /documents           Document store, extraction, validation, linking
  /threads             Threads + messages, command parsing
  /agents              Tool, skill and agent registries; versioning; runtime; Builder
  /workflows           Workflow executor (against a StepRunner interface), trigger router
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
| `operator` | The owner and their team | Everything in the back office: create clients, invite users, offer connectors and set their permissions and configuration, enable packs; build, test, **publish** and roll back templates, skills and client agents; fork, customize, update, promote, activate and pause client agents; work requests; see runs, usage and cost across their clients; approve on a client's behalf when delegated |
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
  overridable per client agent. Every approval records who approved.
- Templates and shared skills (§5.3) belong to the operator: their rows have `tenant_id` null and are
  readable only in operator sessions (`app.operator = on`) through the policy
  `tenant_id = any(app.tenant_ids) or (tenant_id is null and current_setting('app.operator', true) = 'on')`.
  Client agents and client-only skills carry their client's `tenant_id` like any client data, but their
  definitions are still never returned through portal routes (§14).

---

## 5. Data model

All timestamps `timestamptz`, all money `numeric(14,4)` + `currency char(3)`, all ids `uuid` (v7 unless
stated). Three groups: platform, shared business records, pack tables.

### 5.1 Connections and raw data

```
connection(id, tenant_id, connector /*'qbo'|'gmail'|'upload'*/, status, external_account_id
           /*QBO realmId, Gmail address*/, credentials_encrypted jsonb, config jsonb /*e.g. Gmail query*/,
           last_sync_at, sync_cursor jsonb /*QBO CDC time, Gmail historyId*/, connected_by, created_at)

-- connection also has: permissions jsonb  /*{ read, create, update, delete: 'auto'|'approval'|'off', scope }*/
-- tenant.settings.connectors_offered: connector ids the operator offers this client
connection_change(id, tenant_id, connection_id, actor_id, change jsonb, created_at)   -- append-only

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

-- Skills: tenant_id null = shared by every agent; set = written for one client
skill(id, tenant_id null, slug, name, live_version_id null, status, created_at)
skill_version(id, tenant_id null, skill_id, version int, definition jsonb /*SkillDefinition*/,
              definition_hash, status /*draft|live|retired*/, change_note, author_id,
              parent_version_id null, created_at)
  unique(skill_id, version)          -- immutable except status (trigger)

-- Agents: templates (tenant_id null) and client agents (tenant_id set)
agent(id, tenant_id null, kind /*template|client*/, slug, name, role,
      template_id null,              -- client agents: the template they were forked from
      linked bool default true,      -- false = detached: no further template updates
      live_version_id null, status /*active|disabled*/, created_at,
      -- client agents only (operational, not part of the versioned bundle):
      service_name, service_description,                  -- what the client sees in the portal
      bindings jsonb /*connector → connection_id*/,
      approver /*null = client setting | client_admin | operator*/,
      run_status /*draft|testing|active|paused|retired*/)
  unique(tenant_id, slug)            -- templates: unique among templates; client agents: per client

agent_version(id, tenant_id null, agent_id, version int,
              bundle jsonb /*AgentBundle: definition + workflows + settings*/, bundle_hash,
              status /*draft|live|retired*/, change_note, release_note null /*templates*/,
              author_type /*operator|builder|pack|merge|promote*/, author_id,
              parent_version_id null,           -- the version it was edited from (same agent)
              based_on_template_version_id null, -- client versions: the template version they reconcile with
              merged_from_version_ids uuid[] null, -- update merges and promotions: the other inputs
              created_at)
  unique(agent_id, version)          -- immutable except status (trigger)

agent_change(id, tenant_id null, agent_id, actor_id, change jsonb, created_at)
                                     -- append-only log of operational changes (bindings, approver, run_status)

run(id, tenant_id, agent_id, agent_version_id, workflow_slug, config jsonb /*bindings + approver snapshot*/,
    mode /*live|test*/, trigger jsonb, status, started_at, finished_at, cost_usd numeric(10,4), error jsonb)
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
           pack null, agent_id null, subject_type, subject_id, run_id null, assignee_user_id null,
           assignee_role, title, payload jsonb, status /*open|resolved|expired*/, resolution jsonb, due_at,
           created_at, resolved_at)

memory_note(id, tenant_id, agent_id, scope, note, source_message_id null, created_at)
                                     -- per client agent; never shared across clients or with templates

usage_daily(tenant_id, day, agent_id, runs, steps, documents, external_actions, tokens_in, tokens_out,
            cost_usd)                -- rollup for the back office and future billing

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

**Who does what.** The operator builds connectors (code: manifest, sync, tools) and, per client,
chooses which are **offered**, sets each connection's permission matrix and configuration (e.g. the Gmail
query), and watches sync health. The **client** signs in to its own tools in the portal's Connections
page (OAuth with the provider, so the operator never sees or holds the client's passwords), and can
reconnect, disconnect and see what each connection lets agents do. The operator cannot connect a tool
on a client's behalf; a connector that needs reconnecting shows up in both the portal and the back
office. Upload is built in and always on. An operator may send a reminder that opens the portal's
Connections page at the right connector.

**Permissions per connection** (owner's design, Connections screen). Each tool declares a `verb`
(`read`, `create`, `update`, `delete`). Each client connection stores a matrix: for each verb `auto`,
`approval` or `off`, plus a scope the connector understands (e.g. "AP folder only", "bills, purchases,
vendors, items, attachments"). For writes, the matrix is a **ceiling**: `approval` means every write
waits for a person; `auto` means a step **may** be set to run without approval (each step still
defaults to approval, §9.5); `off` means agents can't do it at all. Defaults when a tool is connected:
read `auto`, create and update `approval`, delete `off` (v1 has no delete tools). The operator sets the
matrix; the client admin sees it in the portal and can tighten it, never loosen it; every change is a
`connection_change` row.

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
- **Tools, write** (`external`; approval per step, §9.5). MVP, as in the design's run screen:
  `qbo.bill.update_lines` / `qbo.purchase.update_lines` (replace an account line with the invoice's item
  lines; the total must stay unchanged or the write is refused) and `qbo.attachable.upload` (attach the
  invoice). Later: `qbo.bill.create` (draft bills from invoices), `qbo.item.update_purchase_cost`, memo
  updates. Each write sends the current `SyncToken`, stores the prior state in `external_action.before`,
  and fails cleanly on a stale token (the record changed since the agent read it).
- Rate limits: central throttle per realm with retry/backoff on 429.
- Verify endpoint shapes, minor version, and current Intuit API terms against Intuit's developer docs
  before coding.

### 6.3 Upload connector

- Upload PDF/JPG/PNG documents → `document` (no transaction yet) → linked to a transaction by vendor +
  total + date (±7 days) when possible. Unlinked documents still extract.
- Upload CSV of purchases (date, vendor, amount, memo) → `raw_record(connector='upload')` → transactions.
- The demo path when QBO is not connected.

### 6.4 Gmail (after the MVP)

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

### 6.5 Email forwarding (built in, with upload)

The MVP's email path, and a fallback for clients who don't connect a mailbox (the design's "Upload and
forwarding · built in"). Each client gets a private forwarding address (e.g.
`<client>-<random>@in.<domain>`, kept with the allowed senders on the client's upload connection), shown
on the portal's Connections page; the client adds a forwarding
rule in their own mail (e.g. from `ap@`).
- Received by **Cloudflare Email Routing** into the Worker's `email()` handler. Only mail from the
  sender addresses or domains the client lists is accepted; everything else is dropped and counted.
- Each message's PDF and image attachments become `document(source='email')`, deduplicated by sha256
  and linked like uploads (vendor + total + date, with the sender domain as a vendor signal). Headers and
  subject are kept on the document; bodies are not stored. Email text is untrusted (§16).
- Verify Email Workers' message size limits and MIME parsing (e.g. `postal-mime`) at the start of M2.

### 6.6 Webhooks (owner, 2026-11-04)

A generic connector (`webhook`, `auth: 'none'`) for Zapier, Make, n8n and anything else that can send
or receive an HTTP POST. A published Zapier app (triggers and actions over the same endpoints) comes
later; its plan is in `packages/connectors/src/webhook/NOTES.md`.

- **In.** The client creates inbound hooks on its webhook connection in the portal (a name each). A hook's
  URL is `POST /api/hooks/:clientId/:hookId` with a secret token (`?token=` or the `x-mezonas-token`
  header), or an HMAC-SHA256 signature over `timestamp.body` (`x-mezonas-signature`,
  `x-mezonas-timestamp`, five-minute window) for senders that can sign. Tokens are kept in the
  connection's encrypted credentials and shown only in the client's portal; hook ids and names are in
  `connection.config` so the operator can filter triggers on them. Tokens are compared in constant time.
  A delivery is JSON or a form, at most 64 KB, at most 60 a minute per hook; it is stored once as
  `raw_record(entity_type='Delivery')` keyed by the sender's `Idempotency-Key` (else the body's sha256),
  so a resend is acknowledged and stored nothing, and emits **`webhook.received`** (connector event type,
  §8) with the body as `data`. The body is untrusted data (invariant 9): it reaches steps only through
  the trigger payload and tool inputs, never instructions.
- **Out.** `webhook.event.send` (`external`, verb `create`, approval on by default) POSTs
  `{ event, data, id, sentAt }` as JSON to the outbound URL the client pasted (its Zap's catch hook),
  with `Idempotency-Key` (the external action's key) and an `x-mezonas-signature` HMAC under a signing
  secret shown in the portal. Only `https` URLs to public hosts (no IP literals in private ranges, no
  `localhost`/internal names), no redirects, 10-second timeout; the response status and the first 2 KB
  of its body are the action's result. The outbound URL is in the encrypted credentials.
- How-to for clients: `docs/connect-zapier.md`.

### 6.7 Zoho CRM (owner, 2026-11-04)

Connector `zoho_crm`, OAuth 2.0 (Zoho Accounts, multi data center). Facts checked and unchecked are in
`packages/connectors/src/zoho_crm/NOTES.md`.

- The client signs in from the portal. The authorization request goes to `accounts.zoho.com`
  (`access_type=offline`, `prompt=consent`); the callback returns `location` and `accounts-server`. The
  code is exchanged at that accounts server, only if it is a known Zoho accounts host; the token
  response's `api_domain` is where every API call goes. Tokens, the accounts server and the API domain
  are encrypted on the connection; the data center and API domain are also in `config`, the org id is
  `external_account_id`. Access tokens last an hour and are refreshed (and persisted) before expiry or
  on a 401; a refused refresh asks the client to reconnect. Disconnect revokes the refresh token.
- Scopes: read, create and update for Leads, Contacts, Accounts, Deals, Notes and Tasks, plus org read.
  No delete scope.
- **Tools, read** (`none`): `zoho_crm.record.search` (criteria, email, phone or word, paged),
  `zoho_crm.record.get`.
- **Tools, write** (`external`, approval on by default): `zoho_crm.record.create`,
  `zoho_crm.record.update` (before state: the record's current values of the fields it changes; refused
  if the record changed since the agent read it, by `Modified_Time`), `zoho_crm.note.create`,
  `zoho_crm.task.create`. Delete is off.
- Sync of modules into `raw_record` and Zoho notifications are follow-ups; v1 is tools only.
- Rate limits: credits per rolling 24 hours and concurrent-request caps by edition; a 429 fails the call
  so the step retries with backoff.

### 6.8 Podio (owner, 2026-11-04)

Connector `podio` (the tool first noted as "poladio"), OAuth 2.0. Facts checked and unchecked are in
`packages/connectors/src/podio/NOTES.md`.

- The client signs in from the portal (`podio.com/oauth/authorize`, code exchanged at
  `api.podio.com/oauth/token`). Tokens are encrypted on the connection; the signing-in user is
  `external_account_id`. Access tokens last 8 hours and are refreshed (the new refresh token saved
  each time); a refused refresh asks the client to reconnect.
- Podio apps are built by each client, so tools take fields generically (`{ <field external_id>:
  value }`) and check them against the app's own definition at call time: unknown, inactive or
  read-only fields, values of the wrong type, choices that don't exist and missing required fields are
  refused before anything is written.
- **Tools, read** (`none`): `podio.space.list`, `podio.app.list`, `podio.app.get` (fields, types,
  choices), `podio.item.filter`, `podio.item.get`.
- **Tools, write** (`external`, approval on by default): `podio.item.create` (its `external_id` is the
  external action's key, looked up first, so a retry finds the first item), `podio.item.update` (before
  state: the changed fields' values; refused if the item's revision moved), `podio.comment.create`,
  `podio.task.create`. Delete is off.
- Rate limits answer 420; the call fails as retryable. Sync and Podio hooks are follow-ups.

### 6.9 Access: the client's vault, grants and the code service (owner, 2026-11-05)

**The vault.** Everything that lets an agent into a client's tools is a **vault item**, stored as a
`connection`: OAuth connections (as today), API keys (`auth: 'api_key'`, entered once in the portal) and
browser logins (§6.10). Secrets are encrypted with **the client's own data key**: each client has a
key, generated when first needed and stored only wrapped by the master `ENCRYPTION_KEY` (`tenant_key`).
A credential envelope names the client key it was written with and stays bound to its client and
connection (§16). Rotating the master key re-wraps client keys only; destroying a client's key makes
everything it encrypted unreadable at once (for retiring a client). Secrets are **write-only**: the
client admin enters them, no screen or route returns them, and they can only be replaced or removed.
The operator never sees a client's secret.

**Grants.** A client agent reaches a vault item only through its **binding** (as today: the operator
binds one connection per connector, or per site for browser connections). A binding may carry **grant
limits**: a ceiling per verb (`auto`, `approval`, `off`) and, optionally, the subset of the connector's
tools the agent may call. What a call may do is the strictest of: the connection's matrix, the agent's
grant, the step's approval setting and the agent's mode. So one QuickBooks connection can serve an
intake agent that only reads and a billing agent that creates bills with approval, and an agent with no
binding cannot reach QuickBooks at all. The operator sets and loosens grants; the client admin sees every
agent's access on the portal's **Access** page and can tighten or revoke a grant at once (invariant 8's
rule: only the operator loosens). Every change is an `agent_change` row.

**The code service** (`apps/mfa`). Second factors never live with passwords. A separate Worker, with
its own encryption key, its own Durable Object storage (no database shared with `apps/api`) and its own
secrets, holds the client's **agent identities**: per identity an email address on Mezonas' agent domain
(`AGENT_EMAIL_DOMAIN`, Cloudflare Email Routing → the code service) and optionally a phone number in a
Twilio subaccount kept for codes, plus any authenticator (TOTP) secrets. The client's tool admin creates
the agent account in their tool with that address and number. A login in progress (our code, §6.10)
**opens a wait** for one identity, one site, the expected sender and the code's pattern, for a few
minutes; the service reads the code out of the matching message with that pattern (never a model),
hands it **once** to the login that asked, closes the wait and deletes the message. Anything that
arrives outside a wait is never handed out: an unexpected code or a password-reset message is held and
raises an **alert** to the operator and the client admin, since it means someone else is trying that
account. Links in messages are never followed. Email codes count only when the message passes SPF,
DKIM and DMARC. Each identity has a daily cap on code requests. Only `apps/api` can call the service,
through a service binding; its only public routes are Twilio's signed inbound webhook and the email
handler.

**Human release (optional, owner 2026-11-05).** Any vault item can require a person to release it
before an agent uses it. Off by default; when on, the connection names one person (a user of the client
with a verified phone or email), the channel (text or email) and the release window (one run, or up to
24 hours). The first time a run needs the connection without a valid release, the step pauses and we
send that person a one-time 6-digit code; they enter it in the portal or reply to the message with it,
and the agent goes on. The code proves possession of the person's phone or inbox, not only a portal
session. Codes are stored hashed, last 10 minutes, allow 5 tries and work once; the agent never sees
one. No release by the end of the wait fails the step ("access not released"). The client admin turns it
on or off and picks the person; the operator can turn it on, never off. Every request, release, failed
try and revoke is logged, and the Access page shows live releases with a Revoke button.

### 6.10 Browser connections (owner, 2026-11-05)

For tools with no API, an agent may work in the website itself, on **Cloudflare Browser Run**, signed in
as a **dedicated agent account** (never a person's own login) that the client creates with the
smallest role that does the job.

**Sites.** The operator keeps a catalogue of allowed sites (`browser_site`, versioned like skills): the
login page and the origins credentials may be typed into, the login steps, how to recognise the
signed-in page, how to sign out, the pages agents may open and the pages they never open (on every site:
settings, passwords, users and permissions, billing and payment, deletion), how second-factor codes
arrive, and a **risk tier**:

| Tier | Examples | Agent signs in on its own | Writes |
|---|---|---|---|
| low | supplier portals, price lists, invoice downloads, shipment tracking | yes | approval by default; `auto` allowed by the matrix as for any connection |
| medium | ordering portals, CRMs without an API | yes | always approved |
| high | payroll, tax portals, health records, insurance | no: a person signs in through Browser Run's human handoff | always approved |
| blocked | banks, payments, crypto, email accounts, identity providers, password managers | never | never |

The tier comes from four questions: can the site move money, change access or reset accounts, does it
hold regulated data, and does it have an API (then we use the API). A client can make a site stricter
for itself, never looser.

**Signing in.** A browser connection is a vault item: the username and password of the agent account,
entered by the client admin, plus the identity in the code service for its second factor. Our code signs
in, not the model: it opens the login page, checks the address against the site's login origins (no
match, nothing typed), types the credentials, asks the code service for the code, and checks the
signed-in page. Session recording is off during sign-in. The model then works through browser tools
(read a page or table, download a file as a document, and, later, submit a form as an external action
behind approval); page text is data (invariant 9), password fields are removed from what it reads, it
cannot run scripts in the page and it can only open the site's allowed pages. At the end our code signs
out and the browser is destroyed. Low-tier sites may keep the session, encrypted in the vault, to skip
the next sign-in.

**Stops.** A CAPTCHA, an "unusual activity" or new-device check, or any unexpected page stops the run
and asks a person; two failed sign-ins disable the connection so the client's account is never locked.
Each connection has a daily cap on sign-ins and optional hours. Each session records the pages visited,
the actions and screenshots; the client sees a plain summary in the run timeline and can disconnect, which
deletes the stored login and session at once. The client confirms it owns the account and that the
site's terms allow automated access; the operator checks the terms before allowing a site.

## 7. Documents capability

A platform capability any pack or custom skill can use; exposed as tools (`docs.*`, §9.4).

- Store: originals in R2 keyed by sha256, never mutated.
- Locate support for a transaction: connector attachments first (QBO Attachables), then email
  (forwarded documents; with Gmail connected, documents already synced, then a scoped Gmail search), then
  uploaded documents (vendor + total + date
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
(`materials.line.matched`, `materials.price.changed`, ...). Connectors may declare their own too
(`webhook.received`, §6.6), listed for every client. The builder's trigger picker lists the event
types available to the tenant (platform + connectors + enabled packs), each with a sample payload.

---

## 9. Tools, skills and agents

### 9.1 Agent bundle (stored in `agent_version.bundle`)

One version is the **whole agent**: its definition, its workflows and its settings. Editing anything
(instructions, a skill setting, one step in the builder) makes a new version of the bundle. This keeps a
client agent's history linear and makes template updates one merge, not one per workflow.

```ts
const AgentBundle = z.object({
  schemaVersion: z.literal(1),
  definition: AgentDefinition,
  workflows: z.array(z.object({
    slug: z.string(), name: z.string(), enabled: z.boolean().default(true),
    workflow: Workflow,                            // §10.1
  })),
});

const AgentDefinition = z.object({
  schemaVersion: z.literal(2),
  identity: z.object({ name: z.string(), role: z.string(), mission: z.string(), avatar: z.string().optional() }),
  kind: z.enum(['functional', 'platform']),
  model: z.object({ id: z.string(), maxTokens: z.number().default(4096) }),
  instructions: z.string(),                       // plain language; how this agent works
  skills: z.array(z.object({
    skill: z.string(),                            // 'materials.match-lines' | 'custom:<slug>' [@version]
    settings: z.record(z.unknown()).default({}),  // overrides the skill's settings defaults
  })),
  extraTools: z.array(z.string()).default([]),    // tools beyond those its skills bring
  canCommand: z.array(z.string()).default([]),    // agent slugs it may ask (same client)
  permissions: z.object({
    mode: z.enum(['suggest_only', 'act']).default('suggest_only'),   // suggest_only: every write waits
    approver: z.string().optional(),              // default approver for this agent's steps (role or user)
  }),
  budgets: z.object({ maxSteps: z.number().default(12), maxCostUsd: z.number().default(0.5) }),
  memory: z.object({ enabled: z.boolean().default(true) }),
});
```

Every item a merge must line up carries a **stable id** that survives forking and editing: workflows
by `slug`, steps and fork paths by `id` (generated once, copied on fork, never reused), skills by `skill`.

An agent's **commands** are its skills: anything that can be a workflow step can be invoked in a
thread as `/skill-slug args` or by another agent of the same client.

### 9.2 Skill definition

```ts
const SkillDefinition = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),                                 // 'docs.extract', 'materials.match-lines', 'custom:<slug>'
  name: z.string(), description: z.string(), category: z.string(),
  mode: z.enum(['tool', 'agent']),                // 'tool' = deterministic handler; 'agent' = reasoning loop
  handler: z.string().optional(),                 // tool id when mode = 'tool' (built-ins only)
  instructions: z.string().optional(),            // added to the agent's prompt when mode = 'agent'
  tools: z.array(z.string()),                     // tools the agent may use while running this skill
  input: JsonSchema, output: JsonSchema,          // typed; the builder makes forms from these
  settings: z.array(z.object({                    // e.g. match_confidence_auto: 0.9, price_change_pct: 5
    key: z.string(), label: z.string(), type: z.enum(['number', 'boolean', 'string', 'enum']),
    default: z.unknown(), options: z.array(z.string()).optional(),
    clientSpecific: z.boolean().default(false),   // e.g. a vendor list: never promoted into a template
  })).default([]),
  requiresConnectors: z.array(z.string()).default([]),
  requiresPacks: z.array(z.string()).default([]),
  producesAlerts: z.boolean().default(false),     // outputs must carry `sources`
});
```

- **Built-in skills** are code: platform skills (`docs.find-support`, `docs.extract`, `threads.summarize`,
  `inbox.ask`) and pack skills (`materials.*`). Their version is the package version.
- **Operator-written skills** are created in the back office's Skills library, shared or for one client: name, description, instructions, a selection of
  existing tools, input and output fields (a form that produces the JSON Schema), settings. Always mode
  `agent`. Saved as `skill_version` rows with the same draft → publish → rollback rules as agents.
- A client agent can use a skill only when the client has the required connections bound and packs
  enabled. Forking a template into a client shows what's missing there.

### 9.3 Versioning, templates and client agents

The heart of the managed service. Agents are effectively built per client; templates are how work is
reused.

**Versions** (templates and client agents alike)
- Every edit inserts a new `agent_version` (status `draft`) with `parent_version_id` = the version it was
  edited from. Publishing sets it `live` and updates `live_version_id`, in one transaction.
- Rollback = publish an older version by copying it as a new version, so history stays linear.
- `bundle_hash` = sha256 of canonical JSON; no-op edits are rejected.
- Version history shows, for each version: who, when, change note, and a diff against its parent
  (fields as sentences; workflows as a step-by-step diff).

**Templates**
- `kind='template'`, `tenant_id` null. Created from scratch, by the Builder, or installed by a pack. Never
  run for a client directly; test-run against the sandbox client or (in test mode) a client's data.
- Each published template version carries a `release_note` that clients' update reviews show.

**Forking**
- Forking template version *T* into client *C* creates a client agent (`kind='client'`, `tenant_id = C`,
  `template_id`) whose v1 is a copy of *T*'s bundle with `based_on_template_version_id = T`. Step and
  path ids are copied, so later merges can line them up.
- A client agent can also be created from scratch for one client (no template), or forked from another
  client's agent (copied, re-bound to the new client's connections; memory and learned data never come).

**Customizing**
- The operator edits the client agent in the same editor and builder as templates: settings for this
  client's data, instructions, skills, workflows added, removed or rewired. Each edit is a new version of
  the client agent; `based_on_template_version_id` is unchanged.
- **Customizations view:** the diff between the client agent's live version and its base template
  version, so the operator always sees what was changed for this client.

**Template updates (three-way merge)**
- When template *T* publishes a newer version *T′*, each linked client agent based on an older version
  shows "update available" with *T′*'s release note.
- Applying it merges structurally: base = the client's base template version, theirs = *T′*, ours = the
  client's live version. Agent fields merge by key; skills by `skill`; workflows by `slug`; steps and
  fork paths by `id`, step config by field; the order of each step list merges as a sequence (inserts
  kept next to their neighbours; two different reorders of the same list, or a step moved to different
  places, conflict). A change on one side only is taken; the same change on both
  is taken once; different changes to the same field, or a delete against an edit, are **conflicts**.
- The result is a draft client version with `author_type='merge'`, `based_on_template_version_id = T′`
  and `merged_from_version_ids`. Conflicts are resolved in the merge view (§10.5) before it can be saved
  as valid; workflow validation (§10.2) runs on the merged result. Then test-run and publish as usual.
- Updates are never applied automatically in v1. The template page shows every client agent: base
  version, versions behind, number of customizations, open conflicts.

**Promoting**
- From a client agent, the operator can promote its customizations (all, or selected changes) into a new
  **template draft**: a three-way merge the other way (base = the client's base template version, ours =
  the template's live version, theirs = the client version). Client-specific values (bindings, ids of the
  client's records) are left out; settings are offered, not assumed.

**Detaching**
- A client agent can be detached (`linked=false`): it keeps its history but no longer receives template
  updates. Re-linking picks a template version as the new base.

**Runs and evidence**
- A run records the client agent, the exact version it ran and a snapshot of bindings and approver.
- Every `step_run`, `message`, `doc_extraction`, `external_action` and pack decision made by an agent
  records `agent_version_id`.
- Skills are referenced by id (live version) or `id@version` (pinned) inside a bundle.
- **The runtime never reads agent, skill or workflow settings from code.** Pack templates are inserted as
  template v1 rows when the pack is installed.

### 9.4 Tool registry

Each tool: `{ id, description, input: Zod, output: Zod, sideEffect: 'none'|'internal'|'external',
verb: 'read'|'create'|'update'|'delete', source: 'platform'|'<connector>'|'<pack>', summary?: Template,
handler }`. Agents touch data only through tools. In the builder, `external` tools are **actions**
("change your tools").

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
runAgent({ tenantId, agentVersionId, skill | task, input, threadId?, runContext }): Promise<AgentResult>
```
1. Load the client agent's version (the run's pinned bundle) and resolve the skill to its version, with
   the bundle's settings for it. `agents.ask` resolves other agents among the same client's agents.
   Validate input.
2. If the skill's mode is `tool`: call the handler directly, log, return.
3. Else build the prompt: platform preamble (cite sources, use tools, never invent numbers) + agent
   `instructions` + the skill's `instructions` + the client agent's memory notes + task input. Expose only the skill's tools
   (and `extraTools`), `ask_agent` if `canCommand` is non-empty, and `finish(result)` typed to the skill
   output.
4. Loop: model call → tool calls → results, until `finish` or budget hit. Enforce `maxSteps` and
   `maxCostUsd`. On budget hit: return `{status:'escalated'}` and create an inbox item.
5. **Permission gate** per tool call. Reads (`none`) run if the connection's `read` isn't `off`.
   Internal writes (`internal`: the platform's own records, e.g. a price observation or an inbox item)
   run and are logged; they don't touch the client's systems. **Writes to a client's tool**
   (`external`) **need approval by default.** One runs without approval only when all three say so: the
   connection's matrix has `auto` for the verb, the step is set to `approval: 'not_required'`, and the
   agent's mode is `act`. Otherwise: matrix `off` → refused (and caught at publish); anything else → an
   `external_action` (status `proposed`) plus an `inbox_item(kind='external_action')` for the step's
   approver, showing now / after this change; the step waits for `inbox.resolved`, and on approval the
   action executes once by idempotency key, with its before state. Automatic writes record the same
   action and before state. Test runs (§10.4) never execute external actions.
6. Log `step_run`, `tool_call`, tokens, cost. Outputs of skills with `producesAlerts` must include
   `sources`; outputs without them are rejected.

### 9.6 Builder

- `draft-agent(input: { description, clientId? })` → `{ bundle: AgentBundle, summary, gaps: string[] }`:
  a new template, or (with `clientId`) a new client agent drafted for that client.
- The Builder receives the tool and skill registries (ids, descriptions, side effects, input/output
  schemas), the connectors and packs available (and, for a client, what that client has connected and
  enabled), event types, the existing templates (so it can say "start from template X" instead of
  drafting from nothing), and the JSON Schemas of `AgentBundle`. It may only select existing skills and
  tools; anything that needs a missing capability goes in `gaps` (e.g. "no card feed connector").
- `revise-agent({ agentId, fromVersionId, instruction })` → a new bundle draft + a human-readable diff.
  Works the same on templates and client agents (e.g. "for this client, skip the approval for invoices
  under $200").
- Server guards: Zod validation, workflow validation (§10.2), `permissions.mode='suggest_only'` for new
  agents, every write step left at `approval: 'required'`, saved as `draft`. The operator adjusts, tests
  and publishes.
- A client's request can be handed to the Builder as the instruction for that client's agent.

### 9.7 Platform agents (templates kind `platform`, seeded as v1 rows)

| slug | kind | skills |
| --- | --- | --- |
| `document-clerk` | platform | `docs.find-support`, `docs.extract` (forked into each client automatically when a client agent needs it) |
| `coordinator` | platform | `route-ask`, `review` (multi-agent review: collect views, write one summary with disagreements) |
| `builder` | platform | `draft-agent`, `revise-agent` (back office only; runs outside any client) |

---

## 10. Workflows

### 10.1 Workflow definition (one per workflow in an agent bundle, §9.1)

A workflow is a **structured list of steps** (owner's design): one trigger, then steps that run top to
bottom. A **fork** has ordered paths; the first path whose rules match runs, else "otherwise"; then the
workflow continues after the fork ("paths join here"). Steps can be nested inside fork paths and
`for_each` blocks. There are no free-form edges.

```ts
const Workflow = z.object({
  schemaVersion: z.literal(3),
  trigger: z.object({ id: z.string(), on:
    z.object({ type: z.literal('event'), event: z.string(), filter: Rules.optional() })
    .or(z.object({ type: z.literal('schedule'), cron: z.string(), tz: z.string().optional() /*client tz*/ }))
    .or(z.object({ type: z.literal('manual'), input: JsonSchema }))
    .or(z.object({ type: z.literal('command'), command: z.string() })) }),
  steps: z.array(Step),
});

Step = { id, kind, name, client?: { visible: boolean, label?: string }, ...config } where kind ∈
  'skill'     { skill: 'id[@v]', agent?: 'slug' /*default: owner*/, input: Template, settings?,
                approval?: Approval /*only if the skill's tools can write to a client tool*/ }
  'action'    { tool: 'id', input: Template, approval: Approval }   // changes a client tool; §9.5

Approval = { required: 'required' | 'not_required' = 'required', approver?: role | userId,
             timeout?: Duration, onReject: 'stop' | 'continue' = 'stop' }
  'person'    { mode: 'approve'|'ask', assignee: role | userId, title: Template, payload: Template,
                timeout: Duration, remindEvery?: Duration, channel?: 'inbox'|'email',
                onReject?: 'stop'|'continue', onTimeout: 'stop'|'continue'|'notify_operator' }
  'fork'      { paths: [{ id, name, when: Rules, steps: Step[] }], otherwise: { id, steps: Step[] } }
  'for_each'  { over: Template /*array*/, concurrency: number, steps: Step[] }
  'wait'      { for: Duration }
  'notify'    { channel: 'thread'|'email'|'digest', to?: Template, message: Template }
  'stop'      { status: 'succeeded'|'failed'|'cancelled' }

Rules = { match: 'all'|'any', rules: [{ field: Template, op: '>'|'>='|'<'|'<='|'='|'!='|'contains'|'in'|'is'|'exists',
                                         value: unknown }] }
```

Templates reference `{{trigger.<path>}}` and `{{steps.<id>.output.<path>}}`; inside a `for_each`,
`{{item}}` and `{{index}}`. Rules are what the builder shows ("Price change > 15% or Monthly impact >
$500"); they compile to JSONLogic, never `eval`. A `person` step's output carries `approved` and the
answer, so a later fork can branch on it. **Approvals are per step:** every step that can change a
client's tool carries an `approval` setting, `required` unless the operator changes it; the approver
defaults to the step's, then the agent's, then the client's setting. A `person` step adds a human
checkpoint anywhere else. `client` controls the portal's run timeline: by default
skill, action, person and notify steps are shown (with `label`, or the step name), and forks, loops and
waits are hidden.

### 10.2 Validation (shared by builder and server, in `packages/core`)

A workflow can be saved as a draft with errors, but only a valid one can be test-run or published.
- One trigger; step and path ids unique across the bundle; every fork has at least one path; a
  `for_each` has at least one step.
- A template may reference only the trigger and steps that run **before** it on its own path. Outputs of
  steps inside a fork path or a `for_each` are not visible after it; a fork exposes which path ran.
- Every `skill` step's input satisfies the skill's input schema (typed from upstream outputs and the
  trigger payload); every skill and tool exists and is allowed by the owning agent (its skills plus
  `extraTools`).
- A step set to `approval: 'not_required'` must be one that writes to a client tool. For a client agent,
  at publish: no action's verb is `off` on the bound connection, and a step set to `not_required` whose
  connection only allows `approval` is an error ("this connection requires approval for updates"). The
  builder marks which write steps will run automatically and which need approval.
Errors carry the step id and field, so the builder can mark the step and the inspector field.

### 10.3 Executor

- One Cloudflare Workflow class, `RunWorkflow`, executes any workflow. Runs belong to a client agent:
  triggers start instances for the enabled workflows in the **live version of active** client agents:
  the senses router for `event` triggers (a client's event starts only that client's agents), a Worker
  cron for `schedule` triggers (each `cron` in the client's timezone unless overridden), the API for
  `manual` and `command` triggers. The instance id is the `run` id, so starting the same run twice is
  refused.
- The instance loads the client agent's pinned version and bindings and runs the steps in order, each
  with `step.do(stepId, ...)` so it is durable and retried. A fork evaluates its paths in order and runs
  the first match (or otherwise). Step outputs stay small (record ids); large data lives in Postgres.
- `person` steps and actions that need approval create an inbox item, then `step.waitForEvent` with a
  type unique to that item and the step's timeout. Resolving the item (`POST /api/inbox/:id/resolve`)
  sends that event to the run's instance.
- `for_each` runs its steps once per item, with bounded concurrency, step names `${stepId}:${index}:${childId}`.
- Every step writes a `step_run`. Run status and cost roll up to `run`.

### 10.4 Test runs

The operator test-runs any version, template or client agent, draft or live: a client agent against its
own client's data, a template against the **sandbox client** or (in test mode) against a chosen client's
data, choosing a trigger payload (a sample event, a recent real record, or manual input). A test run is
a normal run with `mode='test'`: it reads real data, writes its own steps and outputs, but **never
executes external actions** (they are recorded as proposed and shown as "would have done"), does not
emit events that start other workflows, and is hidden from the client portal. Internal writes made by
test runs are tagged with the run. A client agent can't be activated, and an update merge can't be
published, without one passing test run on that client.

### 10.5 The workflow builder, run view and merge view (back office)

Routes `/ops/templates/[slug]/workflows/[workflow]` and `/ops/clients/[id]/agents/[slug]/workflows/[workflow]` (one builder for
templates and client agents), following the owner's design (`docs/design/screens/5-workflow-builder.png`).
Operator only; clients never see it.
- **Header**: agent name, version badge (`DRAFT · V1`, `LIVE · V4`), counts ("10 steps · 2 forks · 4
  change your tools · 2 need approval"), Test run, Publish; tabs Overview / Workflow / Runs / Versions /
  Settings.
- **Add a step** (left): search; triggers; skills (the agent's skills first, then the library); actions
  grouped by tool ("change your tools"); people (approve, ask); logic (fork, for each, wait, notify,
  stop). Drag into the list or into a fork path, or press + to add at the end.
- **Steps** (centre): numbered cards with kind tag, name and tools; drag by the handle to reorder or move
  between fork paths; forks show their paths side by side with "Drop a step here" and "paths join here";
  badges for invalid, needs approval, runs automatically, hidden from client, and **customized for this
  client** (against the template).
- **Inspector** (right): the selected step's form, generated from the skill or tool input schema;
  template fields offer a picker of upstream outputs valid at this step; for steps that change a tool,
  an **Approval** control (on by default; switching it off is only offered where the client's connection
  allows it) with the approver; fork paths as ordered rule
  rows ("+ Add condition", "+ Add path", remove fork); settings with defaults (and, on a client agent,
  the template's value beside a customized one); the step's client timeline label and visibility.
- **Versions**: history with change notes and a step-by-step diff; rollback; on templates "Used by"
  (client agents, base versions, customizations); on client agents "Based on template vN" with "Update
  available", "Compare with template" and "Promote to template".
- **Merge view** (template update or promotion): the step list with each step marked added / removed /
  changed / moved per side; conflicts listed and marked, each resolved as ours, theirs, or edit; agent
  fields and settings side by side. Save produces the merge draft once every conflict is resolved and
  the merged workflow validates.
- **Run view** (`docs/design/screens/6-run.png`): "What it did" as a checklist of steps with status,
  summary, cost and links; "Changes to your tools" as now / after this change for each action, with
  approve, reject or edit where it waits; a link to the full log (inputs, outputs, tool calls). Live
  runs poll.

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
  is resolved by linking the client agent or template versions made for it).
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
  templates: z.object({ agents: z.array(AgentDefinition), workflows: z.array(Workflow) }),
  screens: z.array(z.object({ route: z.string(), title: z.string(), roles: z.array(z.string()) })),
});
```
A pack is a package exporting its manifest, tool handlers, Drizzle schema and API routes. `apps/api`
registers it; `apps/web` has its screens under `src/packs/<id>/`: client reports in the portal, and
operator views in the back office. Installing a pack adds its templates (agents with their workflows) once,
as template v1 rows the operator edits like any other. Enabling it for a client inserts `tenant_pack`
(its tables start holding that client's data) and allows forking its templates into that client.

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

Skills: `materials.match-lines` (tool mode, over a document's lines; settings `match_confidence_auto` 0.90),
`materials.review-merge`, `materials.record-prices` (tool mode), `materials.price-check` (agent mode;
settings `price_change_pct` 5, `vendor_spread_pct`, `creep_pct`; produces alerts),
`materials.vendor-compare`, `materials.materials-list`, `materials.weekly-digest`.

Events: `materials.line.matched`, `materials.line.needs_review`, `materials.match.decided`,
`materials.price.observed`, `materials.price.changed`.

Reports (portal): Price watch (`/reports/materials/prices`), Catalog (`/reports/materials/catalog`),
with CSV export. Match review in the Inbox (`review` kind). Back office: the same views for any client,
plus catalog merge.

Template **Pia** (`purchasing`, functional; default portal service name "Material cost monitoring"): skills `docs.find-support`, `docs.extract`,
`materials.match-lines`, `materials.record-prices`, `materials.price-check`, `materials.vendor-compare`,
`materials.weekly-digest`; extra tools `qbo.attachable.upload`, `gmail.draft.create`, `gmail.label.apply`
(all approval).

Template workflows (step lists in Pia's bundle; each client's fork can change them):

**purchase-intake** (trigger: event `transaction.created`)
1. skill `docs.find-support` (QBO attachments, then forwarded email and uploads; Gmail once connected)
2. fork "No document": person ask (client admin: forward or upload the invoice; remind 2d; timeout 5d →
   notify the operator) and action `gmail.draft.create` to the purchaser when Gmail is connected
3. skill `docs.extract`
4. fork "Totals don't add up": person approve (extraction review)
5. skill `materials.match-lines` (auto-match ≥ `match_confidence_auto`)
6. fork "Any line below threshold": person ask (match review for those lines)
7. skill `materials.record-prices`
8. skill `materials.price-check` (raise alerts with evidence)
9. action `qbo.bill.update_lines` / `qbo.purchase.update_lines` (itemize; approval on)
10. fork "Document not yet attached in QBO": action `qbo.attachable.upload` (approval on)
11. fork "Document from Gmail" (after the MVP): action `gmail.label.apply` "Processed"

**weekly-price-review** (trigger: schedule Mondays 7:00 client timezone)
1. skill `materials.weekly-digest` (changes, creep, vendor spread, new surcharges, dollar impact)
2. person approve (the operator reviews the digest)
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
  failures and retries); runs roll up cost; `usage_daily` rolls up per client and client agent, and the
  back office can also roll up per template (across its forks).
- **Cost is operator-only.** The back office shows model cost and usage per client, per client agent and
  per template over time, to price the service; the portal shows activity and outcomes, never cost.
- Budgets: per agent version (`maxSteps`, `maxCostUsd` per skill invocation) and per thread
  (`step_budget`). Hitting one escalates to the operator inbox rather than failing silently.
- Every run, step, tool call and external action is queryable from the back office run view; nothing an
  agent did is visible only in logs.

---

## 14. API (Hono routes under `/api`)

Two route families. `/api/ops/*` is the back office (role `operator`, scoped to the clients they serve,
`app.operator` on). `/api/*` is the portal (client roles, one client). The OAuth callbacks, the QBO
webhook are shared.

```
Back office (operator)
  Clients      GET  /api/ops/overview                     (needs attention across clients)
               GET  /api/ops/clients                      POST /api/ops/clients
               GET  /api/ops/clients/:id                  PATCH /api/ops/clients/:id/settings
               POST /api/ops/clients/:id/invites          PUT  /api/ops/clients/:id/connectors {offered: [...]}
               POST /api/ops/clients/:id/connectors/:connector/remind   (email: "connect X" → portal page)
               POST /api/ops/clients/:id/packs/:pack/enable
  Connections  GET  /api/ops/clients/:id/connections      PATCH /api/ops/connections/:id {config, permissions}
               POST /api/ops/connections/:id/sync
  Skills       GET/POST /api/ops/skills                   POST /api/ops/skills/:id/versions
               POST /api/ops/skills/:id/versions/:vid/publish
  Agents       (templates: GET/POST /api/ops/templates; client agents: GET/POST /api/ops/clients/:id/agents;
                both then addressed as /api/ops/agents/:id)
               POST /api/ops/agents/draft {description, clientId?}
               GET  /api/ops/agents/:id (+ versions, lineage)   POST /api/ops/agents/:id/versions (save draft)
               POST /api/ops/agents/:id/versions/:vid/publish   POST /api/ops/agents/:id/rollback {versionId}
               POST /api/ops/agents/:id/revise {instruction, fromVersionId}
               POST /api/ops/workflows/validate {workflow}   GET  /api/ops/catalog/events
               POST /api/ops/agents/:id/versions/:vid/test-run {workflow, payload, clientId?}
  Lineage      POST /api/ops/templates/:id/fork {clientId, version?, slug?}
               GET  /api/ops/templates/:id/used-by        (client agents, base versions, behind, customizations)
               GET  /api/ops/agents/:id/customizations    (diff: live vs base template version)
               GET  /api/ops/agents/:id/update-preview {toVersion}   (three-way merge result + conflicts)
               POST /api/ops/agents/:id/update {toVersion, resolutions}  (creates the merge draft)
               POST /api/ops/agents/:id/promote {changes?, resolutions}  (creates a template draft)
               POST /api/ops/agents/:id/detach            POST /api/ops/agents/:id/relink {templateVersion}
  Operation    PATCH /api/ops/agents/:id/operation {bindings?, approver?, serviceName?, serviceDescription?}
               POST /api/ops/agents/:id/activate|pause|retire
               POST /api/ops/agents/:id/run {workflow, input}   (manual trigger)
  Runs         GET  /api/ops/runs?client=&status=&agent=  GET  /api/ops/runs/:id (steps, tool calls, cost)
  Inbox        GET  /api/ops/inbox                        POST /api/ops/inbox/:id/resolve
  Requests     GET  /api/ops/requests                     POST /api/ops/requests/:id/resolve {links}
  Usage        GET  /api/ops/usage?client=&agent=&template=&from=&to=

Portal (client)
  Overview     GET  /api/overview                         GET  /api/services (active client agents as services)
  Reports      GET  /api/reports/activity?from=&to=       GET  /api/reports/:pack/:report (+ .csv)
  Runs         GET  /api/runs?service=&status=            GET  /api/runs/:id (client timeline)
  Inbox        GET  /api/inbox?kind=&status=              POST /api/inbox/:id/resolve
  Connections  GET  /api/connections (offered connectors, status, permissions, used by, forwarding address)
               PUT  /api/connections/upload/senders {allowed: [...]}   (who may forward)
               POST /api/connections/:connector/authorize (client admin signs in)   DELETE /api/connections/:id
               PATCH /api/connections/:id/permissions (tighten only)
  Documents    POST /api/uploads (multipart)              GET  /api/documents/:id (signed URL)
  Requests     GET/POST /api/requests {subject?, text}
  Settings     GET/POST /api/users (invite)               PATCH /api/settings/notifications

Shared         GET  /api/connections/qbo/callback         GET  /api/connections/gmail/callback
               POST /api/webhooks/qbo
```
All bodies validated with Zod. The route contract declares each route's roles; middleware sets
`app.tenant_ids` (and `app.operator` for operator sessions) from the session (§4). No portal route
returns an agent bundle, instructions, prompts, model output outside `summary`, or cost; a contract test
enforces both.

---

## 15. Screens → routes

**Back office** (`/ops`, role `operator`)

| Screen | Route |
| --- | --- |
| Overview: needs attention across clients (failed runs, operator inbox, requests, connections to fix, template updates waiting), usage this month | `/ops` |
| Clients: list with health; new client (onboarding) | `/ops/clients`, `/ops/clients/new` |
| Client: agents (status, based on, customizations, update available), connectors offered and their health, permissions and configuration (incl. Gmail query), users, packs, settings, runs, usage | `/ops/clients/[id]` |
| Client agent: editor, versions, customizations vs template, update/merge, promote, bindings, approver, test runs, activate/pause | `/ops/clients/[id]/agents/[slug]` |
| Client agent workflow builder | `/ops/clients/[id]/agents/[slug]/workflows/[workflow]` |
| Templates: list; new (scratch or Builder); editor, versions with release notes, "Used by" | `/ops/templates`, `/ops/templates/new`, `/ops/templates/[slug]` |
| Template workflow builder | `/ops/templates/[slug]/workflows/[workflow]` |
| Merge view (update or promotion) | `/ops/agents/[id]/merge?from=&to=` |
| Skills library | `/ops/skills`, `/ops/skills/[id]` |
| Packs | `/ops/packs` |
| Runs across clients; run view | `/ops/runs`, `/ops/runs/[id]` |
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
| Connections (owner's design, screen 2): offered tools, sign in, reconnect, disconnect; what agents may do in each tool (view; tighten only); used by | `/connections` | client_admin (sign in, change), client_user (view) |
| Requests: ask the operator | `/requests` | all |
| Settings: users, notifications | `/settings` | client_admin |

Match review (Materials, in the Inbox): invoice line with page thumbnail, parsed attributes, top
candidates side by side with attribute diffs highlighted; actions Match / New item / Skip.

---

## 16. Security and audit

- Secrets in env; signed URLs for documents (5 min).
- **Access (v0.10, §6.9, §6.10):** connection secrets (OAuth tokens, API keys, browser logins and
  sessions) are encrypted with the client's own data key, itself wrapped by `ENCRYPTION_KEY`; each
  ciphertext is bound to its client and connection. Secrets are write-only; the operator never sees
  them; agents never hold them (tool code gets them for one step; the model sees only tool results).
  Agents reach only the connections bound to them, within their grants. Second factors live in the
  separate code service and are handed out once, to a login in progress. Browser sign-in is done by
  code on pinned login origins, on sites the operator allows by risk tier; banks, payments, email
  accounts and identity providers are never signed in to by an agent.
- RLS on every tenant table, keyed on `app.tenant_ids` (§4). Workflows, cron and the senses dispatcher
  run with no request session and set exactly one client id. Operator sessions get only the clients
  they serve.
- **Client isolation of what agents learn:** memory notes, aliases, catalogs and every other learned
  record are per client; nothing a client agent learns is used for another client or a template.
- **The operator's work stays the operator's:** agent bundles (templates and client agents),
  instructions, prompts and costs are never returned to client roles (contract test, §14).
- Forking or promoting never carries a client's memory, aliases, records or connection ids into a
  template or another client.
- **Writes to connected systems:** only through `external` tools; every one is an `external_action`,
  executed once (idempotency key), with prior state and result recorded. **Approval is on by default for
  every write step**; a step runs without approval only if the operator set it so and the client's
  connection allows it; delete is off. Only the operator loosens a matrix or a step; the client can
  tighten its matrix at any time, which overrides steps at once. Every change is logged. Agents, the
  Builder and custom skills cannot change permissions or approvals.
- Immutable `agent_version`, `skill_version`, `raw_record`, `doc_extraction` (trigger
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
ENCRYPTION_KEY                         # 32 bytes base64; wraps each client's data key (§6.9)
BROWSER (Browser Run binding), CODES (service binding → apps/mfa)   # v0.10
AGENT_EMAIL_DOMAIN                     # e.g. agents.<domain>, routed to apps/mfa by Email Routing
# apps/mfa only: MFA_ENCRYPTION_KEY (32 bytes base64), MFA_TWILIO_ACCOUNT_SID, MFA_TWILIO_AUTH_TOKEN,
#   IDENTITY and DIRECTORY (Durable Object bindings), AGENT_EMAIL_DOMAIN, MFA_ORIGIN, MFA_DAILY_CAP
QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI, QBO_ENV=sandbox|production, QBO_WEBHOOK_VERIFIER
EMAIL_FORWARDING_DOMAIN                # e.g. in.<domain>, routed to the Worker by Cloudflare Email Routing
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI   # after the MVP (Gmail)
WORKOS_CLIENT_ID, WORKOS_API_KEY, WORKOS_COOKIE_PASSWORD
RESEND_API_KEY (optional)
```

---

## 18. Build plan (ordered; each milestone ends green)

Platform first; the Materials template, forked and customized for the millwork shop, proves it.

| # | Milestone | Done when |
| --- | --- | --- |
| M0 | Monorepo, Vite app + Hono Worker, Drizzle, Postgres + pgvector, Cloudflare Workflows, WorkOS auth with a seeded operator and one client | `pnpm dev` runs the Worker (API + Workflows) and the app; the operator and a client user can sign in |
| M1 | Platform schema (§5): skills, templates and client agents with bundle versions and lineage, runs, inbox, usage; RLS on `app.tenant_ids` + `app.operator`; immutability triggers; core Zod schemas (bundle, workflow, …), workflow validation, **bundle diff and three-way merge**; seed (operator, sandbox client, platform templates) | Migrations apply; RLS holds for client and operator sessions; validation and merge unit tests pass |
| M2 | Connector framework, upload connector with email forwarding, documents capability (store, extract, validate) | Upload 3 fixture invoices → extractions match expected JSON within tolerance |
| M3 | Tool + skill registries, agent runtime on client agent versions, permission gate, external actions, run/step/tool logging, usage rollup | A client agent in the sandbox client runs `docs.extract` end to end and logs cost; an external tool call creates an approval and executes once when approved |
| M4 | Workflow executor, triggers per client agent (event, schedule in client timezone, manual, command), senses outbox, test runs | A workflow with a fork, a for_each and an approval runs to the end for one client's agent and never starts for another client; a test run proposes but never executes external actions |
| M5 | Back office shell (overview, clients, onboarding, offering connectors, operator inbox, requests queue); client portal shell (overview, inbox, **connections**, requests, settings); inbox resolution resumes runs | The operator creates a client, offers it the upload connector and invites its admin; the admin signs in to the portal, sees the offered connectors, approves an item that resumes a run, and raises a request the operator sees |
| M6 | Templates and client agents: editor, skills, Builder; fork, customize, versions and rollback, customizations view, bindings and activation; template updates (preview, conflicts, merge draft) and promotion; "Used by" | The operator builds a template, forks it into two clients, customizes each differently, publishes template v2, and merges it into both (one clean, one with a resolved conflict) while keeping each client's customizations; promotes one client's change into template v3; rolls one client back |
| M7 | Workflow builder (templates and client agents): steps, forks, drag and drop, inspector, validation; merge view; run view; client run timeline | The operator customizes a client's workflow in the builder (adds a step, adds a fork path), test-runs it on that client's data, resolves a conflict from a template update in the merge view, publishes; watches the live run in the run view while the client sees the timeline without internals or cost |
| M8 | Materials pack: tables, matching (golden tests), pricing and alert rules, the Pia template forked and customized for the millwork client; client reports (activity, Price watch, Catalog, CSV) | Golden tests ≥ 95% precision; Baltic birch matches across 3 vendors; an uploaded invoice runs the millwork shop's purchase-intake to priced lines with a `price_jump` alert; the client sees it in Price watch |
| M9 | QBO connector: OAuth, sync, CDC, attachables, webhooks, read tools, the MVP write tools (itemize lines, attach invoice) with per-step approval | Sandbox company syncs; a Bill flows through intake; approving in the portal itemizes its lines (total unchanged) and attaches the invoice in the sandbox; **MVP done** when the same works on the shop's production QuickBooks |
| M10 | (after the MVP) Gmail connector: OAuth, scoped sync (query + history), attachments as documents, read tools, draft and label tools behind approval; Gmail step in `docs.find-support` | A test mailbox connects; an emailed invoice is found for its QBO transaction and flows through intake; an approved `gmail.draft.create` appears in the mailbox's drafts |
| M11 | Usage and cost views (per client, agent, template), activity report, notification emails, polish, Playwright e2e | e2e: the operator forks Pia into a new client and customizes her, the client connects and uploads an invoice, approves in the portal, sees the report; the operator publishes a Pia template update and merges it into that client |
| M12 | Access (v0.10): client data keys and write-only secrets; grants per binding and the portal's Access page; the code service (`apps/mfa`); browser connections with the site catalogue and risk tiers, sign-in by code, read and download tools | An agent with a read-only grant signs in to a low-tier fixture site as its agent account, with a code from the code service, downloads an invoice as a document and signs out; the model never sees the password or the code; a second agent without the binding cannot reach the site |

**MVP** (§1): M0–M4 in full; M5 without client requests; M6 without the Builder, operator-written skills, template updates and
promotion; M7 without the merge view; M8; M9 with the two MVP write tools; plus email forwarding (§6.5)
in M2. Gmail (M10), the deferred parts and M11's extras follow (`docs/plan.md` §3).

---

## 19. Testing

- Unit: workflow validation (every rule, with step/field error locations), template typing, rule
  compilation to JSONLogic, normalizer,
  attribute parsers, UOM conversion, alert rules, Zod schemas, version immutability, permission gate.
- Layering: platform packages never import packs (`scripts/check-deps.mjs`).
- Golden: extraction fixtures (`fixtures/invoices/*.pdf` + `*.expected.json`), matching pairs.
- Executor: a fake `StepRunner` for every step kind, fork path order and for_each; one Workers-pool test drives the real
  Workflow class through a wait, a resume and a timeout.
- LLM calls behind `packages/llm` with a record/replay mode so tests run offline.
- Builder: component tests for add, drag to reorder, move between fork paths, delete, undo, and
  validation markers; Playwright e2e (M11).
- Permissions: every verb × connection setting × agent setting gives the right outcome; `off` is caught
  at publish; automatic writes still record before state; tightening by a client takes effect at once.
- Isolation: RLS for single-client and operator sessions; portal routes never return agent bundles,
  prompts or cost (contract test); a client agent's memory never reaches another client or a template.
- Lineage: bundle diff and three-way merge golden cases (change on one side; same change both sides;
  conflicting field; delete vs edit; workflow added on both sides; step moved within and between fork
  paths; two different reorders); merges keep step ids; promotion strips client-specific values; fork → customize → update → rollback round trips.

---

## 20. Decisions and open items

Decided:
- Auth: WorkOS (v0.2). Hosting: Cloudflare Workers + Neon + R2 (v0.2).
- Document requests are inbox-first, routed to a client admin (`docs/plan.md` §1.1).
- Embeddings: optional; trigram + attributes is enough for v1.
- Writes to client systems: governed by each connection's permission matrix, conservative by default
  (v0.7, replacing "always approved" from v0.3); approvals go to the client admin by default, or the
  operator when delegated (v0.4).
- Workflows are structured step lists with forks, edited in a sortable list builder (v0.7).
- Approvals are on by default and set per step; the connection matrix is the ceiling (v0.8).
- MVP: Pia live for the millwork shop on its own QuickBooks, with upload and email forwarding (v0.8).
- First QuickBooks writes: itemize a bill's or purchase's lines (total unchanged) and attach the
  invoice (v0.8).
- Slack later, not in v1 (owner, v0.8).
- v1 connectors: QuickBooks Online, Gmail, upload (v0.4).
- Managed-agents service: the operator builds and runs agents from a back office; clients get a portal
  for reports, runs, approvals, connections and requests (v0.5).
- Cost is operator-only; clients see activity and outcomes (v0.5).
- Templates and client agents: reusable agents are templates; each client gets its own fork, customized
  and versioned per client, linked to its template version; updates are reviewed three-way merges;
  promotion moves client changes back (v0.6).
- One version = the whole agent bundle (definition + workflows + settings) (v0.6).
- Access: a vault per client with its own key, grants per agent binding, a separate code service for
  second factors, and browser logins as dedicated agent accounts on operator-allowed sites by risk tier
  (v0.10, §6.9, §6.10).

Open:
- Gmail and Google's app verification: Gmail read scopes are restricted, so a public app needs Google's
  verification and a security assessment; an unverified app shows a warning and has a user cap, and in
  "testing" status its refresh tokens expire after 7 days. Check the current rules at M10 and choose:
  verify the app, or (for Google Workspace clients) domain-wide delegation granted by the client's admin.
- Whether to add sending email (approved) after drafts, and Gmail push notifications instead of polling.
- Billing: usage is metered per client from v1; how clients are charged (per agent, per month, usage)
  decides what the back office invoices later.
- From the owner's design, not yet in scope: Google Drive (appears connected in the screens), Ramp,
  bank, Outlook, HubSpot (Slack: later, owner); a header command bar ("Ask an agent, or type / for a
  command"); the Invoice intake, Collections follow-up and Card receipts agents.
- Skills under lineage: v1 forks agents, not skills (a client-only skill is written for that client).
  Whether skills also need template/fork lineage depends on how often skills get customized per client.
