# Local development

Everything runs on your machine without any API keys: Postgres in Docker, the Worker and its
Workflows under `wrangler dev`, the `dev` sign-in adapter, and recorded model responses. Each
external service switches on when its setting appears in `.env`.

## Once

```bash
nvm use                      # Node 22 (.nvmrc)
corepack enable              # pnpm version from package.json
pnpm install
cp .env.example .env
pnpm db:up                   # Postgres 16 + pgvector on :5432 (docker-compose.yml)
```

Then give the database the same roles as Neon (`docs/plan.md` §1.2), with fixed local passwords to
match `.env.example`:

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres \
  CS_OWNER_PASSWORD=cs_owner CS_WORKER_PASSWORD=cs_worker scripts/setup-postgres.sh
```

It creates `cs_owner` and the `countersign` database, the extensions, runs the migrations and creates
`cs_worker`. Run it once per fresh database (`docker compose down -v` drops the data).

Without Docker, any Postgres 16 with pgvector works: point the `PG*` variables at it.

## Every day

```bash
pnpm dev          # builds apps/web, then wrangler dev on :8787: API, app, Workflows, cron
pnpm dev:web      # Vite with /api proxied to :8787, for fast UI work (run beside pnpm dev)
pnpm check        # lint, layering, typecheck, tests: what CI runs
pnpm format       # Biome: format and organise imports
```

## What is real and what is not

| Piece | Locally | Switch on with |
|---|---|---|
| Database | Docker Postgres, same roles as Neon | always on |
| Sign-in | `dev` adapter: pick a seeded user, no password | `AUTH_PROVIDER=workos` + `WORKOS_*` |
| Workflows, cron | Real, under `wrangler dev` | always on |
| File storage | Local R2 simulation in `wrangler dev` | always on |
| Models | `LLM_MODE=replay` in tests; `live` calls Anthropic | `ANTHROPIC_API_KEY` |
| QuickBooks | Off; use the upload connector | `QBO_*` (sandbox) |
| Email | Off; doc requests stay in the inbox | `RESEND_API_KEY` |

Tests never call a live model. To add a recorded response, run the test once with
`LLM_MODE=record` and an API key, and commit the new file under `fixtures/llm/`.

## Status

Nothing above `pnpm check` runs yet: the app, Worker and migrations arrive in M0 (`docs/plan.md` §4).
