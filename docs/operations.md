# Operations

How Mezonas is deployed and what a person has to create by hand. It follows the same setup
patterns as Plenary Labs (Cloudflare Workers + Workflows, Neon through Hyperdrive, R2, WorkOS, GitHub
Actions) but shares nothing with it: its own Neon project, Workers, buckets, WorkOS application, keys
and secrets.

Status: **nothing is provisioned yet.** Next: add the bootstrap keys (§1), run Actions → Bootstrap
cloud, save `NEON_PROJECT_ID`. Until then CI and deploy skip their Neon and deploy steps with a notice.

## Environments

Mezonas is the product name and the name of every public resource; `countersign` stays the code name
(repo, packages, database, roles). The domains are on the **mezonas.com** zone, already in Cloudflare.

| | Staging | Production |
|---|---|---|
| Deployed by | every push to `main` (`deploy.yml`) | a `v*` tag, or Actions → Deploy → production |
| Address | `https://staging.mezonas.com` | `https://app.mezonas.com` |
| Worker | `mezonas-staging` (`wrangler deploy --env=staging`) | `mezonas` (`--env=production`) |
| Neon project / branch | `mezonas` / `staging` | `mezonas` / `main` |
| Hyperdrive | `mezonas-db-staging` → `staging` as `cs_worker` | `mezonas-db` → `main` as `cs_worker` |
| R2 bucket | `mezonas-staging` | `mezonas` |
| Email forwarding | `in.staging.mezonas.com` | `in.mezonas.com` |
| WorkOS | staging environment | production environment |

`apps/api/wrangler.jsonc`'s top level is local development only (dev sign-in) and is never deployed:
`deploy.yml` always passes `--env=staging` or `--env=production`. The custom domains are created by
`wrangler deploy` (`custom_domain: true`); the apex `mezonas.com` stays free for a marketing site, and
other records on the zone (e.g. `datum.mezonas.com`) are untouched.
// DECISION: app on `app.mezonas.com`, staging on `staging.mezonas.com` (owner to confirm).

CI's own throwaway Neon branches are named `ci-run<id>-<attempt>`, copied from `main` and deleted
when the run ends.

## 1. What a person must create

Most of Neon and Cloudflare is created by the **Bootstrap cloud** workflow (`.github/workflows/bootstrap.yml`,
Actions → Bootstrap cloud → Run workflow). A person only provides the keys and does what needs a
dashboard.

### Keys for the bootstrap (GitHub → Settings → Secrets and variables → Actions)

1. **Neon API key** (Neon → account menu → Account settings → API keys, or an organization's API key
   if Mezonas should live in a Neon organization) as the secret `NEON_API_KEY`.
2. **Cloudflare API token** with Hyperdrive edit, Workers R2 Storage edit, Workers Scripts edit,
   Workflows edit and account read, plus Zone · Workers Routes edit and Zone · DNS edit on
   `mezonas.com` (for the custom domains), as the secret `CLOUDFLARE_API_TOKEN`; the account id as the secret
   `CLOUDFLARE_ACCOUNT_ID`. The same token is used by `deploy.yml`.

### What the bootstrap creates (re-runnable; it looks before it creates)

1. The Neon project `mezonas`, Postgres 16, in the region given when running the workflow (the owner
   chose the same region Plenary Labs uses; it's shown in that project's settings in the Neon console),
   unless the `NEON_PROJECT_ID` variable already names one.
2. Role `cs_owner` (Neon-managed is fine for the owner) and database `countersign` on `main`; branch
   `staging` from `main`.
3. On each branch, with SQL: `cs_runtime` (NOLOGIN) and `cs_worker` (LOGIN, member of `cs_runtime` only).
   `cs_worker` is never created through Neon's console or API: Neon-managed roles join `neon_superuser`
   and would skip row-level security. Each run gives it a new random password per branch, which exists
   only inside the job and in Hyperdrive.
4. Hyperdrive `mezonas-db` (→ Neon `main` as `cs_worker`) and `mezonas-db-staging` (→ `staging`).
5. R2 buckets `mezonas` and `mezonas-staging`.

After the first run: save the project id from the run summary as the repository **variable**
`NEON_PROJECT_ID`, and the Hyperdrive ids go in `apps/api/wrangler.jsonc` (M0; ids are not secrets).

### By hand

1. **R2 S3 credentials** for signed URLs (Cloudflare → R2 → Manage API tokens): Worker secrets
   `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`.
2. **Custom domains**: nothing by hand. `wrangler deploy` creates `staging.mezonas.com` and
   `app.mezonas.com` on the `mezonas.com` zone; make sure no existing DNS record uses those names.
3. **Email forwarding** (when the forwarding connector is built): Cloudflare Email Routing on the
   `in.mezonas.com` and `in.staging.mezonas.com` subdomains of the `mezonas.com` zone, each with a
   catch-all rule sending to its Worker (`mezonas` / `mezonas-staging`). Worker var
   `EMAIL_FORWARDING_DOMAIN`.
4. **WorkOS**: Mezonas' own staging and production environments; redirect URIs
   `https://staging.mezonas.com/api/auth/callback` and `https://app.mezonas.com/api/auth/callback`;
   Worker secrets `WORKOS_CLIENT_ID`,
   `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD` (at least 32 random characters).

### Intuit (QuickBooks Online, from M9)

1. An Intuit developer app with the `com.intuit.quickbooks.accounting` scope, a sandbox company, and
   redirect URIs `https://<domain>/api/connections/qbo/callback` per environment.
2. Worker secrets `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_WEBHOOK_VERIFIER`; vars `QBO_ENV`,
   `QBO_REDIRECT_URI`. Production keys need Intuit's app review.

### Google (Gmail, from M10)

1. A Google Cloud project for Mezonas with the Gmail API enabled.
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

Done by the operator in the back office once M5–M6 ship: create the client → invite the client admin
(WorkOS invitation) → offer the QuickBooks and Gmail connectors and set their permission matrices; the
client admin signs in to each from the portal's Connections page (we never handle their credentials) →
set the Gmail ingestion query → enable packs → fork templates into the client (e.g. Pia) and customize them for the client's data and
flows, bind the client's connections → test-run on the client's data → publish and activate → choose who
approves writes (client admin by default, or the operator).

## 2. What CI does

- **`ci.yml`**: on every non-draft pull request (and by hand), runs `checks.yml`. Drafts cost nothing;
  marking a PR ready runs the check.
- **`checks.yml`**: install, Biome lint, layering check, typecheck, then tests against a Postgres 16 +
  pgvector service container set up with Neon's roles (`scripts/setup-postgres.sh`). With the Neon settings present,
  it also copies `main` to a throwaway branch, applies the migrations to it, and deletes it.
- **`bootstrap.yml`**: by hand only; creates or updates the Neon project, branches and roles, Hyperdrive
  configs and R2 buckets (§1). Safe to re-run; each run rotates `cs_worker`'s passwords.
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
