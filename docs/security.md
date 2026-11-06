# Security at Mezonas

What protects our clients' data today, where it lives in the code, and which settings we keep
outside the code. It is the record behind HIPAA, SOC 2 and PCI DSS; what is still open is in
`docs/hipaa-plan.md`. The design and its decisions are in `docs/plan.md` §1.35 (owner, 2026-11-05).

Status, 2026-11-06:
- The settings outside the code are all in place (table below).
- The code is in four pull requests, not yet merged: #81, #82, #83 and #84.
- Until they merge, the controls marked **(in PR)** exist only on their branches, not on staging.

Until #82 and #84 merge, `docs/plan.md` §1.35 and `docs/operations.md` §1.2 exist only on their
branches.

## 1. Client isolation

- Every client (tenant) table has a `tenant_id` and **forced row-level security** on
  `app.tenant_ids` (CLAUDE.md invariant 1).
- The Worker connects as `cs_worker`, a role that can't bypass row-level security. It reads client
  data only inside `withTenant()` and `withOperator()`.
- Portal sessions and runs see exactly one client. Operator sessions see only the clients the
  operator serves.
- What agents learn (memory, aliases, catalogs) stays with its client. Forks and promotions never
  carry one client's data to another.
- Tests: `packages/db/src/rls.test.ts`, and the contract tests in `apps/api`.

## 2. Who can sign in, and for how long

