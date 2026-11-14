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
pnpm --filter @countersign/web sweep   # with pnpm dev running: every screen in Chromium (CI's sweep)
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
| Webhooks (Zapier) | Real: make a hook in the portal and `curl` its URL; outbound sends need a public https URL | `ENCRYPTION_KEY` |
| Zoho CRM | Sign-in starts but needs a real Zoho client to finish; tests use a fake Zoho | `ZOHO_CLIENT_*`, `OAUTH_STATE_SECRET`, `ENCRYPTION_KEY` |
| Podio | Sign-in starts but needs a real Podio API key to finish; tests use a fake Podio | `PODIO_CLIENT_*`, `OAUTH_STATE_SECRET`, `ENCRYPTION_KEY` |
| Google Drive | Sign-in starts but needs the Google client to finish; tests use a fake Drive | `GOOGLE_CLIENT_*`, `OAUTH_STATE_SECRET`, `ENCRYPTION_KEY` |
| Outlook | Sign-in starts but needs an Entra app to finish; tests use a fake Microsoft | `OUTLOOK_CLIENT_*`, `OAUTH_STATE_SECRET`, `ENCRYPTION_KEY` |
| Slack | Sign-in starts but needs our Slack app to finish (Slack may want an https redirect: a tunnel); tests use a fake Slack | `SLACK_CLIENT_*`, `OAUTH_STATE_SECRET`, `ENCRYPTION_KEY` |
| Email (sending) | Off; doc requests stay in the inbox | `RESEND_API_KEY` |
| Email forwarding (receiving) | Post a `.eml` to `wrangler dev` (below) | `EMAIL_FORWARDING_DOMAIN` (e.g. `in.mezonas.test`) |
| Document links | The Worker signs its own 5-minute links | `STORAGE_*` (R2 presigned URLs) |

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
(`admin@demo-client.example.com`) and the platform templates; the demo seed below adds Harbor
Millwork's two people. To start from an empty database, drop `countersign` and run
`scripts/setup-postgres.sh` again.

### The end-to-end seed (SEED_E2E=1)

The browser walkthroughs sign and undo a change on the Demo client's Desk. That change is seeded
only when `SEED_E2E=1` is set: the Records clerk (a Demo client agent on a testkit connection), a
live run waiting on it, and its one proposed change, a price on the testkit's record R-1002.
Signing it writes nothing: the testkit is in memory, and the seeded run has no Workflow instance to
execute it. Undo it inside the window and it waits again; seeding again never adds a second one.
Staging's seed and the default `db:seed` never add it: the run has no instance, so if it were signed
and left past the undo window, the cron would retry sending it the approval every minute for 24
hours.

To run the sweep and the walkthroughs locally with it:

```bash
SEED_E2E=1 DIRECT_DATABASE_URL=postgresql://cs_owner:cs_owner@localhost:5432/countersign \
  pnpm --filter @countersign/db run db:seed   # or: SEED_E2E=1 scripts/setup-postgres.sh (with the PG* variables above)
pnpm dev                                      # in another terminal
pnpm --filter @countersign/web sweep          # the route sweep, then the walkthroughs
```

Without it, the walkthroughs skip "Approve and undo" with a note.

### The demo seed (SEED_DEMO=1)

For looking at the portal and the back office with weeks of work in them, `SEED_DEMO=1` adds two
clients, **Harbor Millwork** (a millwork shop in Chicago) and **Fox River Cabinetry** (a cabinet
shop in Appleton, Wisconsin), both served by `operator@example.com`, who is also their Mezonas
lead. It is never part of the default seed: it is
for local runs, and for a staging demo only when the owner chooses to run it there.

```bash
SEED_DEMO=1 DIRECT_DATABASE_URL=postgresql://cs_owner:cs_owner@localhost:5432/countersign \
  pnpm db:seed          # with SEED_E2E=1 too, if you also want the Demo client's Desk item
```

