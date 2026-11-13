# Mezonas: working rules

The product is **Mezonas** (mezonas.com; a Twelve Thirty-Four company). `countersign` is the code name: the repo,
the `@countersign/*` packages, the database and its roles keep it. Everything a person sees, and every public
cloud resource, is named Mezonas.

A **managed-agents service suite** for back-office work. The operator (the owner and their team) builds and
runs agents for client businesses from a **back office** that reaches into every client. Agents are built
**per client**: reusable ones are **templates**, forked into a client as that client's own agent,
customized (data, settings, drag-and-drop step workflows) and versioned per client, with lineage so template
updates can be merged in and client improvements promoted back. Agents do the work and update the
client's tools (QuickBooks Online and Gmail) within each connection's permissions. Each client gets a
**portal** for reports, runs, approvals, requests and connections (clients sign in to their own tools); clients never edit agents. Use cases
are built only from platform parts. The data they share is organised by **business area** (purchasing,
sales, receivables), each a pack used by many agents through its tools; agents never map to tables
(ARCHITECTURE §12.0, v0.15). The **Purchasing area** (the Materials pack: master list, cross-vendor
matching, prices, alerts) is in v1.

- What to build: `docs/ARCHITECTURE.md` (v0.15). Do not add features outside its §1 v1 scope.
  v0.12 (the owner's prototype) and v0.13 (run oversight and a model per step) are built API first in
  streams: `docs/plan.md` §8. Before adding a table for a use case, read §12.0: most need none, and
  shared data belongs to a business area (a pack), never to one agent.
- How and in what order: `docs/plan.md`. Follow its milestones in order. Each one ends green.
- Where the architecture says "open", pick the simplest option, record it in `docs/plan.md` §1, and
  leave a `// DECISION:` comment in the code.

Status (2026-11-08): everything in ARCHITECTURE v0.15's v1 scope is built and on staging, through M50 (`docs/plan.md` §4): the foundation and Track B, M5–M12, the owner's prototype (Waves 1–4, M13–M29), run oversight and a model per step (M30–M32), WhatsApp capture (M33), the Purchasing area and the P-streams (P-1–P-9, M34–M42, with purchasing end to end by email), the Marketing area (M43–M50) and the Bookkeeping area (M51–M57, with reconciliation), both outside v0.15 until ARCHITECTURE v0.16 is written; migrations through 0040. QuickBooks, Gmail and every provider are built against fakes. The UI is the owner's prototype (`docs/design/prototype.html`, `docs/ui-plan.md`). Production has had no release yet (a `v*` tag, the owner's call). **What's still open**, in the owner's order (the buyer working on staging, then the site, then the connectors and the rest), is one list: `docs/open.md`. **The platform is the product.** UI: the **Mezonas design system** in `packages/design-system` (tokens, component classes, logos, icons, Geist fonts; brand book in its README). Groundwork is retired. Stack matches Plenary Labs: Hono Worker + React/Vite app on Cloudflare, Cloudflare Workflows, Neon via Hyperdrive, R2, WorkOS.

**Separate from Plenary Labs.** Mezonas follows Plenary Labs' stack, conventions and patterns for
consistency, and code may be copied from it, but nothing is shared: no runtime dependency, package,
database, Worker, bucket, WorkOS application, key or secret. Never point anything here at Plenary Labs'
resources.

