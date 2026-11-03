# Countersign

A multi-tenant back-office agent platform. It connects to a small business's systems (QuickBooks Online
first, plus manual upload), keeps a clean copy of their data, and runs named, versioned agents that each
own one back-office job. The first job is material cost management for a millwork shop: pull purchases,
find and extract the invoice, match each line to a shared item catalog across vendors, track unit prices
and alert when they change.

Status: **repo set up, M0 next** (Worker, app, database, Workflows, sign-in). Nothing is deployed yet.

## Stack

Same as Plenary Labs: a Hono API on Cloudflare Workers serving a React + Vite app, Cloudflare Workflows
for durable jobs, Postgres 16 (pgvector, pg_trgm) on Neon through Hyperdrive, R2 for files, WorkOS for
sign-in, Anthropic models. TypeScript throughout, pnpm workspace, Biome, Vitest.

## Documents

| Document | What it answers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | What we are building: scope, data model, agents, workflows, API, screens, build order. |
| [`docs/plan.md`](docs/plan.md) | How and in what order: decisions, package layering, milestones M0–M10 with tests and exit checks. |
| [`docs/local-development.md`](docs/local-development.md) | Running it on your machine with no API keys. |
| [`docs/operations.md`](docs/operations.md) | Environments, what to provision by hand, secrets, CI and deploys. |
| [`CLAUDE.md`](CLAUDE.md) | Working rules and invariants for anyone (human or agent) changing the code. |

## Layout

```
apps/api        Hono Worker: /api, sign-in, static assets, Workflow classes, cron
apps/web        React + Vite app (imports only packages/core)
packages/       core, db, llm, auth, senses, connectors, documents, catalog, pricing,
                threads, agents, workflows: layering in docs/plan.md §2
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