Sign in on the dev sign-in screen as:

| Email | Who |
|---|---|
| `dana@harbor-millwork.example.com` | Dana Reyes, client admin: signs the changes |
| `luis@harbor-millwork.example.com` | Luis Ortega, client user (the bookkeeper) |
| `maya@foxriver-cabinetry.example.com` | Maya Chen, Fox River Cabinetry's client admin |
| `owen@foxriver-cabinetry.example.com` | Owen Brooks, Fox River Cabinetry's client user (the bookkeeper) |
| `operator@example.com` | The operator: both demo clients are among the clients they serve |

What each holds (`packages/db/src/seed-demo.ts`; Fox River Cabinetry is the same weeks of work
as Harbor Millwork, with its own people, invoice numbers and times):

- Four client agents with their versions: the **Bill clerk** (live, a client v2 that writes the
  bill memo without a signature), the **Document clerk** (live, a client v2 that looks for the
  document behind each new bill or purchase), the **Supervisor** (live) and the **Price keeper**
  (in trial, on QuickBooks: it sets an item's purchase cost to the price on a vendor's invoice).
  The first three are forks of the platform templates; the Price keeper was made for the client.
- Connections: QuickBooks (connected, for show: no credentials) and uploads. No testkit: that is
  for the Sandbox and template test copies.
- About 110 runs over the last 21 days: invoices read, bills itemized, filed and noted, documents
  looked for, item costs updated, daily checks, three failures and the supervisor's reports on
  them. Three changes wait for Dana (one for over a day), one question waits for her, one change
  she turned down.
- 34 vendor invoices from five vendors, read, one of them a duplicate; the bills and card purchases
  they belong to; 12 contacts at the shop and its vendors, with consent; three knowledge entries;
  30 days of usage; last week's Weekly Table, sent; two open findings and the latest health check.

Running it again changes nothing: ids are fixed and every time is counted from the first run. The
Demo client and the Sandbox are left as they are (the end-to-end Desk item and the sweep expect the
Demo client as the base seed leaves it). An operator signed in before the seed ran sees the new
clients after signing in again. The runs have no Workflow instances, so signing a
waiting change writes nothing. With QuickBooks set up in `.env`, a cron tick at a QuickBooks sync
minute (4, 19, 34 or 49) finds the QuickBooks connection has no credentials and marks it as
needing a sign-in; the same happens on a deployed server, where the cron runs every minute. To
take it out again, drop `countersign` and run `scripts/setup-postgres.sh`.

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

Write skills in Skills → New skill (publish a version, then add it to an agent from the skill's page); skill steps need `ANTHROPIC_API_KEY` to run. The Builder ("My description" on a new agent, "Revise with the Builder" on an agent page) also needs the key; without it the page says it can't reach its model.

## Status

Phase 1 (`docs/plan.md` §3) and most of Track B run locally end to end: migrations and seed, the
Worker with its Workflows and cron, sign-in, templates and client agents with the workflow builder,
test and live runs with approvals, the back office's and the portal's inbox, runs and connections.
Template updates, promotion, detach and re-link run through the merge view (an agent's Versions tab). QuickBooks is not built yet.

## Uploads and email forwarding

Upload invoices or a purchases CSV on the portal's Connections page. With `ANTHROPIC_API_KEY` set,
each new document is read in the background; without it, documents stay "Received" until an agent's
`docs.extract` reads them.

With `EMAIL_FORWARDING_DOMAIN` in `.env`, the Connections page shows the client's private address.
Add an allowed sender there, then hand `wrangler dev` a message the way Email Routing would:

```bash
TO=<the address from the Connections page>
sed "s/hollis-millwork-TENANT-SECRET@in.mezonas.test/$TO/" fixtures/email/forwarded-by-ap.eml > /tmp/fwd.eml
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=ap@hollismillwork.example&to=$TO" \
  --data-binary @/tmp/fwd.eml
```