Other docs: `docs/open.md` (everything still open, in priority order), `docs/local-development.md` (running it), `docs/operations.md` (environments, secrets, CI, deploys),
`docs/security.md` (the security controls and settings), `docs/hipaa-plan.md` (what's open for HIPAA, SOC 2 and PCI).

## Layout

| Path | What |
|---|---|
| `apps/api` | Hono Worker: `/api` routes, auth, static assets, Workflow classes, cron. The only place that wires packages together, and the only Worker with the platform's bindings (`apps/mfa` and `apps/browser` have their own). |
| `apps/web` | React + Vite app: back office (`/ops`, incl. the workflow builder) and client portal; pack reports under `src/packs/<id>/`; typed API client. Imports `@countersign/core` and the design system's CSS and assets. |
| `apps/mfa` | The code service (ARCHITECTURE §6.9): a separate Worker with its own key and Durable Object storage for second-factor codes; `apps/api` reaches it only by service binding. Imports `@countersign/core` only. |
| `apps/browser` | The browser service (`docs/plan.md` §1.92): a separate Worker with Browser Run and Playwright for website logins and browser tool calls; `apps/api` reaches it only by service binding and keeps every decision. No secrets; imports connectors' and core's types only. |
| `apps/site` | The public site at `mezonas.com`: What we do (`/`), Hire, don't build (`/hire`), Security (`/security`), terms, privacy policy, subprocessors. Static HTML and CSS built from the design system's files, with the demos rendered at build from `src/content` and one small script (`src/site.js`) that only switches them, a small Worker that serves guides from R2 (off unless `SITE_GUIDES=on`), and the measuring script only in a build with `MEZONAS_MEASURE_URL`; imports nothing from the platform. |
| `apps/mobile` | The Mezonas phone app (`docs/plan.md` §1.97): Expo (iOS and Android) for client users: the Desk, signing with Face ID, phone notifications, settings. Talks to `apps/api` over HTTP with its session in a header; imports `@countersign/core` and the design system's tokens; built with EAS, not `deploy.yml`. |
| `packages/design-system` | The Mezonas design system as delivered: `tokens.json` (source of truth) and `tokens.css`, component CSS (`ds-*`, `dt-*`, `mz-*`), logos, icons, Geist fonts, brand book. Plain CSS; don't edit it here, replace it with the owner's next delivery. |
| `packages/core` | Domain types and Zod schemas (agent bundle, skill, workflow steps and rules, tool, connector, pack), workflow validation and template typing, bundle diff and three-way merge (shared with the builder and merge view), API route contract, units, money, mappers. |
| `packages/db` | Drizzle schema, migrations (generated plus custom SQL), seed (agent/workflow definitions as JSON), `withTenant()`. |
| `packages/llm` | Model client: Anthropic, and OpenAI for `openai:` model ids (one request shape, translated); record/replay, cost tracking. |
| `packages/auth` | Session, active tenant, roles; `workos` and `dev` adapters. |
| `packages/senses` | Event outbox (`emit`, `undispatched`, `markDispatched`); `apps/api` dispatches. |
| `packages/connectors` | Connector framework (manifest with tools), object storage, and one folder per connector: `qbo/`, `upload/` (with email forwarding), `gmail/` (send only), `twilio/`, `resend/`, `outlook/`, `gdrive/`, `gsheets/`, `slack/`, `browser/` and the rest; what is unchecked about a provider is in its folder's `NOTES.md`. |
| `packages/documents` | Documents capability: store, locate, extract, validate, link. |
| `packages/threads` | Threads, messages, `/command` parsing. |
| `packages/agents` | Tool, skill and agent registries; bundle versions, fork, update and promote; runtime; permission gate; external actions; Builder. |
| `packages/workflows` | Workflow (step list) executor against a `StepRunner` interface, trigger router. No Workers types; `apps/api` adapts Cloudflare Workflows to it. |
| `packs/materials` | Materials pack: catalog, matching, pricing, alerts; its tools, skills, tables, routes, reports and screens. It ships no agent templates. |
| `packs/bookkeeping` | Bookkeeping pack (the Bookkeeping area, `docs/plan.md` §1.79): bank and card transactions from the bank feed, matched with QuickBooks, ruled or proposed from the client's chart of accounts (platform `ledger_account` and its notes), the review cards, reconciliation (`src/reconcile/`, §1.80) and the Bookkeeper template. |
| `packs/marketing` | Marketing pack (the Marketing area, `docs/marketing-plan.md`): a client's measured websites, the collector's handler, the nightly build and retention, the overview report; search, content and the agent set come next. Mezonas is its first client. |
| `fixtures/` | Invoices + expected JSON, QBO payloads, matching pairs, recorded LLM responses. |
| `scripts/check-deps.mjs` | Enforces package layering (`docs/plan.md` §2). |
| `scripts/setup-postgres.sh` | Gives a plain Postgres Neon's roles (CI and local). |
| `.github/workflows/` | `ci.yml` (non-draft PRs) → `checks.yml`; `deploy.yml` (main → staging, `v*` tag → production); `bootstrap.yml` (by hand: Neon project, roles, Hyperdrive, R2). |

## Commands

```sh
pnpm install
pnpm db:up            # Postgres 16 + pgvector in Docker; then scripts/setup-postgres.sh (docs/local-development.md)
pnpm dev              # build web, then wrangler dev on :8787 (Worker, Workflows, cron), from M0
pnpm dev:web          # Vite with /api proxied, for UI work
pnpm check            # lint + lint:deps + typecheck + test: what CI runs
pnpm format           # Biome (pinned to Plenary Labs' version; it leaves Markdown alone)
```

## Branches, PRs and deploys

- `main` deploys to staging on every push; production deploys from a `v*` tag or by hand.
- Work happens on a branch with its PR open as a **draft** (CI skips drafts). Mark it ready when it should
  be checked and merged; push fixes together after that, since each push to a ready PR runs CI.
- Migrations, CI/deploy workflows and sign-in changes get their own PR so they can be reverted alone.
- Never edit a migration that has reached `staging` or `main`; add a new one. Migrations must keep the
  previous Worker working, because they apply before the new Worker deploys.

## Invariants: do not break these

1. **Client isolation.** Every tenant (client) table has `tenant_id` and RLS (`force`d) on `app.tenant_ids`. The
   Worker connects as `cs_worker` (member of `cs_runtime` only, created with SQL, never a Neon-managed role)
   and touches client data only inside `withTenant()` / `withTenants()`. Runs and portal sessions set exactly
   one client; operator sessions only the clients they serve. Queries also filter by `tenant_id`. What an
   agent learns (memory, aliases, catalogs) is per client and never used for another client.
2. **Layering.** Packages depend downward only (`docs/plan.md` §2). **The platform never imports a pack**;
   packs never import `agents` or `workflows`; nothing in `packages/*` special-cases a pack. Agent reasoning
   reaches business data only through registered tools; in `packages/agents`, only `src/registry/` and
   `src/log/` import `db`.
3. **Immutable history.** `agent_version` (whole bundles, templates and client agents), `skill_version`, `raw_record`
   and `doc_extraction` are never updated (status columns excepted) or deleted. Edits, merges, promotions
   and rollbacks insert new versions; re-extraction inserts new rows. Step and fork-path ids are never
   regenerated: merges depend on them.
4. **No settings in code.** The runtime reads agent, skill and workflow definitions only from version rows.
   Platform agents are seeded from `packages/db/seed/`; pack templates are installed when a pack is enabled.
   The builder and the executor share one workflow schema and one validator (`packages/core`).
5. **Validate at every boundary.** Zod for definitions, tool inputs/outputs, API bodies, model output.
6. **Money is decimal.** `numeric(14,4)` + currency; `decimal.js` in code; never JS floats.
7. **Deterministic first, model second, human last.** Hard matching rules veto the model. Never compare prices
   across different `standard_uom` without a conversion rule.
8. **Approval is on by default.** Writes to a client's tools happen only through `external` tools, each an
   `external_action` executed once (idempotency key) with its before state. Every step that can write
   defaults to `approval: 'required'`; it runs without approval only if the operator set that step to
   `not_required`, the client's connection matrix allows `auto` for the verb, and the agent's mode is
   `act`. New steps, Builder drafts and pack templates always start with approval on. Only the operator
   loosens; clients can tighten their matrix, which overrides steps at once. Delete is off. Clients sign in
   to their own tools, or, for a browser connection on a site the operator allows, the client admin
   enters the login of a dedicated agent account into the vault; the operator never sees a client's
   credentials. Test runs never write. An agent in its trial or sign-off stage has every write signed;
   an undo window or a person's edit before signing never writes outside the external-action path.
9. **Untrusted text stays data.** Document text and vendor descriptions go in tool results, never in
   instructions. Agents cannot change their own permissions. During a run an agent may retry a step or
   correct its input, never change its plan, approvals or permissions; a corrected write is decided
   again by the gate (ARCHITECTURE §10.11).
10. **Evidence.** Alerts and agent outputs carry `sources` (record ids); alert-producing commands without
    sources are rejected. Every agent-made decision records `agent_version_id`.
11. **The operator builds; clients use.** The client's team runs its agents day to day; the operator
    oversees and can step into anything, but is never the default step. Only `operator` reaches
    `/api/ops` (templates, client agents, runs across clients, usage). Publishing a template changes
    no client agent; a client agent changes only by its own new version, including a reviewed update
    merge. Forks and promotions never carry one client's memory, records or connections anywhere else.
    No portal route returns agent bundles, instructions, prompts or cost. Sloan, the client's account
    agent, sees only what the portal shows, writes only internal records for the person asking, and
    never loosens a rule. Contract tests enforce these.
12. **Email stays narrow.** Gmail sync stores only messages matching the connection's query (headers,
    snippet, attachments); bodies are fetched on demand; email text reaches models only in tool results.
