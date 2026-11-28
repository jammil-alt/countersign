# Security at Mezonas

What protects our clients' data today, where it lives in the code, and which settings we keep
outside the code. It is the record behind HIPAA, SOC 2 and PCI DSS; what is still open is in
`docs/hipaa-plan.md`. The design and its decisions are in `docs/plan.md` §1.35 (owner, 2026-11-05).
The policies we commit to are in `docs/policies/` (information security; data retention and
deletion; adopted 2026-11-09). Every control with its status, evidence and framework references is
in the register (`packages/core/src/compliance/controls.ts`), shown at `/ops/security`
(`docs/plan.md` §1.102).

**2026-11-16:** WorkOS multi-factor is on and required for every sign-in (owner; `docs/open.md` A1).
Our own second step (plan §1.100) is built and switches on with Twilio Verify (A2).

**2026-11-18:** every staff account on the systems that hold client data or change production has
a second factor, and each organization that offers it requires one (§10): Google (Workspace,
enforced for the organization), GitHub, Cloudflare (required for every member), Neon (required for
the organization), Sentry (required), WorkOS, Stripe and 1Password. Passkeys or security keys on
all of them but WorkOS, which offers an authenticator app only. Production's database owner
password was reset and no person holds it (§8); a restore was tested (§8); production is
monitored from outside, with a public status page (§10). The owner's laptop is encrypted, locks
at once, updates itself and has one user (§10), checked by hand until device management.

