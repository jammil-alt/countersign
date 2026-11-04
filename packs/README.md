# Packs

A pack bundles a business domain on top of the platform: tools, skills, event types, tables, API routes,
screens and template agents with their workflows (ARCHITECTURE §12). The platform never imports a pack;
`apps/api` registers packs and `apps/web` shows a pack's screens (`src/packs/<id>/`) when it is enabled
for the tenant.

| Pack | What |
|---|---|
| `materials/` | Material cost management: catalog and cross-vendor item matching (M8a), prices, the six alert rules, Price watch and Catalog reports, the match review card, and the template agent Pia with the `purchase-intake` and `weekly-price-review` workflows (M8b; `src/pia.ts`). Its tables are in the shared migration sequence (0006); its alerts use the platform's `alert` table (0007). `pnpm seed:demo-prices` gives the demo client six months of prices. |

A pack may import `core`, `db`, `llm`, `senses`, `documents` and `connectors`; never `agents` or
`workflows` (`scripts/check-deps.mjs`).
