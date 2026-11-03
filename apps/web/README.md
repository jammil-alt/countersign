# apps/web

React + Vite + React Router single-page app with two surfaces: the **back office** (`/ops`, operator; its
bundle, including the workflow builder, is code-split) and the **client portal**. The screens are in ARCHITECTURE §15, built from the owner's
designs (`docs/design/`) on the Groundwork design system (tokens from `docs/design/tokens.css`, Tailwind +
shadcn primitives). Includes the workflow builder (a nested sortable list with dnd-kit, ARCHITECTURE
§10.5), whose palette and step forms are generated from skill and tool schemas, and pack screens under `src/packs/<id>/`, shown when the pack is enabled. Served
as static assets by `apps/api`. Depends only on `@countersign/core` (route contract and shared types);
every read and write goes through `/api`. Scaffolded in M0 (`docs/plan.md` §4).

## Layout

| Path | What |
|---|---|
| `src/App.tsx` | Router, sign-in gate, and the lazy `/ops` chunk (loaded only after the operator check). |
| `src/api/` | `client.ts` (typed calls from route specs: body checked, response Zod-parsed, `ApiError`), `useApi.tsx` (load hook, `ApiProvider`), `routes.ts` (routes not yet in packages/core, mirroring apps/api's names and paths; delete each once core has it). |
| `src/session/` | Session context over `GET /api/session`, dev sign-in screen. |
| `src/shell/` | The frame both surfaces share: header (mark, context slot, command bar placeholder, inbox, avatar) and sidebar parts. |
| `src/ops/` | Back office: layout with the client switcher, clients, client, agent page (tabs), read-only workflow step list. |
| `src/portal/` | Client portal: layout and overview. |
| `src/ui/` | Groundwork primitives (badge, button, card, avatar, tabs, notices). |
| `src/styles.css`, `src/styles/tokens.css` | Tailwind v4 with the Groundwork tokens as its only colours (`bg-card`, `text-secondary`, `border-edge`, `bg-tone-accent`, `bg-persona-*`). `tokens.css` is a copy of `docs/design/tokens.css`. |

`biome.json` here only turns on Biome's Tailwind CSS syntax (`@theme`, `@utility`) for this app.
