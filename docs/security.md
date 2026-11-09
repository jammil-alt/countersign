# Security at Mezonas

What protects our clients' data today, where it lives in the code, and which settings we keep
outside the code. It is the record behind HIPAA, SOC 2 and PCI DSS; what is still open is in
`docs/hipaa-plan.md`. The design and its decisions are in `docs/plan.md` §1.35 (owner, 2026-11-05).

Status, 2026-11-09:
- #81–#84 are merged and on staging.
- Marked **(branch)**: built on `claude/clever-volta-s13mur`, not merged yet. Sign-in methods,
  removing people, HIPAA mode for the MCP connector, the Builder and run questions, the second
  scanner and patch deadlines, and Node 24.
- Settings the owner still has to make are in §10, "Still to set".

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
- **Only sign-ins with a certain second factor get a session (branch):** email and password,
  a passkey, or a client's SSO (set up only where its identity provider requires MFA). Social
  sign-ins (Google, Microsoft, GitHub, Apple), magic links, WorkOS impersonation, or a sign-in
  WorkOS doesn't name are refused: the WorkOS session is revoked and the refusal audited
  (`sign_in_method`). `packages/auth/src/workos/adapter.ts`, `MFA_SIGN_IN_METHODS`.
- **Sessions end after 30 minutes without the person's own activity and 12 hours after sign-in**
 .
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
- **Removing someone ends their access at once (branch).** Every request reads memberships
  afresh, so a removed membership refuses the next request, cookie or MCP token alike.
  - A client's person: Remove, from the client's People (operator) or the portal's Team (client
    admin; never themselves or an operator). Their open items go to the client admin, and approver
    rules naming them already fall back to the client admin.
  - An operator: Actions → Remove operator (`db:remove-operator`): every operator membership, an
    `operator.remove` audit row, never the last operator. The checklist for the rest of the day is
    `docs/operations.md` §1.3.
- Code: `packages/auth`, `packages/core/src/security/session-limits.ts`,
  `apps/web/src/session/activity.ts`.

## 3. The audit log

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

- **HIPAA mode, per client.** A client whose records hold health information is put in
  HIPAA mode by an operator, with a reason. Its data then goes only to vendors listed in
  `BAA_PROCESSORS` (`apps/api/wrangler.jsonc`). That list is empty until BAAs are signed, so no
  client can be in HIPAA mode yet.
- What HIPAA mode refuses:
  - turning it on while a connector that needs an uncovered vendor is offered;
  - offering such a connector;
  - model calls to an uncovered provider (in runs, reach-outs and background document reading);
  - tool calls that need an uncovered vendor, such as texts, WhatsApp, calls or our sending email;
  - (branch) the Builder on its agents, and questions about its runs in plain words, unless the
    model's provider is covered; across clients, it is left out of the question;
  - (branch) the Ops MCP connector: the client is left out of every tool until `claude_ai`
    (claude.ai, not the API) is covered.
- The list of which feature sends data to which vendor is
  `packages/core/src/compliance/processors.ts` (invariant 14).
- **Card numbers**:
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

- **Security headers** on every API and MCP answer: `Cache-Control: no-store`,
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
  own Postgres. It **never connects to Neon**, so client data never reaches a CI runner.
  Migrations meet real rows on staging first, in a transaction, before production.
- **CodeQL** (security queries) runs on pull requests, on `main` and weekly (v4, branch).
- **Dependabot** sends alerts and security updates, plus monthly grouped version updates (one pull request per ecosystem).
- **OSV-Scanner (branch)** checks the lockfile against OSV.dev on pull requests (failing only on a
  vulnerability the pull request adds), on `main` and weekly. We run no containers or servers, so
  the lockfile is what there is to scan.
- **Secret scanning** with push protection is on.
- **Patch deadlines (branch):** critical 7 days, high 30, medium 90, low 180, from when the alert
  is raised. `vulnerability-sla.yml` opens an issue per open alert with its due date and closes it
  with how long the fix took; its daily summary is the monthly review's evidence
  (`docs/operations.md` §1.4).
- **End of life:** `docs/eol-inventory.md`, reviewed every quarter. Node moves to 24 (branch).
- Migrations, CI changes and sign-in changes each get their own pull request, so each can be
  reverted alone.

## 8. Backups and recovery

- Neon keeps **7 days** of point-in-time history on the production project. A restore is tested
  every quarter (`docs/operations.md` §4).
- Original documents in R2 are written once and never changed.

## 9. When a client leaves

1. **Retire it** from the back office, with a reason and the client's name typed again. Then:
   - its users can no longer sign in;
   - its agents are retired, and no run starts;
   - its tools are disconnected, with grants revoked at the provider and credentials deleted.
2. **30 days later**, the hourly cron deletes its files from R2.
3. **The owner then purges its rows** with `db:purge-client`. The audit log keeps its ids.
4. **Data at other vendors** (Twilio, ElevenLabs, Resend, Stripe) is closed by hand from the
   checklist in `docs/operations.md` §1.2.

**Bank data (Plaid).** Disconnecting the bank feed removes the item at Plaid and deletes the access
token at once; nothing more is read. Transactions already synced are the client's business records:
they are kept while the client is a client and deleted with the rest when it leaves (steps 2 and 3,
rows within 60 days of retiring). They are not deleted connection by connection, because synced
records are immutable history, copied into events and the runs that used them (CLAUDE.md
invariant 3). A client that wants them gone sooner leaves through the same steps.

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

### Still to set (owner)

From the remediation plan (`docs/plaid-plan.md`); each needs a screenshot for the evidence folder.

| Where | Setting |
|---|---|
| WorkOS, both environments | Authentication → Methods: only email and password, passkeys and SSO on; Google, Microsoft, GitHub, Apple and magic auth off. The app refuses them anyway; this covers the Ops MCP connector too |
| Google Workspace | Enforce 2-Step Verification for everyone; passkeys or security keys only (no SMS or phone codes) |
| GitHub | Each collaborator has 2FA; or move `countersign` to an organization that requires it |
| GitHub, ruleset "Protect main" | Add the required check `scan-pr / osv-scan` (Vulnerability scan) |
| GitHub, secrets | `ALERTS_TOKEN`: a fine-grained token on `countersign`, "Dependabot alerts: read" and "Code scanning alerts: read", one year, renewed before expiry |
| Cloudflare, Neon, Plaid, Sentry, Stripe, Twilio, Resend, ElevenLabs, Anthropic, OpenAI, registrar | Google sign-in where offered, else an authenticator app or passkey; SMS off; no shared logins |
| Cloudflare Zero Trust | An Access application in front of `staging.mezonas.com` (Google Workspace as identity provider, our people only), bypassing the webhook paths and `/mcp` |
| Cloudflare, rate limiting rule | Add `/api/connections/bankfeed/webhook/` to the excluded webhook paths |

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
| Plaid | Bank and card transactions of clients that connect a bank | `plaid` |
| Anthropic (claude.ai) | What the Ops MCP connector's tools return, in an operator's Claude | `claude_ai` |
| Stripe | Billing: client company, amounts. No client records | none (kept out of scope) |
| Sentry | Error reports, scrubbed of client data | none (kept out of scope) |
| GitHub | Code only. CI never gets client data | none |

A client's own tools are the client's vendors, not ours: QuickBooks, Gmail, Zoho CRM, Podio, its
webhook endpoints and its websites.
