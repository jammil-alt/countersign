# apps/web

Next.js (App Router) app: screens (ARCHITECTURE §15), route handlers under `/api` (§14), auth, and the
Inngest serve endpoint at `/api/inngest`. Scaffolded in M0 (`docs/plan.md` §4, M0).

This app is the only place that wires packages together. Business logic lives in `packages/*`;
route handlers validate with Zod, resolve the tenant from the session, and call into packages.
