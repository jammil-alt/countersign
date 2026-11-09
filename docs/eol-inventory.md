# End-of-life inventory

Every component we run or build with, when its support ends, and the plan. Reviewed every
quarter (`docs/plaid-plan.md` §7). Anything within 12 months of its end is **flagged**. Started
2026-11-09 from the repo; versions are what `main` pins.

Dates marked *confirm* come from memory of the vendor's announcement; check the vendor's page at
the next review and drop the mark.

## Flagged

| Component | Version | Support ends | Plan |
|---|---|---|---|
| Node.js (build, tests, CI, local dev; `.nvmrc`, `engines`) | 22 | **2027-04-30** | Move to Node 24 (supported to 2028-04-30) before 2027-03. Change `.nvmrc`, `engines`, `@types/node`'s major (held back in `dependabot.yml`) and CI's `setup-node` together. |
| `github/codeql-action` (`.github/workflows/codeql.yml`) | v3 | **December 2026**, deprecated (*confirm*) | Move to v4 with the next CI pull request. |

## Runtimes and services

| Component | Where | Version | Support ends | Plan |
|---|---|---|---|---|
| Cloudflare Workers runtime | `apps/api`, `apps/mfa`, `apps/site` | compatibility date 2026-09-01 | Managed by Cloudflare; old compatibility dates keep working | Move the date forward once a year |
| PostgreSQL (Neon, production and staging) | `bootstrap.yml` | 16 | 2028-11-09 | Plan the move to 17 or later in 2028; Neon upgrades in place |
| PostgreSQL + pgvector (local, CI) | `docker-compose.yml`, `checks.yml` | `pgvector/pgvector:pg16` | follows Postgres 16 | Move with production |
| CI runners | `.github/workflows` | `ubuntu-latest` | Managed by GitHub | None |
| Plaid Link script | `apps/web` (loaded from `cdn.plaid.com`) | `link/v2/stable` | Managed by Plaid | None |

## Tooling

| Component | Version | Support | Plan |
|---|---|---|---|
| pnpm | 11.20.0 | Current major | Dependabot |
| TypeScript | 7 | Current major | Dependabot |
| Wrangler | 4.157.0 | Current major | Dependabot |
| Vitest | 5 (root, web, site); **4** (api, mfa) | Fixes land on the current major | 4 waits for `@cloudflare/vitest-pool-workers` (`dependabot.yml`). Recheck each quarter |
| Biome | 2.5.13 | Pinned to Plenary Labs' version | Moves when theirs does |
| Playwright | 1.64.1 | Current | Dependabot |
| GitHub Actions: `actions/checkout`, `actions/setup-node` | v7 | Current | Dependabot |
| `pnpm/action-setup` | v6 (v6.1.1 pinned by commit in places) | Current | Dependabot |

## Libraries

All on their current major and updated monthly by Dependabot. None publishes a fixed end date:
support is the current major.

| Library | Version |
|---|---|
| Hono | 4 |
| React, React DOM | 19 |
| React Router | 7 |
| Vite | 8 |
| Zod | 4 |
| Drizzle ORM / Drizzle Kit | 0.45 / 0.31 (before 1.0: watch for 1.0) |
| `postgres` | 4 |
| `decimal.js` | 10 |
| `@anthropic-ai/sdk` | 1 |
| `@sentry/cloudflare`, `@sentry/react` | 11 |

## Not yet listed

- Laptops and phones used for work: operating system and version (task 21).
- Anything run outside this repo.
