# Operations

How Countersign is deployed and what a person has to create by hand. Same setup as Plenary Labs:
Cloudflare Workers + Workflows, Neon through Hyperdrive, R2, WorkOS, GitHub Actions.

Status: **nothing is provisioned yet.** The workflows in `.github/workflows/` are in place and stay
inert (they skip deploy and Neon steps with a notice) until the items in §1 exist.

## Environments

| | Staging | Production |
|---|---|---|
| Deployed by | every push to `main` (`deploy.yml`) | a `v*` tag, or Actions → Deploy → production |
| Worker | `countersign-staging` (`wrangler deploy --env=staging`) | `countersign` |
| Neon branch | `staging` | `main` |
| Hyperdrive | `countersign-db-staging` → Neon `staging` as `cs_worker` | `countersign-db` → Neon `main` as `cs_worker` |
| R2 bucket | `countersign-staging` | `countersign` |
| WorkOS | staging environment | production environment |

CI's own throwaway Neon branches are named `ci-run<id>-<attempt>`, copied from `main` and deleted
when the run ends.

## 1. What a person must create

### Neon

1. A project named `countersign`, Postgres 16, in the same region as Plenary Labs. Record its id as
   the GitHub **variable** `NEON_PROJECT_ID`.
2. The database `countersign`, owned by a role `cs_owner` (created in the Neon console; it is the
   owner, so being Neon-managed is fine for it).
3. A branch `staging` from `main`.
4. `cs_worker` is **not** created in the console: Neon-managed roles join `neon_superuser` and would
   skip row-level security. It is created with SQL by `packages/db/scripts/provision-worker-role.mjs`
   (M0), on each branch.
5. An API key (Neon → Account → API keys) as the GitHub **secret** `NEON_API_KEY`.

### Cloudflare

1. R2 buckets `countersign` and `countersign-staging`, plus an R2 API token (S3 access key and
   secret) for signed URLs: Worker secrets `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`.
2. Hyperdrive configs `countersign-db` and `countersign-db-staging`, each pointing at its Neon
   branch as `cs_worker`. Their ids go in `apps/api/wrangler.jsonc` (ids are not secrets).
3. A scoped API token (Workers Scripts edit, Workers R2 edit, Hyperdrive edit, Workflows edit,
   account read) as the GitHub **secret** `CLOUDFLARE_API_TOKEN`, and the account id as the secret
   `CLOUDFLARE_ACCOUNT_ID`.
4. Custom domains for the two Workers. Names still to choose.

### WorkOS

1. Staging and production environments (or reuse Plenary Labs' account with a new application).
2. Redirect URIs: `https://<staging domain>/api/auth/callback` and the production one.
3. Worker secrets per environment: `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`
   (at least 32 random characters).

### Intuit (QuickBooks Online, from M9)

1. An Intuit developer app with the `com.intuit.quickbooks.accounting` scope, a sandbox company, and
   redirect URIs `https://<domain>/api/connections/qbo/callback` per environment.
2. Worker secrets `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_WEBHOOK_VERIFIER`; vars `QBO_ENV`,
   `QBO_REDIRECT_URI`. Production keys need Intuit's app review.

### Google (Gmail, from M10)

1. A Google Cloud project for Countersign with the Gmail API enabled.
2. An OAuth consent screen (external) and a web OAuth client with redirect URIs
   `https://<domain>/api/connections/gmail/callback` per environment (and `http://localhost:8787/...` for
   local development).
3. Scopes `gmail.readonly`, `gmail.labels`, `gmail.compose`. Gmail read scopes are restricted: a public
   app needs Google's verification and a security assessment, which can take weeks, so start it early.
   Until then the app works for a limited set of users with a warning screen, and in "testing" status
   refresh tokens expire after 7 days (clients would have to reconnect weekly). Check the current rules
   (plan M10). For clients on Google Workspace, domain-wide delegation granted by their admin is the
   alternative.
4. Worker secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; var `GOOGLE_REDIRECT_URI`.

### Other Worker secrets (`wrangler secret put <NAME> --env=staging`, from `apps/api`)

`ANTHROPIC_API_KEY`, `ENCRYPTION_KEY` (32 bytes, base64).
`RESEND_API_KEY` only if email is turned on.

### GitHub summary

| Kind | Name |
|---|---|
| Secret | `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Variable | `NEON_PROJECT_ID` |

## 1.1 Onboarding a client (managed service)

Done by an advisor in the app once M5 ships: create the client (tenant) → invite the client admin
(WorkOS invitation) → send connect links for QuickBooks and Gmail; the client admin opens each and grants
access → set the Gmail ingestion query → enable packs (Materials installs Pia) → review and publish the
agents → choose who approves writes (client admin by default, or the advisor).

## 2. What CI does

- **`ci.yml`**: on every non-draft pull request (and by hand), runs `checks.yml`. Drafts cost nothing;
  marking a PR ready runs the check.
- **`checks.yml`**: install, Biome lint, layering check, typecheck, then tests against a Postgres 16 +
  pgvector service container set up with Neon's roles (`scripts/setup-postgres.sh`). With the Neon settings present,
  it also copies `main` to a throwaway branch, applies the migrations to it, and deletes it.
- **`deploy.yml`**: on push to `main` (staging) or a `v*` tag (production): the full check, then
  migrates the target's Neon branch as `cs_owner`, builds `apps/web` and runs `wrangler deploy`.

## 3. Migrations

- Applied by `deploy.yml` before the Worker is deployed, so the new schema is always in place before
  code that needs it. Migrations must therefore keep the previous Worker working (add, then use;
  stop using, then drop).
- Never edit a migration that has reached `staging` or `main`. Add a new one.

## 4. Backups and restore

Neon point-in-time restore covers both branches. To inspect the past without touching production,
create a branch from a timestamp and connect to it directly.