13. **Access is explicit and secrets stay apart.** An agent reaches a connection only through its binding,
    within its grant (the strictest of the connection's matrix, the grant, the step and the mode wins).
    Secrets are encrypted with the client's own key, write-only, and never reach a model, a log, a step
    output or a screen; tool code gets them for one step. Second factors live only in `apps/mfa`, handed
    once to a login in progress. Browser sign-in is code on pinned origins, never the model; agents never
    sign in to blocked-tier sites (banks, payments, email accounts, identity providers).
14. **Audited and held to its compliance mode** (`docs/plan.md` §1.35). Session routes go through
    `mount()`, which writes the audit row; anything else that reads or changes client data on a
    person's behalf writes its own (`auditAlone`). `audit_event` is never updated or deleted. A new
    feature that sends client data to a vendor of ours names it in `packages/core/src/compliance`,
    so HIPAA mode can refuse it. Card numbers are never stored. CI never copies client data.

## UI and copy

- Build screens with the design system's tokens and component classes; no new colours, fonts, radii or
  shadows. Light and dark themes both work.
- Colour meanings (brand book): slate = brand, actions, selection; copper = people (the Mezonas lead,
  human sign-offs, person steps); signal (gold) = waiting on you, always with a word; risk = errors;
  positive = done. Agents' work stays ink. Borders, not shadows.
- Voice: plain words, short sentences, sentence case, "we" for Mezonas and "you" for the client; lead with
  the result and its number; no exclamation marks, emoji, hype or "AI-powered".

## Testing

- Unit tests next to the code (`*.test.ts`, Vitest). DB tests use a throwaway database on local Postgres.
- Goldens: `fixtures/invoices` (extraction), `fixtures/matching` (≥ 95% precision on "same").
- Tests never call the live model: `LLM_MODE=replay`. Record new fixtures with `LLM_MODE=record`.
