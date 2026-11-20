# End-of-life inventory

Every component we run or build with, when its support ends, and the plan. The policy:
Dependabot's monthly updates keep libraries and runtimes current, and any end-of-life component is
replaced within 90 days (`docs/policies/information-security.md` §6). This list is reviewed every
quarter (`docs/hipaa-plan.md` §8). Anything within 12 months of its end is **flagged**.

Started 2026-11-09; checked against `main` on 2026-11-20. Versions are what `main` pins.

Dates marked *confirm* are from memory of the vendor's announcement. Check the vendor's page at the
next review and drop the mark.

## Reviews

| Date | By | What changed |
|---|---|---|
| 2026-11-09 | Claude, for the owner | First list |
| 2026-11-20 | Claude, for the owner | Node 24 (#317) and CodeQL action v4 (#315) are on `main`, so their flags are gone. Added the phone and desktop apps, the production scan and the browser service |

## Flagged

| Component | Where | Version | Support ends | Plan |
|---|---|---|---|---|
| Electron | `apps/desktop` | 45 | The latest three majors are supported and a new one comes about every 8 weeks, so 45 leaves support about six months after its release (*confirm*) | Move to the current major before each store build. Not shipped yet (`docs/open.md`) |

## Runtimes and services

| Component | Where | Version | Support ends | Plan |
|---|---|---|---|---|
| Node.js (build, tests, CI, local dev) | `.nvmrc`, `engines`, `@types/node` | 24 | 2028-04-30 | Move to the next even release in 2027 |
| Cloudflare Workers runtime | `apps/api`, `apps/mfa`, `apps/browser`, `apps/site` | compatibility date 2026-09-01 | Managed by Cloudflare; old compatibility dates keep working | Move the date forward once a year |
| PostgreSQL (Neon, production and staging) | `bootstrap.yml` | 16 | 2028-11-09 | Plan the move to 17 or later in 2028; Neon upgrades in place |
| PostgreSQL with pgvector (local, CI) | `docker-compose.yml`, `checks.yml` | `pgvector/pgvector:pg16` | Follows Postgres 16 | Move with production |
| CI runners | `.github/workflows` | `ubuntu-latest` | Managed by GitHub | None |
| Plaid Link script | `apps/web`, loaded from `cdn.plaid.com` | `link/v2/stable` | Managed by Plaid | None |
| Expo SDK and React Native | `apps/mobile` | Expo 58, React Native 0.88 | Expo supports recent SDKs only, and the stores require recent targets (*confirm*) | Move to the current SDK before each store build. Not shipped yet |

## Tooling

| Component | Version | Support | Plan |
|---|---|---|---|
| pnpm | 11.20.0 | Current major | Dependabot |
| TypeScript | 7 | Current major | Dependabot |
| Wrangler | 4.161.0 | Current major | Dependabot |
| Vitest | 5 (root, web, site, desktop, mobile); **4** (api, mfa, browser) | Fixes land on the current major | 4 waits for `@cloudflare/vitest-pool-workers` to support 5 (`.github/dependabot.yml`). Recheck each quarter |
| Biome | 2.5.13 | Pinned to Plenary Labs' version | Moves when theirs does |
| Playwright | 1.65.0; `@cloudflare/playwright` 1.4.0 (`apps/browser`) | Current | Dependabot |
| electron-builder | 26.18.0 (`apps/desktop`, run with `pnpm dlx`) | Current major | Bump by hand with Electron |
| GitHub Actions: `actions/checkout`, `actions/setup-node` | v7 | Current | Dependabot |
| `github/codeql-action` | v4 | Current | Dependabot |
| `google/osv-scanner-action` | v2.7.1, pinned by commit | Current | Dependabot |
| `pnpm/action-setup` | v6.1.1, pinned by commit | Current | Dependabot |
| `zaproxy/action-baseline` | v0.14.0, pinned by commit | Current | Dependabot |

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
| Drizzle ORM, Drizzle Kit | 0.45, 0.31 (before 1.0: watch for 1.0) |
| `postgres` | 4 |
| `decimal.js` | 10 |
| `@sentry/cloudflare`, `@sentry/react` | 11 |

The model clients (`packages/llm`) call each vendor's HTTP API directly, with no SDK. A vendor
retiring a model or an API version is handled there, not here.

## Not yet listed

- Laptops and phones used for work: operating system and version. The policy asks for current
  updates (`docs/policies/information-security.md` §4); devices are not yet checked and recorded
  (control GOV-6).
- Anything run outside this repo.
