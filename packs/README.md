# Packs

A pack bundles a business domain on top of the platform: tools, skills, event types, tables, API routes,
screens and template agents with their workflows (ARCHITECTURE §12). The platform never imports a pack;
`apps/api` registers packs and `apps/web` shows a pack's screens (`src/packs/<id>/`) when it is enabled
for the tenant.

| Pack | What |
|---|---|
| `materials/` | Material cost management: catalog and cross-vendor item matching (M8a), prices, the six alert rules, Price watch and Catalog reports, the match review card, and the template agent Pia with the `purchase-intake` and `weekly-price-review` workflows (M8b; `src/pia.ts`). Its tables are in the shared migration sequence (0006); its alerts use the platform's `alert` table (0007). `pnpm seed:demo-prices` gives the demo client six months of prices. |
| `sales/` | The Sales area's first version (docs/plan.md §1.164): record keys built from the client's synced Zoho leads, contacts, accounts and deals (after each sync page), their embeddings, `sales.match_records` (keys, aliases, text, meaning, a small model, then a person), the look-up and a person's decision with its alias. Tables in migration 0072; goldens in `fixtures/matching/crm`. |

A pack may import `core`, `db`, `llm`, `senses`, `documents` and `connectors`; never `agents` or
`workflows` (`scripts/check-deps.mjs`).

## A new pack (docs/plan.md §1.230)

Every pack's manifest is core's `PackManifest` (its comments say what each field is): `id`, `name`,
`area`, its `config` fields with their defaults, `processors` (vendors of ours it sends data to),
`connections`, `tools`, `skills`, `events`, `templates` (approval on in every writing step),
`screens` and `reports`. Register it in `apps/api/src/packs.ts` with its handlers, reports and
reviews, and the operator installs it from the client page's Areas tab with configuration only.
The pack reads a client's configuration with `packConfigOf(manifest.config, tenant.settings, id)`.
