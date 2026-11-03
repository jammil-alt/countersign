# apps/web

React + Vite + React Router single-page app: the screens in ARCHITECTURE §15, built from the owner's
designs on the Groundwork design system (tokens in `tokens.css`, Tailwind + shadcn primitives). Served
as static assets by `apps/api`. Depends only on `@countersign/core` (route contract and shared types);
every read and write goes through `/api`. Scaffolded in M0 (`docs/plan.md` §4).