Status, 2026-11-20:
- The code for every control below is on `main` and on staging: #81–#84, then CodeQL v4 (#315),
  OSV-Scanner and patch deadlines (#316), Node 24 (#317), the register (#318), removing people
  (#325, #370), the model gate (#414) and the MCP connector's HIPAA check (`docs/plan.md` §1.190).
- Lockdown (§1, "Lockdown"; control INC-2) is on PRs #668 (migration 0103) and #666, not yet on
  `main`. The edge rule (`lockdown.yml`) is being added in a PR of its own.
- The first settings outside the code are in place (§10). What the owner still has to set is in
  §10, "Still to set".
- Plaid's attestations, control by control, are in `docs/plaid-plan.md`.

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

### Lockdown (`docs/plan.md` §1.243; control INC-2)

The first step when something may have gone wrong (`docs/policies/incident-response.md` §5).
How to use it: `docs/operations.md` §1.4. The design: `docs/lockdown-plan.md`.

- **What a lock does.** For one client, or every client at once: nothing reads or changes its
  data, its tools or its AI calls; its runs in progress stop and its Workflow instances end; its
  people see a locked page in the portal. What providers send for it is answered as usual and only
  counted; forwarded email for it is dropped and counted, never bounced or kept.
- **Where it is enforced.** In the database, in the statement that already sets each
  transaction's clients (`app_scope_tenant_ids`, migration 0103; `inScope` in
  `packages/db/src/client.ts`). A transaction for a locked client is refused before anything in it
  runs, and the next transaction anywhere sees a lock: no cache. The back office's lists leave a
  locked client out rather than failing.
- **Who.** Any operator who serves a client may lock it, with its name typed and a reason; every
  client, with "lock everything" typed. A client admin may lock their own account. Only the
  security officer unlocks (`SECURITY_OFFICER_EMAILS`), signed in or past the second step in the
  last 10 minutes; a client admin may lift only a lock their own side made. The client's admins
  and the security officer are emailed when a client is locked.
- **Investigating.** The security officer reads a locked client by adding `?investigate=1` to a
  back-office read. The transaction is read only, which the database enforces, and each read is in
  the audit log tagged `investigate`.
- **Audit.** Every request about a locked client is still audited (invariant 14), its refusals
  included: `audit_write` accepts a row for a client the transaction asked for and the lockdown
  left out. Each lock and unlock is also in the client's change log, with its reason or note.
- **If the app itself may be compromised,** the Cloudflare edge rule (`lockdown.yml`, being
  added) blocks every request to the app but its health check.
- **Unusual read volume** (`docs/plan.md` §1.245): every 5 minutes the audit log's last hour is
  checked per person and client; past 1,000 reads in an hour, 150 document reads or 3 exports in a
  day, the operators who serve the client get a to-do, the security officer an email and Sentry a
  warning, at most hourly. Polls and the officer's investigation aren't counted. It locks nothing:
  a person decides, and locks the client down if it isn't expected
  (`apps/api/src/lockdown/volume.ts`, `apps/api/src/volume.test.ts`).
- Tests: `packages/db/src/lockdown.test.ts`, `apps/api/src/lockdown.test.ts` (every portal route
  answers 423 for a locked client), `apps/web/src/ops/security/Lockdown.test.tsx`,
  `apps/web/src/portal/screens/Locked.test.tsx`.

## 2. Who can sign in, and for how long

- Sign-in is through **WorkOS AuthKit**. Only invited, verified email addresses get in.
- **Multi-factor authentication is required** in WorkOS, for email and password sign-ins (§10).
- **Sessions end after 30 minutes without the person's own activity and 12 hours after sign-in.**
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
- Once our own second step is on (`docs/plan.md` §1.100), the MCP connector, which never passes it,
  answers no tool call until the person approves that Claude sign-in from a browser that did pass
  it (§1.120). The approval link's code is kept only as an HMAC, works for 30 minutes and only for
  its own person; the approval ends with that Claude sign-in, 12 hours at most.
  Approving also takes the 6-digit code Claude shows beside the link, and the page says when
  Claude gave the link. The code is friction against phishing (someone sending a person a link to
  approve for a Claude that isn't theirs), not a cryptographic binding: whoever controls that
  Claude sees the code. A link stops working after 5 wrong codes; Claude's next call gives a new
  one.
- **A person's clients and roles are read again at most every 5 minutes** (`docs/plan.md` §1.93,
  the owner's D2). The sealed session cookie carries them with the time they were read; a request
  inside those 5 minutes uses them instead of reading them.
  - When someone else removes a person from a client or lowers their role, that person's open
    session keeps the old access for up to 5 minutes. A removed operator can still approve, sign
    and change that client's agents and settings; a removed or demoted client admin can still
    invite people, and an invitation made then stays. Checks that read memberships themselves (a
    client user's right to sign, approver rules, who is notified) see the change at once.
  - Removing someone cannot shorten their window. Ending their WorkOS session ends it at the next
    refresh, within the same 5 minutes.
  - A request that names a client, or needs a role, the carried list lacks reads it again first.
    A client added by someone else is missing from lists across clients, and a role raised within
    a client shows the old one, for up to 5 minutes.
  - Sign-out, the idle limit and a new sign-in drop them, and creating a client drops the
    creator's at once. Row-level security never reads memberships: it reads only the clients the
    request set.
- **Removing someone ends their access within 5 minutes** (`docs/plan.md` §1.119). Their
  membership goes at once; their open session keeps what its cookie carries for the rest of its
  5 minutes (above), and the MCP connector refuses them on its next call.
  - A client's person: Remove, from the client's People (operator) or the portal's Team (client
    admin; never themselves or an operator). Their open items go to the client admin, and approver
    rules naming them already fall to the client admin. The request's audit row names whom.
  - An operator: Actions → Remove operator (`db:remove-operator` as `cs_owner`, inside the job): every operator membership, one
    `operator.remove` audit row, never the last operator. Their open items go to the other
    operators, and a client they led has no lead until one is set. The rest of the day's steps are
    in `docs/operations.md`, "People: joining and leaving".
  - A phone (the phone app, `docs/plan.md` §1.116): removing it in Settings ends that person's
    phone-app sessions which signed in before then, in all their clients, on their next request
    (`mobile.phone_removed` in the audit log). While the second step is on, a phone's signing key
    can be added only within 10 minutes of signing in or passing the step. A phone-app session
    decides a card (approve, reject, answer) only with a signature from one of the person's own
    phones in that client, still set up; without one it is refused (403 `signature_required`) and
    nothing changes, and the card routes that carry no signature (a batch, an edit, taking a change
    back, a suggestion, a drafted change, a pack's review) refuse it outright.
- Roles are `operator`, `client_admin` and `client_user`. Only operators reach `/api/ops` and the
  MCP connector's back-office tools; a client's admin or user signing in to the same connector gets
  read-only tools over the portal's routes, for one of their own clients per call (`docs/plan.md`
  §1.89). Portal routes never return agent definitions, prompts or costs.
- Code: `packages/auth`, `packages/core/src/security/session-limits.ts`,
  `apps/web/src/session/activity.ts`.

## 3. The audit log

- `audit_event` records **who read or changed what, when and from where**:
  - every request to a session route, reads included;
  - every tool call made through the MCP connector, and each back-office or portal read or write
    it makes, and each sign-in to it refused with a token (up to a per-IP limit);
  - every sign-in, refused sign-in and sign-out;
  - system actions such as file purges.
- Each row holds the person, their role, the client, the action, the outcome, the ids involved,
  the IP and the browser. Never record content.
- It can't be changed. The runtime can only insert and read; a trigger refuses updates and
  deletes for everyone. Rows are isolated per client like any client data.
- It's kept 6 years.
- Operators read it at `/ops/security/audit`, with filters and a CSV export of the access review: every
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
- **Browser logins** are typed by the separate browser service (`apps/browser`), which holds no
  secrets: `apps/api` hands it a password or a code for one `fill`, held to the site's login
  origins, and it never stores, logs or returns one.
- **The blocked tier is enforced in code** (invariant 13). A list of well-known banks, payment
  services, email accounts and identity providers (`BROWSER_BLOCKED_HOSTS` in
  `packages/core/src/browser/site.ts`) is matched by domain and every subdomain, and a
  wildcard host that would reach a listed one counts. A site with any
  host on it is the blocked tier whatever tier the operator picked: it is never offered to a
  client, never set up, and a run never signs in to it, by the site's newest version and by the
  version a connection pinned. No page on a listed host is ever opened. The browser service
  checks the same list again (`apps/browser/src/blocked.ts`, held equal to core's by a test): it
  refuses to open a browser for a listed host, refuses to go to or download from one, and checks
  the browser's address after every navigation and before every read, leaving any page on one
  without reading it. The list changes only with the code; the operator's tier covers
  every other site.

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
  - model calls outside a run (the Builder on its agents, questions in plain words, voice typing)
    to an uncovered provider. They all go through one entry point,
    `apps/api/src/compliance/models.ts` (`docs/plan.md` §1.143).
  - the back office's MCP connector, whose answers reach claude.ai, until `claude_ai` is covered:
    a call that names a client in HIPAA mode, or spans clients while one is served, is refused,
    and the lists of clients leave it out (`apps/api/src/mcp/hipaa.ts`, `docs/plan.md` §1.190).
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
  Their Permissions-Policy turns off the camera, location, payment and USB, and allows the
  microphone to our own origin only, for voice typing (`microphone=(self)`, plan §1.109); the
  browser still asks the person first, and no frame or other site may use it.
- **Where a change comes from**: a request that changes something (any method but GET, HEAD and
  OPTIONS) is refused unless the browser says it came from the app's own origin (`Origin` equals
  `APP_ORIGIN`, and `Sec-Fetch-Site` is `same-origin` when sent), so a page on another host,
  including a sibling `*.mezonas.com` host, can't act as a signed-in person
  (`apps/api/src/request-origin.ts`). Signed webhooks, the public forms and beacon, and the phone
  app's own session header are exempt; a body sent to a session route must be JSON.
- **Rate limiting** (Cloudflare): 50 requests per 10 seconds per IP on `/api/*`, webhooks
  excluded. The MCP connector has its own limit of 120 calls a minute per operator. `/mcp` is not
  under `/api/*`, so the Cloudflare rule doesn't cover it: a request there with no token is
  answered and not recorded, and refused sign-ins are recorded only up to 120 a minute per IP
  (`MCP_RATE_LIMIT`, key `ip:<address>`). Plain-words questions and voice typing in the portal,
  which each call a paid model, are limited per person and client: questions to 10 a minute and
  200 a day, voice typing (a call per segment of a few seconds) to 30 a minute and 1,500 a day
  (`apps/api/src/metered.ts`). The public beacon route (`/api/in/`) has its own too: 120 a minute
  per sending address (an IPv6 address by its /64), then 3,000 a minute per site on a binding of
  its own (`INBOUND_TARGET_RATE_LIMIT`), both checked before any database work; a request the
  address limit refuses doesn't count toward its site (`apps/api/src/routes/pack-inbound.ts`).
- **Writes to clients' tools** need approval by default, run once each, and record their before
  state (invariant 8). Delete is off.
- **Webhooks** from Twilio, Stripe, QuickBooks and ElevenLabs are signature-checked.
- **Bodies with no session** (webhooks, the beacon, the token-link pages and the sign-in steps)
  are read with a cap: a declared length over the route's limit is refused unread, and a body with
  no length is read only up to the limit (`apps/api/src/body.ts`; the code service's texts too).

## 7. Changes, code and dependencies

- Every change is a pull request.
  - `main` is protected: a pull request, passing checks and CodeQL are required, and force
    pushes and deletion are blocked.
  - Only the admin can bypass it.
- CI runs lint, the layering check, typecheck and every test, and applies every migration to its
  own Postgres. It **never connects to Neon**, so client data never reaches a CI runner.
  Migrations meet real rows on staging first, in a transaction, before production.
- **CodeQL** (security queries) runs on pull requests, on `main` and weekly.
- **Dependabot** sends alerts and security updates, plus monthly grouped version updates (one pull request per ecosystem).
- **OSV-Scanner** checks the lockfile against OSV.dev on pull requests (failing only on a
  vulnerability the pull request adds), on `main` and weekly (`vulnerability-scan.yml`). We run no
  containers or servers, so the lockfile is what there is to scan.
- **Secret scanning** with push protection is on.
- **Patch deadlines** (`docs/policies/information-security.md` §6): critical 7 days, high 30,
  medium and low at the next monthly update, from when the alert is raised.
  `vulnerability-sla.yml` opens an issue per open alert with its due date, closes it with how long
  the fix took, and lists what is open and overdue in its daily summary. That summary, saved each
  month, is the evidence (`docs/operations.md` §2).
- **End of life:** `docs/eol-inventory.md` lists what we run and build with and when its support
  ends; reviewed every quarter. The policy replaces an end-of-life component within 90 days.
- **Production is scanned from outside** every Monday and after each production release
  (`.github/workflows/zap-scan.yml`, OWASP ZAP's baseline scan of `https://app.mezonas.com`; plan
  §1.102). It reads pages and headers only, never signs in and never reaches client data. Findings
  go to one GitHub issue, "Production scan: findings", and are fixed on the policy's deadlines.
  Staging is not scanned. Until production's first release, the run says so and stops.
- Migrations, CI changes and sign-in changes each get their own pull request, so each can be
  reverted alone.

## 8. Backups and recovery

- Neon keeps **7 days** of point-in-time history on the production project. A restore is tested
  every quarter (`docs/operations.md` §4); the first on 2026-11-18, with the restored copy's counts
  equal to production's.
- Original documents in R2 are written once and never changed.
- **No person holds the database owner's password** (2026-11-18). Migrations, adding and
  removing operators and purging a retired client run as GitHub Actions workflows that fetch
  `cs_owner`'s connection inside the job; production's wait for approval. By hand only as
  break-glass, recorded the same day, with the password reset afterwards (`docs/operations.md`,
  "Break-glass database access").

## 9. When a client leaves

1. **Retire it** from the back office, with a reason and the client's name typed again. Then:
   - its users can no longer sign in;
   - its agents are retired, and no run starts;
   - its tools are disconnected, with grants revoked at the provider and credentials deleted.
2. **30 days later**, the hourly cron deletes its files from R2.
3. **The owner then purges its rows** with Actions → Purge client (`purge-client.yml`), which
   waits for the production environment's approval and asks for the client's name again. The
   audit log keeps its ids.
4. **Data at other vendors** (Twilio, ElevenLabs, Resend, Stripe) is closed by hand from the
   checklist in `docs/operations.md` §1.2.

**Bank data (Plaid; `docs/policies/data-retention.md` §5).** Disconnecting a bank removes the item
at Plaid (`/item/remove`) and deletes the access token at once; nothing more is read. Transactions
already read are part of the client's books. They are kept until the client leaves, then purged with
its rows (steps 2 and 3). They are not deleted bank by bank: synced records are immutable history,
copied into events and the runs that used them (CLAUDE.md invariant 3). The policy also lets a
client ask for specific data to go sooner; nothing in the product does that yet
(`docs/plaid-plan.md` §2).

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
| Google Workspace, the owner's account | 2-Step Verification (myaccount.google.com → Security) | On: two passkeys (1Password, iCloud Keychain), Google prompt on one phone, authenticator app, 10 backup codes saved; recovery phone and email set. Signs in to GitHub, Cloudflare, Neon, Sentry, Stripe and WorkOS (checked 2026-11-18) |
| Google Workspace, organization | 2-Step Verification enforcement (admin.google.com → Security → 2-Step Verification) | On (was off), 2026-11-18 |
| Cloudflare, the owner's login | Two-factor (My Profile → Authentication) | On: two security keys (Touch ID on the Mac; 1Password), an authenticator app, backup codes saved; email codes removed. Signs in with Google; the password Cloudflare had set was reset to one kept in 1Password (checked 2026-11-18) |
| Cloudflare, account (holds `mezonas.com`) | Require two-factor for all members (Manage Account → Members) | On (was off). One member, Super Administrator. The account also holds `plenarylabs.app`, `simonswork.app` and `twelvethirty-4.com`: shared with Plenary Labs, not separate (2026-11-18) |
| GitHub, account `jammil-alt` | Two-factor (Settings → Password and authentication) | On: two passkeys, an authenticator app and GitHub Mobile; recovery codes saved; no password (signs in by email or Google) (checked 2026-11-18) |
| GitHub, `countersign` | Collaborators | `jammil-alt` only, admin (checked 2026-11-18) |
| GitHub, `countersign` | Environment `production` (Settings → Environments) | Required reviewer `jammil-alt`; self-review allowed (one person); deployment from `main` and `v*` tags; administrators can't bypass (checked 2026-11-18) |
| GitHub, `countersign` | Ruleset "Protect main" | PR required; `checks / check`, `checks / static`, `analyze`; no force push or delete; admin bypass |
| Neon, `mezonas` (Launch) | History window (Settings → Postgres) | 7 days (was 1) |
| Cloudflare, account | Security Center → Security Insights | On, scanned every 7 days (Free plan); first full scan 2026-11-14 (plan §1.102, control CHG-8). Findings for Mezonas: the account's only member has no second factor (fixed 2026-11-18; clears on the next scan); Access policies on `datum.mezonas.com/v1` and `dev.datum.mezonas.com/v1` flagged as too broad; no DMARC on `in.` and `agents.mezonas.com` (receive only), `p=none` on `mail.mezonas.com`; no security.txt. Bot Fight Mode left off on purpose: on Free it can't spare webhooks. Reviewed every quarter |
| Neon, the owner's account | Two-factor (account menu → Settings) | On: authenticator app (was off). Signs in with Google; no password (2026-11-18) |
| Neon, organization "Jammil" (holds `mezonas`, and Datum's and other projects) | Require two-factor; auto-add new users | Required (was not); auto-add off (was on). One member, Admin (2026-11-18) |
| Neon, `mezonas` | Branch protection | `main` protected (was not) (2026-11-18) |
| Neon, `mezonas`, branch `main` | `cs_owner`'s password | Reset 2026-11-18 12:25 ET and not kept by anyone; workflows fetch it inside the job (§8, `docs/operations.md` "Break-glass database access") |
| Neon, API keys | Who can reach the project | GitHub's `NEON_API_KEY` is the owner's personal key (`mezonas-github`), which reaches every project: to replace with an organization key scoped to `mezonas` (2026-11-18) |
| Sentry, the owner's account | Two-factor (User settings → Security) | On: authenticator app, Touch ID, recovery codes (was off). Signs in with Google (2026-11-18) |
| Sentry, organization | Require Two-Factor Authentication | On (was off). One member, Owner (2026-11-18) |
| WorkOS dashboard | The owner's MFA; team | On: authenticator app (was off; no passkey offered). The team is named "Plenary Labs"; one member, Admin; team MFA requirement off (2026-11-18) |
| Stripe | The owner's two-step | Authenticator app and two passkeys. Signs in with Google, no password. Team: one member, Owner; team requirement off. Checked in the test-mode sandbox only; the second account not opened (2026-11-18) |
| 1Password, company account | Staff credentials and recovery codes | Set up 2026-11-18 (the owner's word, not checked by Claude in Chrome): Mezonas logins, passkeys and recovery codes kept there, in vaults only the owner opens |
| The owner's MacBook Pro (macOS 26.6.2) | Device settings (policy §4) | FileVault on, recovery key in 1Password; screen lock immediate; firewall on; automatic macOS updates on; Find My Mac on; one user account. Checked by hand with `fdesetup`, `socketfilterfw`, `sysadminctl` and `dscl` (2026-11-18); not yet under device management |
| Claude (claude.ai), the owner's account | Privacy → Help improve our AI models | Off: chats and coding sessions, including what the Ops MCP connector returns, aren't used for training. A personal plan, not a business one; no BAA, so HIPAA clients are held out of the connector until `claude_ai` is listed (`docs/plan.md` §1.190) (checked 2026-11-18) |
| Better Stack (free) | Uptime and status page | Monitor on `https://app.mezonas.com/api/health` every 3 minutes, email alerts; public status page at `https://status.mezonas.com` (CNAME `status` → `statuspage.betteruptime.com`, DNS only, on `mezonas.com`). It reaches only the public health route: no client data (2026-11-18) |
| Sentry, organization | Security & Privacy | Data Scrubber, default scrubbers and "Prevent Storing of IP Addresses" on and enforced on `mezonas-api` and `mezonas-web`; sensitive fields email, cookie, session, prompt, completion, utterance, transcript (checked 2026-11-14). "Require Two-Factor Authentication" was off then; on since 2026-11-18 (row above) |
| Sentry, `mezonas-api` and `mezonas-web` | Alerts | "Production errors to the security officer": a new or regressed issue in `environment:production`, email to the owner, at most every 30 minutes (#6345968, #6345969; 2026-11-14). The default "high priority issues" alert stays, all environments. Developer plan: one user, events kept 30 days |

### Still to set (owner)

Each needs a dated screenshot in the evidence folder (`docs/plaid-plan.md` §1).

| Where | Setting |
|---|---|
| Neon, WorkOS's dashboard | A passkey or hardware key on the owner's account (`docs/policies/information-security.md` §3; control ACC-2). Both have an authenticator app today; WorkOS offers no passkey, so it stays an app until it does (2026-11-18). Google, GitHub, Cloudflare, Sentry and Stripe have passkeys or security keys (above) |
| Intuit, Plaid | A second factor, by passkey or hardware key, on the owner's developer accounts: not yet recorded |
| Google Workspace, organization | 2-Step Verification is enforced (2026-11-18). Check whether it can be limited to passkeys and security keys only, and record the method allowed |
| GitHub, `countersign` | One collaborator today, with two-factor (above). Before adding anyone, check their two-factor, or move the repo to an organization that requires it: a personal account can't |
| GitHub, ruleset "Protect main" | Add the Vulnerability scan's pull-request check (`scan-pr / osv-scan`) as required |
| GitHub, secrets | `ALERTS_TOKEN`, so the patch deadlines cover Dependabot alerts (`docs/operations.md` §2) |
| Cloudflare, rate limiting rule "API rate limit" | Add `/api/connections/bankfeed/webhook/` to the excluded webhook paths, before the bank feed goes live |

## 11. Our vendors

These are the vendors that receive client data, and how. Whether each will sign a BAA is tracked
in `docs/hipaa-plan.md`.

| Vendor | What it gets | Id in `BAA_PROCESSORS` |
|---|---|---|
| Cloudflare | All traffic; Workers, R2 files, Email Routing, Browser Run | `cloudflare` |
| Neon | The database | `neon` |
| WorkOS | Users' names, emails and sign-ins | `workos` |
| Anthropic | What agents read and write, and documents to extract (the API); and what operators look up through the Ops MCP connector in Claude (claude.ai, `docs/plan.md` §1.190) | `anthropic` (the API); `claude_ai` (the connector) |
| OpenAI | The same, for agents set to `openai:` models; the vendor catalog's embeddings; voice typing's recordings (written out, never kept) | `openai` |
| xAI | The same, for agents set to `xai:` models (Grok) | `xai` |
| Google (Gemini API) | The same, for agents set to `google:` models (Gemini); not the client's own Google account | `google` |
| Twilio | Texts and calls of clients that use them | `twilio` |
| Meta (WhatsApp) | WhatsApp messages | `meta_whatsapp` |
| ElevenLabs | Live calls and their transcripts | `elevenlabs` |
| Resend | Emails sent from our sending service | `resend` |
| Plaid | Bank and card transactions and balances of clients that connect a bank | `plaid` |
| Expo (push) | Phone notifications, once the phone app ships (`docs/plan.md` §1.116): a phone's token, Mezonas or the business's name, and a count. Off until `MOBILE_PUSH=on` | `expo_push` |
| Stripe | Billing: client company, amounts. No client records | none (kept out of scope) |
| Sentry | Error reports, scrubbed of client data | none (kept out of scope) |
| GitHub | Code only. CI never gets client data | none |

A client's own tools are the client's vendors, not ours: QuickBooks, Gmail, Zoho CRM, Podio, its
webhook endpoints and its websites.
