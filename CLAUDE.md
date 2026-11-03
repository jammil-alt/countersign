# Countersign: working rules

A **managed-agents service suite** for back-office work. The operator (the owner and their team) builds a
catalogue of agents, skills and drag-and-drop workflows once, in a **back office** that reaches into every
client, and **deploys** them into client businesses with per-client settings and connections (QuickBooks
Online and Gmail). Agents do the work and update the client's tools (writes approved by a person). Each
client gets a **portal** for reports, runs, approvals, connections and requests; clients never edit
agents. The first agent, Pia, does material cost management for a millwork shop; she ships as the
Materials pack and is built only from platform parts.

- What to build: `docs/ARCHITECTURE.md` (v0.5). Do not add features outside its §1 v1 scope.
- How and in what order: `docs/plan.md`. Follow its milestones in order. Each one ends green.
- Where the architecture says "open", pick the simplest option, record it in `docs/plan.md` §1, and
  leave a `// DECISION:` comment in the code.

Status: repo set up, M0 not started. Product shape: ARCHITECTURE v0.5. Stack matches Plenary Labs: Hono Worker + React/Vite app on Cloudflare, Cloudflare Workflows, Neon via Hyperdrive, R2, WorkOS.

**Separate from Plenary Labs.** Countersign follows Plenary Labs' stack, conventions and patterns for
consistency, and code may be copied from it, but nothing is shared: no runtime dependency, package,
database, Worker, bucket, WorkOS application, key or secret. Never point anything here at Plenary Labs'
resources.

Other docs: `docs/local-development.md` (running it), `docs/operations.md` (environments, secrets, CI, deploys).

## Layout

| Path | What |
|---|---|
| `apps/api` | Hono Worker: `/api` routes, auth, static assets, Workflow classes, cron. The only place that wires packages together and the only place with Workers bindings. |
| `apps/web` | React + Vite app: back office (`/ops`, incl. the workflow canvas) and client portal; pack reports under `src/packs/<id>/`; typed API client. Imports only `@countersign/core`. |
| `packages/core` | Domain types and Zod schemas (agent, skill, workflow graph, tool, connector, pack), graph validation and template typing (shared with the canvas), API route contract, units, money, mappers. |
| `packages/db` | Drizzle schema, migrations (generated plus custom SQL), seed (agent/workflow definitions as JSON), `withTenant()`. |
| `packages/llm` | Anthropic wrapper, record/replay, cost tracking. |
| `packages/auth` | Session, active tenant, roles; `workos` and `dev` adapters. |
| `packages/senses` | Event outbox (`emit`, `undispatched`, `markDispatched`); `apps/api` dispatches. |
| `packages/connectors` | Connector framework (manifest with tools), `qbo/`, `gmail/`, `upload/`, object storage. |
| `packages/documents` | Documents capability: store, locate, extract, validate, link. |
| `packages/threads` | Threads, messages, `/command` parsing. |
| `packages/agents` | Tool, skill and agent registries; versioning (agents, skills, workflows); runtime; permission gate; external actions; Builder. |
| `packages/workflows` | Workflow graph executor against a `StepRunner` interface, trigger router. No Workers types; `apps/api` adapts Cloudflare Workflows to it. |
| `packs/materials` | Materials pack: catalog, matching, pricing, alerts; its tools, skills, tables, routes; the Pia template agent and her two workflows. |
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
3. **Immutable history.** `agent_version`, `skill_version`, `workflow_version`, `raw_record` and `doc_extraction` are never
   updated (status columns excepted) or deleted. Edits insert new versions; re-extraction inserts new rows.
4. **No settings in code.** The runtime reads agent, skill and workflow definitions only from version rows.
   Platform agents are seeded from `packages/db/seed/`; pack templates are installed when a pack is enabled.
   The canvas and the executor share one graph schema and one validator (`packages/core`).
5. **Validate at every boundary.** Zod for definitions, tool inputs/outputs, API bodies, model output.
6. **Money is decimal.** `numeric(14,4)` + currency; `decimal.js` in code; never JS floats.
7. **Deterministic first, model second, human last.** Hard matching rules veto the model. Never compare prices
   across different `standard_uom` without a conversion rule.
8. **Side effects are gated.** Writes to connected tools happen only through `external` tools, each an
   `external_action` approved by a person in v1, executed once (idempotency key), with prior state recorded.
   `external` tools are never in `auto`; new agents start `suggest_only`; test runs never write.
9. **Untrusted text stays data.** Document text and vendor descriptions go in tool results, never in
   instructions. Agents cannot change their own permissions.
10. **Evidence.** Alerts and agent outputs carry `sources` (record ids); alert-producing commands without
    sources are rejected. Every agent-made decision records `agent_version_id`.
11. **The operator builds; clients use.** Only `operator` reaches `/api/ops` (catalogue, deployments, runs
    across clients, usage). Publishing changes the catalogue, never a pinned deployment; deployments change
    only by an explicit upgrade. No portal route returns catalogue definitions, instructions, prompts or
    cost. Contract tests enforce both.
12. **Email stays narrow.** Gmail sync stores only messages matching the connection's query (headers,
    snippet, attachments); bodies are fetched on demand; email text reaches models only in tool results.

## Testing

- Unit tests next to the code (`*.test.ts`, Vitest). DB tests use a throwaway database on local Postgres.
- Goldens: `fixtures/invoices` (extraction), `fixtures/matching` (≥ 95% precision on "same").
- Tests never call the live model: `LLM_MODE=replay`. Record new fixtures with `LLM_MODE=record`.