- Sign-in is through **WorkOS AuthKit**. Only invited, verified email addresses get in.
- **Multi-factor authentication is required** in WorkOS, for email and password sign-ins (§10).
- **Sessions end after 30 minutes without the person's own activity and 12 hours after sign-in**
  (in PR #83).
  - Our sealed cookie (`__Host-`, HttpOnly, Secure) records the last activity.
  - Only requests the person made count. The app marks them after a key press, click or touch, so
    background polling never keeps an unattended session alive.
  - The app also signs out by itself.
  - An idle or expired session also ends WorkOS's session, so signing in again asks for the
    password and the second factor.
- A sign-in must finish within **30 minutes** of starting, and only with the state cookie
  (`__Host-`, HttpOnly, Secure, SameSite=Lax) that matches the `state` WorkOS sends back. A
  failed finish starts sign-in again once by itself, or goes to the app if the person is already
  signed in; it never creates a session. Each refusal is in the audit log with its reason.
- WorkOS sessions are capped at the same 12 hours and 30 minutes. That also covers the Ops MCP
  connector, which signs in with 5-minute WorkOS access tokens instead of our cookie.
- Roles are `operator`, `client_admin` and `client_user`. Only operators reach `/api/ops` and the
  MCP connector. Portal routes never return agent definitions, prompts or costs.
- Code: `packages/auth`, `packages/core/src/security/session-limits.ts`,
  `apps/web/src/session/activity.ts`.

## 3. The audit log (in PR #82 and #84)

- `audit_event` records **who read or changed what, when and from where**:
  - every request to a session route, reads included;
  - every back-office call made through the Ops MCP connector;
  - every sign-in, refused sign-in and sign-out;
  - system actions such as file purges.
- Each row holds the person, their role, the client, the action, the outcome, the ids involved,
  the IP and the browser. Never record content.
- It can't be changed. The runtime can only insert and read; a trigger refuses updates and
  deletes for everyone. Rows are isolated per client like any client data.
- It's kept 6 years.
- Operators read it at `/ops/audit`, with filters and a CSV export of the access review: every
  user, their roles and when they were last seen.
- Agents' own work has its own trail: runs, steps, tool calls and every write to a client's tool
  (`external_action`, with its before state and who approved it).
- Code: `apps/api/src/audit.ts`, `apps/api/src/http.ts` (`mount`, `invokeRoute`),
  `apps/api/src/routes/compliance.ts`, migration `0017_audit_log.sql`.

## 4. Encryption

- **In transit:** HTTPS only (Cloudflare "Always Use HTTPS"), TLS 1.2 minimum, and HSTS for two
  years from the app itself. Neon is reached through Hyperdrive over TLS.
- **At rest:** Neon and R2 encrypt everything they store (AES-256).
- **Connection secrets** (OAuth tokens, API keys, browser logins):
  - encrypted with each client's own data key, which is wrapped by `ENCRYPTION_KEY`;
  - write-only, and never shown to anyone, the operator included;
  - never given to a model; tool code gets them for one step (invariant 13).
- **Second-factor codes** live only in the separate code service (`apps/mfa`), with its own key.

## 5. Where client data may go

- **HIPAA mode, per client** (in PR #84). A client whose records hold health information is put in
  HIPAA mode by an operator, with a reason. Its data then goes only to vendors listed in
  `BAA_PROCESSORS` (`apps/api/wrangler.jsonc`). That list is empty until BAAs are signed, so no
  client can be in HIPAA mode yet.
- What HIPAA mode refuses:
  - turning it on while a connector that needs an uncovered vendor is offered;
  - offering such a connector;
  - model calls to an uncovered provider (in runs, reach-outs and background document reading);
  - tool calls that need an uncovered vendor, such as texts, WhatsApp, calls or our sending email.
- The list of which feature sends data to which vendor is
  `packages/core/src/compliance/processors.ts` (invariant 14).
- **Card numbers** (in PR #84):
  - Mezonas never takes card data: billing uses Stripe-hosted invoices, and payment sites are
    blocked for browser logins.
  - A card number that arrives anyway is stored as `[card ending 1234]`. That applies to
    documents, texts and error reports.
- **Untrusted text stays data.** Document, email and web page text reaches models only as tool
  results, never as instructions (invariant 9).
- **Email stays narrow:** only matching messages are synced, and bodies are fetched on demand
  (invariant 12).
- **Error reports** (Sentry) carry no request bodies, cookies, emails, IPs, model input or output,
  query values, keys or card numbers (`apps/api/src/observability/sentry.ts`,
  `apps/web/src/observability.ts`).

## 6. The app and its network

- **Security headers** on every API and MCP answer (in PR #84): `Cache-Control: no-store`,
  `nosniff`, no framing, HSTS, and a strict CSP. The app's pages get a CSP that allows only our own
  origin and Sentry (`apps/web/public/_headers`). Checked in Chromium on operator and client pages.
- **Rate limiting** (Cloudflare): 50 requests per 10 seconds per IP on `/api/*`, webhooks
  excluded. The MCP connector has its own limit of 120 calls a minute per operator.
- **Writes to clients' tools** need approval by default, run once each, and record their before
  state (invariant 8). Delete is off.
- **Webhooks** from Twilio, Stripe, QuickBooks and ElevenLabs are signature-checked.

## 7. Changes, code and dependencies

- Every change is a pull request.
  - `main` is protected: a pull request, passing checks and CodeQL are required, and force
    pushes and deletion are blocked.
  - Only the admin can bypass it.
- CI runs lint, the layering check, typecheck and every test, and applies every migration to its
  own Postgres. It **never connects to Neon**, so client data never reaches a CI runner (in PR
  #81). Migrations meet real rows on staging first, in a transaction, before production.
- **CodeQL** (security queries) runs on pull requests, on `main` and weekly (in PR #81).
- **Dependabot** sends alerts and security updates, plus monthly grouped version updates (one pull request per ecosystem).
- **Secret scanning** with push protection is on.
- Migrations, CI changes and sign-in changes each get their own pull request, so each can be
  reverted alone.

## 8. Backups and recovery

- Neon keeps **7 days** of point-in-time history on the production project. A restore is tested
  every quarter (`docs/operations.md` §4).
- Original documents in R2 are written once and never changed.

## 9. When a client leaves (in PR #84)

1. **Retire it** from the back office, with a reason and the client's name typed again. Then:
   - its users can no longer sign in;
   - its agents are retired, and no run starts;
   - its tools are disconnected, with grants revoked at the provider and credentials deleted.
2. **30 days later**, the hourly cron deletes its files from R2.
3. **The owner then purges its rows** with `db:purge-client`. The audit log keeps its ids.
4. **Data at other vendors** (Twilio, ElevenLabs, Resend, Stripe) is closed by hand from the
   checklist in `docs/operations.md` §1.2.

## 10. Settings outside the code

Set by the owner on 2026-11-06 (the owner confirmed WorkOS the same day), with Claude in Chrome
finding each setting.

| Where | Setting | Value |
|---|---|---|
| WorkOS, staging and production | Multi-factor auth (Authentication → Features) | Required for non-SSO sign-ins (was disabled) |
| WorkOS, staging and production | Session lifetime (Applications → app → Sessions) | 12 hours; 30 minutes inactivity (was 365 days; 2 days); access tokens 5 minutes |
| Cloudflare, `mezonas.com` | Rate limiting rule "API rate limit" | `/api/*` minus webhook paths; 50 per 10 s per IP; block 10 s |
| Cloudflare, `mezonas.com` | Always Use HTTPS | On |
| Cloudflare, `mezonas.com` | Minimum TLS version | 1.2 (1.3 enabled) |
| Cloudflare, `mezonas.com` | Encryption mode, Cloudflare HSTS | Unchanged: Full (automatic); off, since the app sends HSTS |
| GitHub, `countersign` | Dependency graph, Dependabot alerts and security updates, secret scanning, push protection | On |
| GitHub, `countersign` | CodeQL Default setup | Off (we run `codeql.yml`) |
| GitHub, `countersign` | Ruleset "Protect main" | PR required; `checks / check`, `checks / static`, `analyze`; no force push or delete; admin bypass |
| Neon, `mezonas` (Launch) | History window (Settings → Postgres) | 7 days (was 1) |

## 11. Our vendors

These are the vendors that receive client data, and how. Whether each will sign a BAA is tracked
in `docs/hipaa-plan.md`.

| Vendor | What it gets | Id in `BAA_PROCESSORS` |
|---|---|---|
| Cloudflare | All traffic; Workers, R2 files, Email Routing, Browser Run | `cloudflare` |
| Neon | The database | `neon` |
| WorkOS | Users' names, emails and sign-ins | `workos` |
| Anthropic | What agents read and write, and documents to extract | `anthropic` |
| OpenAI | The same, for agents set to `openai:` models | `openai` |
| Twilio | Texts and calls of clients that use them | `twilio` |
| Meta (WhatsApp) | WhatsApp messages | `meta_whatsapp` |
| ElevenLabs | Live calls and their transcripts | `elevenlabs` |
| Resend | Emails sent from our sending service | `resend` |
| Stripe | Billing: client company, amounts. No client records | none (kept out of scope) |
| Sentry | Error reports, scrubbed of client data | none (kept out of scope) |
| GitHub | Code only. CI never gets client data | none |

A client's own tools are the client's vendors, not ours: QuickBooks, Gmail, Zoho CRM, Podio, its
webhook endpoints and its websites.
