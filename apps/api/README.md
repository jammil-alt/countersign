# apps/api

The Hono Worker (ARCHITECTURE v0.2 §2–3): route handlers under `/api` (§14), WorkOS sign-in, the built
`apps/web` served as static assets, the Cloudflare Workflow classes (`RunWorkflow`, `QboSyncWorkflow`),
and the every-minute cron (senses sweep, schedule triggers, QBO CDC). Same shape as Plenary Labs' `apps/api`.

This is the only place that wires packages together and the only place with Workers types and bindings.
Business logic lives in `packages/*`; handlers validate with Zod, resolve the tenant from the session,
and call into packages. Scaffolded in M0 (`docs/plan.md` §4).
