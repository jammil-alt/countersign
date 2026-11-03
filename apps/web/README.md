# apps/web

React + Vite + React Router single-page app with two surfaces: the **back office** (`/ops`, operator; its
bundle, including the canvas, is code-split) and the **client portal**. The screens are in ARCHITECTURE §15, built from the owner's
designs on the Groundwork design system (tokens in `tokens.css`, Tailwind + shadcn primitives). Includes
the workflow canvas (React Flow, ARCHITECTURE §10.5), whose palette and node forms are generated from
skill and tool schemas, and pack screens under `src/packs/<id>/`, shown when the pack is enabled. Served
as static assets by `apps/api`. Depends only on `@countersign/core` (route contract and shared types);
every read and write goes through `/api`. Scaffolded in M0 (`docs/plan.md` §4).
