# Countersign

An agent platform for back-office work, run as a managed service. A business connects its tools in one
place (QuickBooks Online and Gmail, plus file upload). Our advisors create its agents from a library of
skills, or describe one and let the Builder draft it, then lay out the agent's work on a drag-and-drop
canvas: triggers, skill steps, conditions, approvals, requests and tool actions. Agents run that work,
ask people when they must, and update the connected tools, with every write approved by a person. The
client sees everything their agents do and asks their advisor for changes.

The first agent is **Pia**, who manages material costs for a millwork shop: she finds and extracts
invoices, matches line items to a shared catalog across vendors, tracks unit prices and raises alerts.
She ships as the Materials pack and is built only from platform parts.

Status: **repo set up, M0 next** (Worker, app, database, Workflows, sign-in). Nothing is deployed yet.

## Stack

Same as Plenary Labs: a Hono API on Cloudflare Workers serving a React + Vite app, Cloudflare Workflows
for durable jobs, Postgres 16 (pgvector, pg_trgm) on Neon through Hyperdrive, R2 for files, WorkOS for
sign-in, Anthropic models. TypeScript throughout, pnpm workspace, Biome, Vitest.

## Documents

| Document | What it answers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | What we are building: concepts, scope, data model, skills, agents, workflow graphs and canvas, packs, API, screens, build order. |
| [`docs/plan.md`](docs/plan.md) | How and in what order: decisions, package layering, milestones M0–M10 with tests and exit checks. |
| [`docs/local-development.md`](docs/local-development.md) | Running it on your machine with no API keys. |
| [`docs/operations.md`](docs/operations.md) | Environments, what to provision by hand, secrets, CI and deploys. |
| [`CLAUDE.md`](CLAUDE.md) | Working rules and invariants for anyone (human or agent) changing the code. |

## Layout

```
apps/api        Hono Worker: /api, sign-in, static assets, Workflow classes, cron
apps/web        React + Vite app and workflow canvas (imports only packages/core)
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
