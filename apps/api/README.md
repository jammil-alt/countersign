# apps/api

The Hono Worker (ARCHITECTURE §2–3, §14): `/api` routes, sign-in, the built `apps/web` served as
static assets (`run_worker_first: ["/api/*"]`), the `RunWorkflow` Workflow class and the every-minute
cron. It is the only place that wires packages together and the only place with Workers bindings.

| File | What |
|---|---|
| `src/index.ts` | Worker entry: `fetch`, `scheduled` (cron), `RunWorkflow`. |
| `src/app.ts` | `createApp(deps)`: the Hono app, built from injectable dependencies (tests pass a test database and in-memory Workflow instances). |
| (contract) | The route contract (method, path, roles, Zod schemas) lives in `@countersign/core` (`packages/core/src/api/routes.ts`); every entry is mounted here. |
| `src/http.ts` | Per-request database, session (packages/auth), role checks, client scope (`withOperator` for `/api/ops`, `withTenant` for the portal), Zod in and out, after-commit and deferred work, errors. |
| `src/auth.ts` | packages/auth's directories over the database; picks the `dev` or `workos` adapter. |
| `src/platform.ts` | Tool, skill and event registries (testkit connector outside production). |
| `src/routes/` | Back office (`ops-clients.ts`, `ops-agents.ts`), portal (`portal.ts`), sign-in and session (`session.ts`). |
| `src/inbox.ts` | Resolving inbox items: resolution + `inbox.resolved` in one transaction, then the run is resumed with `sendEvent`. |
| `src/runs/` | `RunWorkflow`, the `StepRunner` adapter over Cloudflare's `WorkflowStep`, the executor's ports over the database and the agents runtime, the senses dispatcher and cron. |
| `src/runtime-harness.ts` | Entry point of the Workers tests only: adds `ProbeWorkflow`. Never deployed. |

## Sign-in

`AUTH_PROVIDER=dev` (local): `GET /api/auth/dev/users` lists the seeded users, `POST
/api/auth/dev/sign-in {email}` sets a cookie for one; the `x-countersign-dev-user` header does the
same per request. Refused in production.
`AUTH_PROVIDER=workos`: `GET /api/auth/sign-in?return_to=`, `GET /api/auth/callback`,
`POST /api/auth/sign-out`. The active client travels with each request as `?client=` or the
`x-countersign-client` header.

## Runs

A run is created by the API (manual runs, test runs) or the dispatcher (events, schedules): the run
row first, then `RUN_WORKFLOW.create({ id: runId, params })`. Triggered run ids are deterministic, so
a second start is refused. `RunWorkflow` calls `executeRun` (`src/runs/execute.ts`) with the step
adapter; Node tests call the same function with a fake step.

## Running it

`pnpm dev` (repo root) builds apps/web and runs `wrangler dev --env-file ../../.env` here, so the
root `.env` supplies `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` (the local `cs_worker`
URL) and any keys. See docs/local-development.md.

## Tests

```sh
pnpm --filter @countersign/api test   # Node (local Postgres; skips without it) + Workers pool
```

Node tests need `TEST_ADMIN_DATABASE_URL` (a superuser on a Postgres with pgvector); they skip when
it is unreachable unless `COUNTERSIGN_REQUIRE_DB=1`. The Workers tests (`*.runtime.test.ts`) need no
database: Hyperdrive gets an unreachable placeholder when
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` is unset.
