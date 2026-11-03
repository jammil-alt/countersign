# Countersign

A managed-agents service suite for back-office work. The operator builds and runs agents for client
businesses from a back office that reaches into every client. Agents are built per client: proven ones
are kept as templates, forked into a client as its own agent, and customized for its data and flows in a
drag-and-drop workflow builder, with every client's agent versioned separately and linked to its template so
improvements can be merged in either direction. Clients sign in to their own tools (QuickBooks Online and
Gmail, plus file upload) from their portal; agents do the work and update those tools, within each
connection's permissions. Each client's portal also has reports, runs, approvals and requests.

The first agent is **Pia**, who manages material costs for a millwork shop: she finds and extracts
invoices, matches line items to a shared catalog across vendors, tracks unit prices and raises alerts.
She ships as the Materials pack as a template, built only from platform parts; the shop runs its own customized fork.

Status: **repo set up, M0 next** (Worker, app, database, Workflows, sign-in). Nothing is deployed yet.

## Stack

A Hono API on Cloudflare Workers serving a React + Vite app, Cloudflare Workflows for durable jobs,
Postgres 16 (pgvector, pg_trgm) on Neon through Hyperdrive, R2 for files, WorkOS for sign-in, Anthropic
models. TypeScript throughout, pnpm workspace, Biome, Vitest.

This is the same stack and set of conventions as Plenary Labs, chosen for consistency. Countersign is a
separate product: it shares no runtime dependency, data, infrastructure, keys or secrets with it.

## Documents

| Document | What it answers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | What we are building: concepts, scope, data model, skills, agents, workflows and the builder, permissions, packs, API, screens, build order. |
| [`docs/design/`](docs/design/README.md) | The owner's v1 screens (starting point), captures, and the Groundwork tokens. |
| [`docs/plan.md`](docs/plan.md) | How and in what order: decisions, package layering, milestones M0–M10 with tests and exit checks. |
| [`docs/local-development.md`](docs/local-development.md) | Running it on your machine with no API keys. |
| [`docs/operations.md`](docs/operations.md) | Environments, what to provision by hand, secrets, CI and deploys. |
| [`CLAUDE.md`](CLAUDE.md) | Working rules and invariants for anyone (human or agent) changing the code. |

## Layout

```
apps/api        Hono Worker: /api, sign-in, static assets, Workflow classes, cron
apps/web        React + Vite app: back office with the workflow builder, and client portal (imports only packages/core)
packages/       the platform: core, db, llm, auth, senses, connectors, documents, threads,
                agents, workflows (layering in docs/plan.md §2; never imports a pack)
packs/          domain packs; materials/ is the first (Pia)
fixtures/       invoices, QBO payloads, matching pairs, recorded model responses
scripts/        layering check, Postgres role setup
```

## Quick start

```bash
corepack enable && pnpm install
cp .env.example .env
pnpm db:up
pnpm check
```

Full local setup: [`docs/local-development.md`](docs/local-development.md).
