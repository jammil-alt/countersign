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
pnpm dev          # builds apps/web, then wrangler dev on :8787: API, app, Workflows, cron (reads .env)
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
| QuickBooks | Not built yet (phase 3); the testkit connector stands in | `QBO_*` (sandbox) |
| Email | Off; doc requests stay in the inbox | `RESEND_API_KEY` |

Tests never call a live model. To add a recorded response, run the test once with
`LLM_MODE=record` and an API key, and commit the new file under `fixtures/llm/`.

## Trying it

With `pnpm dev` running, sign in as a seeded user and call the API (the dev adapter needs no password):

```bash
curl -s localhost:8787/api/health                         # {"ok":true}
curl -s localhost:8787/api/auth/dev/users                 # the seeded users and their clients
curl -s -c jar -H 'content-type: application/json' \
  -d '{"email":"operator@example.com"}' localhost:8787/api/auth/dev/sign-in
curl -s -b jar localhost:8787/api/session
curl -s -b jar localhost:8787/api/ops/clients
curl -s localhost:8787/cdn-cgi/local/scheduled            # fire the cron once
```

Or open http://localhost:8787 and pick a user on the sign-in screen. The seed has one operator
(`operator@example.com`, serving Sandbox and Demo client), one client admin
(`admin@demo-client.example.com`) and the platform templates. To start from an empty database, drop
`countersign` and run `scripts/setup-postgres.sh` again.

`wrangler dev` reads the root `.env` (`--env-file ../../.env`), which gives it
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`; without it the Worker cannot reach the
database. Runs execute locally as real Workflows. Model calls need `ANTHROPIC_API_KEY`; without it,
skills that call a model fail, while actions, person, fork and notify steps still run.

To try a workflow end to end as the operator: create a template (Templates → New template), build
its workflow in the Workflow tab, publish it, and fork it into a client. In the **Sandbox** you connect
the testkit yourself (client → Connections → Connect); in the Demo client, offer the testkit from the
same page and sign in as the client admin to connect it from the portal. Bind the connection in the
agent's Settings, then Test run from the builder. A test run's person steps wait in your Inbox. After a
passing test run of the live version, Activate in Settings; the client admin then approves its changes
from the portal inbox. The testkit is in memory: `testkit.record.update` fails on a record it doesn't
hold, and it forgets everything when the Worker restarts.

There is no screen for writing skills yet; skill steps also need `ANTHROPIC_API_KEY` to run.

## Status

Phase 1 (`docs/plan.md` §3) and most of Track B run locally end to end: migrations and seed, the
Worker with its Workflows and cron, sign-in, templates and client agents with the workflow builder,
test and live runs with approvals, the back office's and the portal's inbox, runs and connections.
The merge view, QuickBooks, email and document extraction are not built yet.
