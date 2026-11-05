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
| Code service Worker (apps/mfa) | `mezonas-codes-staging` | `mezonas-codes` |
| Code service address (Twilio's webhooks only) | `https://codes-staging.mezonas.com` | `https://codes.mezonas.com` |
| Agent email (code service) | `agents.staging.mezonas.com` | `agents.mezonas.com` |
| WorkOS | staging environment | production environment |

`apps/api/wrangler.jsonc`'s top level is local development only (dev sign-in) and is never deployed:
`deploy.yml` always passes `--env=staging` or `--env=production`. The custom domains are created by
`wrangler deploy` (`custom_domain: true`); the apex `mezonas.com` stays free for a marketing site, and
other records on the zone (e.g. `datum.mezonas.com`) are untouched.
App on `app.mezonas.com`, staging on `staging.mezonas.com` (owner, 2026-11-03).

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
   chose the same region Plenary Labs uses, `aws-us-east-2`, which is the workflow's default),
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

1. **R2 S3 credentials** for signed URLs (Cloudflare → R2 → Manage API tokens, read-only on the
   environment's bucket): Worker secrets `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, plus
   `STORAGE_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`) and `STORAGE_BUCKET`. Optional:
   without them the Worker signs its own 5-minute links (`/api/files/:token`, keyed from
   `ENCRYPTION_KEY`) and streams the file from the R2 binding (`apps/api/src/storage.ts`).
2. **Custom domains**: nothing by hand. `wrangler deploy` creates `staging.mezonas.com` and
   `app.mezonas.com` on the `mezonas.com` zone; make sure no existing DNS record uses those names.
3. **Email forwarding** (built: stream D, `apps/api/src/email.ts`). For each environment:
   - Cloudflare → `mezonas.com` → Email → Email Routing: add the subdomain (`in.staging.mezonas.com`,
     `in.mezonas.com`) and let Cloudflare add its MX and SPF records for it. Nothing else on the zone
     changes; mail for `mezonas.com` itself is not routed.
   - Routing rules → **Catch-all address** for that subdomain → action **Send to a Worker** → `mezonas-staging`
     (staging) or `mezonas` (production). No custom addresses: every client's address is
     `<client label>-<26 characters>-<8 characters>@<subdomain>`, made by the app, and the Worker drops
     anything that is not exactly a client's current address.
   - Worker var `EMAIL_FORWARDING_DOMAIN` = that subdomain, in the environment's `vars` in
     `apps/api/wrangler.jsonc` (`in.staging.mezonas.com` / `in.mezonas.com`). Until it is set, the
     portal says forwarding isn't switched on and `email()` drops everything.
   - No binding: inbound mail reaches the Worker's `email()` export without one. (`send_email` is only
     for sending, which v1 doesn't do.)
   - Check: the portal's Connections page shows the client's address; mail from an allowed sender with
     a PDF shows up under Recent documents as "Forwarded"; the Worker logs `forwarded email dropped:
     <reason>` for the rest. Messages over 25 MB are dropped (Email Routing's limit).
4. **The code service** (Access phase 2, `apps/mfa`; ARCHITECTURE §6.9). See the checklist under
   "The code service" below.
5. **WorkOS**: Mezonas' own staging and production environments; redirect URIs
   `https://staging.mezonas.com/api/auth/callback` and `https://app.mezonas.com/api/auth/callback`;
   Worker secrets `WORKOS_CLIENT_ID`,
   `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD` (at least 32 random characters).

### The code service (Access phase 2)

A Worker of its own (`apps/mfa`) that receives second-factor codes for agents' accounts on other
sites and hands each one, once, to a sign-in in progress. It has its own key, its own Durable Object
storage and its own Twilio subaccount; apps/api reaches it only through the `CODES` service binding.
`deploy.yml` deploys it before apps/api, creates its Durable Objects (migration `v1`) and its custom
domain, and generates `MFA_ENCRYPTION_KEY` once. What a person does, per environment:

- [ ] **Confirm the names.** The domains in the table above are placeholders until the owner
      confirms them (`apps/mfa/wrangler.jsonc`, `vars` and `routes`). Make sure no DNS record already
      uses `codes-staging.mezonas.com`, `codes.mezonas.com` or the `agents` subdomains.
- [ ] **Deploy once** (a push to `main` for staging), so the Worker exists before the next steps.
- [ ] **Email Routing for the agent domain.** Cloudflare → `mezonas.com` → Email → Email Routing: add
      the subdomain (`agents.staging.mezonas.com` / `agents.mezonas.com`) and let Cloudflare add its MX
      and SPF records. Routing rules → **Catch-all address** for that subdomain → **Send to a Worker** →
      `mezonas-codes-staging` / `mezonas-codes`. Every identity's address is `agent-<12 characters>@`
      that subdomain; the Worker drops anything else, without a bounce.
- [ ] **The codes Twilio subaccount.** In Mezonas' Twilio account, create a subaccount for codes per
      environment (e.g. "Mezonas codes (staging)"), separate from the subaccounts clients text from.
      Put its own Account SID and Auth Token in the GitHub environment as `MFA_TWILIO_ACCOUNT_SID` and
      `MFA_TWILIO_AUTH_TOKEN`, then redeploy. Numbers are bought by the service only when an identity
      needs one (US local numbers, a monthly cost each) and released when the identity is deleted.
      Without these secrets, email and authenticator codes still work; adding a phone answers
      `not_configured`.
- [ ] **Check the assumptions** in `apps/mfa/NOTES.md`, "To verify", with real messages: an email
      from a domain with DMARC to an identity's address should log `email.received` with `spf`,
      `dkim` and `dmarc` all true (Workers logs of the code service); a text to an identity's number
      should log `sms.received`. Logs never contain codes.
- [ ] **Email codes stay off until verified.** `EMAIL_CODES` is `off` in `apps/mfa/wrangler.jsonc`
      for every environment: emailed codes never fill a wait and an email wait answers "email codes
      are off until verified" (texts and authenticator codes work). To turn them on for an
      environment, follow `apps/mfa/NOTES.md`, "Turning email codes on":
      1. a genuine message from a domain with DMARC logs `spf`, `dkim` and `dmarc` all true;
      2. a message sent with a forged `Authentication-Results: mx.cloudflare.net; spf=pass;
         dkim=pass; dmarc=pass header.from=<domain>` header at the top, from a domain that fails
         DMARC for that sender, logs `dmarc` false and fills no wait;
      3. only then set `"EMAIL_CODES": "on"` in that environment's `vars`, in a reviewed PR, and
         note the date and who checked in `docs/plan.md` §1.26. If step 2 passes as authentic,
         leave it off.
- Nothing else by hand: there is no database, bucket or Hyperdrive for the code service, and
  `MFA_ENCRYPTION_KEY` is never set by a person. Replacing it would make stored authenticator secrets
  unreadable (rotation is not built yet; `apps/mfa/NOTES.md`).

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

### Worker secrets (set by `deploy.yml`, never by hand)

The deploy workflow loads the Worker's secrets into Cloudflare after each deploy:
- `WORKOS_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`: copied from the GitHub **environment** (`staging` or
  `production`) on every deploy, so rotating a key is "update the GitHub secret, redeploy".
- `ENCRYPTION_KEY` (32 random bytes, base64) and `WORKOS_COOKIE_PASSWORD`: generated once inside the job
  when the Worker doesn't have them yet, and never shown or stored anywhere else. If the job can't read
  the Worker's existing secrets it stops instead of generating, so `ENCRYPTION_KEY` is never replaced by
  accident (replacing it would make stored connection credentials unreadable; rotation is described in
  `packages/connectors/src/credentials.ts`).
- The code service (`mezonas-codes-staging` / `mezonas-codes`) gets its own secrets, in its own
  step before apps/api deploys: `MFA_TWILIO_ACCOUNT_SID` and `MFA_TWILIO_AUTH_TOKEN` (the codes
  subaccount) copied when set, and `MFA_ENCRYPTION_KEY` (32 random bytes, base64) generated once
  inside the job exactly as `ENCRYPTION_KEY` is, never replacing an existing one. apps/api never has
  these, and the code service never has apps/api's.
- Later: `QBO_*` and `GOOGLE_*` when those connectors are built, the same way.
- Needed by the Zoho CRM connector (stream G, 2026-11-04; wiring them into `deploy.yml` is the
  coordinator's): `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` (a Server-based client in Zoho's API console,
  multi-DC on, redirect URI `<APP_ORIGIN>/connections/zoho_crm/callback`) copied like the API keys, and
  `OAUTH_STATE_SECRET` (48 random bytes, base64) generated once like `ENCRYPTION_KEY`; replacing it only
  breaks sign-ins in progress. Until all three are set, Zoho CRM shows "Not available yet" in the portal.
  Webhooks need no secret beyond `ENCRYPTION_KEY`.
- Needed by the Podio connector, the same way: `PODIO_CLIENT_ID`, `PODIO_CLIENT_SECRET` (an API key
  from Podio's account settings, its domain set to the app origin, redirect URI
  `<APP_ORIGIN>/connections/podio/callback`).
- Needed for texts and WhatsApp (plan §1.22; wiring into `deploy.yml` is the coordinator's):
  `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` of Mezonas' own Twilio account, copied like the API
  keys. They only make each client's subaccount; the subaccounts' tokens are encrypted in the
  clients' connections. `APP_ORIGIN` must be set, since Twilio is pointed at
  `<APP_ORIGIN>/api/twilio/<client>/messages` and `/status` and signs requests over those URLs.
  What to check in Twilio before a client goes live: `packages/connectors/src/twilio/NOTES.md`.
- Needed for calls (plan §1.23; wiring into `deploy.yml` is the coordinator's): `ELEVENLABS_API_KEY`
  (Mezonas' ElevenLabs workspace, Conversational AI) and `ELEVENLABS_WEBHOOK_SECRET` (the signing
  secret of ElevenLabs' post-call webhook, pointed at `<APP_ORIGIN>/api/elevenlabs/post-call`; it
  also keys each call's tool token). Calls use the Twilio secrets above and `APP_ORIGIN` (Twilio is
  pointed at `<APP_ORIGIN>/api/twilio/<client>/voice`, `/voice/answer` and `/voice/status`; the voice
  agents' tools at `<APP_ORIGIN>/api/voice/<client>/tools/…`). Without the ElevenLabs secrets, calls
  ringing in still reach voicemail or the forward, and no agent places a call. What to check first:
  `packages/connectors/src/elevenlabs/NOTES.md`.
- Needed by billing (stream J, 2026-11-04; wiring them into `deploy.yml` is the coordinator's), copied
  like the API keys: `STRIPE_SECRET_KEY` (Mezonas' own Stripe account, a restricted or secret key; test
  mode on staging, live mode on production) and `STRIPE_WEBHOOK_SECRET` (the `whsec_…` signing secret of
  the webhook endpoint `https://<domain>/api/billing/stripe/webhook`). Without the key billing is off;
  without the webhook secret Stripe's events are refused. Allow `api.stripe.com` in the network if it is
  restricted. Stripe set-up steps: `packages/connectors/src/stripe/NOTES.md`.
- Needed for email reach-outs (plan §1.25; wiring into `deploy.yml` is the coordinator's):
  `RESEND_API_KEY` (Mezonas' Resend account: it only makes each client's domain and a sending key
  restricted to it, which is encrypted in the client's `resend` connection),
  `RESEND_FALLBACK_DOMAIN` (our own verified sending domain, e.g. `mail.mezonas.com`, used until a
  client's domain is verified) and `RESEND_FALLBACK_DOMAIN_ID` (Resend's id for it, so fallback keys
  can send only from it). Replies come back through `EMAIL_FORWARDING_DOMAIN` to each client's
  forwarding address. What to check first: `packages/connectors/src/resend/NOTES.md`.

### GitHub summary

| Kind | Where | Name |
|---|---|---|
| Repository secret | Settings → Secrets and variables → Actions | `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Repository variable | same page, Variables tab | `NEON_PROJECT_ID` |
| Environment secret | Settings → Environments → `staging` / `production` | `WORKOS_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (one per environment; a repository secret also works) |
| Environment secret (when each provider is set up) | same place | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (texts and calls), `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET` (calls), `RESEND_API_KEY` (email), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (billing): the deploy copies each into the Worker only when it is set |
| Environment secret (the code service) | same place | `MFA_TWILIO_ACCOUNT_SID`, `MFA_TWILIO_AUTH_TOKEN`: the codes Twilio subaccount, copied into the code service's Worker only |
| Environment variable (email) | Settings → Environments → Variables | `RESEND_FALLBACK_DOMAIN`, `RESEND_FALLBACK_DOMAIN_ID`: our own sending domain until a client's is verified; passed to the Worker as vars |

### Error tracking (Sentry)

Errors from the Worker (API routes, the cron, `RunWorkflow`) and from the browser go to Sentry
org `twelve-thirty-four-consulting`, projects **`mezonas-api`** and **`mezonas-web`** (separate
from Plenary Labs' projects; nothing is shared but the Sentry account). Off wherever no DSN is
given: local development and tests never send.

| GitHub | Name | What |
|---|---|---|
| Repository variable (or secret) | `SENTRY_DSN_API` | mezonas-api's DSN; the deploy passes it to the Worker as `SENTRY_DSN` |
| Repository variable (or secret) | `SENTRY_DSN_WEB` | mezonas-web's DSN; built into the page as `VITE_SENTRY_DSN` |
| Repository secret | `SENTRY_AUTH_TOKEN` | Uploads source maps for each release (the commit) |
| Repository variables (optional) | `SENTRY_ORG`, `SENTRY_PROJECT_API`, `SENTRY_PROJECT_WEB` | Default to the names above |

DSNs are not secrets (they only let a client send events). What is sent is held to what
debugging needs: no request bodies, cookies, headers but the user agent, query strings, emails,
IPs, model inputs or outputs, database query values or local variables; messages are cut short
and anything shaped like a key or token is removed (`apps/api/src/observability/sentry.ts`,
`apps/web/src/observability.ts`, with tests).

### The first operator

A fresh environment has no users, and sign-in only admits invited addresses, so the first operator
is invited from GitHub: Actions → **Add operator** → target, email (the address you sign in to
WorkOS with), name. It creates an `app_user` row that your first WorkOS sign-in with that verified
email claims, and an operator membership in every client. On staging it can run the seed first
(Sandbox and Demo clients, the platform templates); the seed never runs on production. Safe to run
again, e.g. after new clients exist.

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
  migrates the target's Neon branch as `cs_owner`, deploys the code service (`apps/mfa`) and its
  secrets, builds `apps/web` and runs `wrangler deploy` for apps/api (whose `CODES` binding needs the
  code service deployed first).

## 3. Migrations

- Applied by `deploy.yml` before the Worker is deployed, so the new schema is always in place before
  code that needs it. Migrations must therefore keep the previous Worker working (add, then use;
  stop using, then drop).
- Never edit a migration that has reached `staging` or `main`. Add a new one.

## 4. Backups and restore

Neon point-in-time restore covers both branches. To inspect the past without touching production,
create a branch from a timestamp and connect to it directly.
