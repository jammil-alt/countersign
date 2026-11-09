# Plaid compliance: the 11 attestations

What Plaid's Compliance Center asks of us, what we already have, and what's left. The technical
record is `docs/security.md`; HIPAA, SOC 2 and PCI are in `docs/hipaa-plan.md`. Most of the work
below is the same work: one set of policies and routines covers all of them.

- Entity: Twelve Thirty-Four Consulting LLC. App: Mezonas.
- Questionnaire submitted 2026-11-08. Plaid's deadline for all 11 attestations: **2027-05-10**.
  Our target: attest by **2027-04-10**.
- Last updated 2026-11-09.

**Where we are:**
- Done before this plan: MFA for portal and back-office sign-ins (WorkOS), Dependabot alerts and
  security updates, CodeQL, secret scanning, the access-review CSV, the audit log, and a client exit
  that ends with a purge.
- Not started: policies, the internal identity provider, zero trust in front of internal tools,
  the accounts inventory, and evidence collection.
- Six findings from the code that the task list doesn't know about (§3). Two need the owner's
  decision before the policies can be written (F1, F2).

Plaid Link runs in the client portal: a client's admin connects the business's bank or card
account there (`docs/plan.md`, the bank feed decisions; `packages/connectors/src/bankfeed`). The
portal is our "consumer-facing app" for these attestations, though its users are businesses.

## 1. Tasks

Status: **done** (in place; collect the evidence), **partly**, **open**. Who: **owner** (a
dashboard or a decision), **code** (a pull request here), or both.

### Phase 0: immediate (week of Nov 9)

| # | Task | Status | Who | What's there, what's left |
|---|---|---|---|---|
| 1 | Plaid App profile, "Reason for data access" | open | owner | Draft text in §5. Check it matches what the questionnaire said. |
| 2 | Legal Entity Identifier (optional) | open | owner | Optional and paid yearly. Skip unless Plaid asks. |
| 3 | MFA on every internal system | partly | owner | WorkOS requires MFA for the app's sign-ins (`security.md` §10). Not recorded: org-level enforcement in Google Workspace, GitHub (org 2FA requirement), Cloudflare, Neon, WorkOS's own dashboard, Plaid's dashboard, the domain registrar, Sentry, Stripe, Twilio, Resend, ElevenLabs, Anthropic, OpenAI. Use the inventory in §4; a screenshot per row. |
| 4 | Dependency scanning | done | owner | On since 2026-11-06 (`security.md` §10): dependency graph, Dependabot alerts and security updates, and `.github/dependabot.yml` monthly updates. Evidence: Settings → Code security, and Security → Dependabot. |
| 5 | Start the EOL inventory | partly | code | Started: `docs/eol-inventory.md`, the whole code stack. Two flags (F5). |

### Phase 1: identity and access (target Dec 15)

| # | Task | Status | Who | What's there, what's left |
|---|---|---|---|---|
| 6 | Identity provider, SSO to every internal tool | open | owner | Suggest Google Workspace: it's already our email, so no new vendor. Tools that can't take it go on the manual offboarding list (task 18). GitHub's SAML SSO needs GitHub Enterprise Cloud. The repo is under a personal account (`jammil-alt`), which has no setting to require 2FA of others: check each collaborator's, or move the repo to an organization and require it there. |
| 7 | Phishing-resistant MFA, no SMS | open | owner | In Google Workspace: enforce 2-Step Verification and allow passkeys or security keys only. In each other tool: an authenticator app or passkey, SMS removed. |
| 8 | MFA on the portal, where Plaid Link is | partly | owner, code | WorkOS requires MFA for password sign-ins, on staging and production. Open: sign-ins by other methods (F2). Evidence: WorkOS Authentication → Features, a portal sign-in showing the second factor, and the rule as settled in F2. |
| 9 | Zero trust in front of internal tools | open | owner | No servers, admin ports or VPN to close: everything is Cloudflare Workers and vendors' consoles. What's left is in F6. Evidence: the diagram in F6 and the Access policies. |
| 10 | Inventory all accounts | open | owner | Template in §4. The app's own half is the access-review CSV at `/ops/audit`. |

### Phase 2: policies (target Jan 31)

The policies in `docs/hipaa-plan.md` §5 are the same ones. Write each once so it covers Plaid,
HIPAA and SOC 2.

| # | Policy | Status | Facts to take from the repo |
|---|---|---|---|
| 11 | Information security (umbrella) | open | `security.md` (all of it); incident response is new. |
| 12 | Access control | open | Roles `operator`, `client_admin`, `client_user` (`security.md` §2); session limits; the quarterly review; F4 (removing people). |
| 13 | Data retention and deletion | open | Client exit and purge (`security.md` §9); audit log 6 years; Neon history 7 days; Plaid tokens and bank data: F1. |
| 14 | Vulnerability management and patching | open | Scan sources: Dependabot, CodeQL, secret scanning, and task 19's. SLA: F3. |
| 15 | EOL software | open | `docs/eol-inventory.md`, reviewed quarterly. |
| 16 | Onboarding and offboarding | open | Add operator: `.github/workflows/add-operator.yml`. Removing someone: F4. |
| 17 | Sign, date, version; one folder | open | Where they live is a decision (§6). |

### Phase 3: automation (target Feb 28)

| # | Task | Status | Who | What's there, what's left |
|---|---|---|---|---|
| 18 | Automated de-provisioning | open | owner, code | Google Workspace suspension ends Google sign-in everywhere it's used. For the app, F4. A checklist for tools without SCIM, then a test with a dummy user, logged. |
| 19 | Infrastructure and container scanning | open | code | We have no containers or servers. What fits: a second scanner over the lockfile and config, uploading to code scanning. F3. Its own pull request (CI change). |
| 20 | Findings to tickets with due dates | open | code | A scheduled workflow that opens one issue per Dependabot or code-scanning alert, due by severity, and closes it when the alert closes. It needs a token that can read Dependabot alerts. Its own pull request. |
| 21 | Finish the EOL inventory | partly | owner, code | The code stack is listed. Add laptops' operating systems and anything outside the repo. |

### Phase 4: processes and evidence (start by Mar 15)

| # | Task | Status | Who | Notes |
|---|---|---|---|---|
| 22 | First quarterly access review | open | owner | §4's inventory plus the `/ops/audit` CSV. Record reviewer, date, systems, access removed. |
| 23 | The recurring cadence | open | owner | Add to `docs/hipaa-plan.md` §8 (one routines table): monthly scan and patch review, quarterly EOL check. The quarterly access review and the yearly policy review are there already. |
| 24 | The evidence folder | open | owner | One subfolder per attestation (§2). |

### Phase 5: attest (target Apr 10)

| # | Task | Status | Who |
|---|---|---|---|
| 25 | Check each attestation against its evidence, then attest all 11 | open | owner |
| 26 | Screenshot of the completed Tasks tab | open | owner |

## 2. Attestations

| Plaid attestation | Tasks | Status |
|---|---|---|
| EOL software monitoring and policy | 5, 15, 21 | partly: inventory started |
| Automated de-provisioning | 16, 18 | open: F4 |
| Data deletion and retention policy | 13 | open: F1 |
| Zero trust access architecture | 9 | open: F6 |
| Access control policy | 12 | open |
| Periodic access reviews and audits | 10, 22, 23 | partly: the app's review CSV exists |
| MFA on consumer-facing app (Plaid Link) | 8 | partly: F2 |
| Information Security Policy | 11, 17 | open |
| MFA on internal systems with consumer data | 3, 7 | partly: WorkOS only |
| Patch vulnerabilities within a defined SLA | 14, 20 | open: F3 |
| Vulnerability scanning | 4, 19 | partly: Dependabot, CodeQL, secret scanning on |

## 3. Findings from the code

**F1. Bank transactions outlive the bank connection.** Disconnecting the bank calls Plaid's
`/item/remove` and drops the access token (`packages/connectors/src/bankfeed/index.ts`, `revoke`).
The transactions already synced stay: each is a `raw_record`, which is never updated or deleted
(CLAUDE.md invariant 3). They go only when the whole client leaves: its files 30 days after it's
retired, its rows when the owner runs `db:purge-client` (`security.md` §9). There's no way to delete
one connection's bank data on request. The retention policy has to say one of:
- (a) bank data is part of the client's records, kept while it's a client and deleted at exit; or
- (b) bank data is deleted within N days of disconnecting or of a request. That needs code: a
  purge of one connection's raw records, a written exception to invariant 3 like the client purge.

Plaid access tokens are already handled: encrypted with the client's key, never shown, removed at
Plaid and dropped on disconnect and on client exit.

**F2. Portal MFA covers password sign-ins only.** WorkOS is set to "Required for non-SSO sign-ins".
A person who signs in by SSO, Google or a magic link may not be asked for a second factor by us.
The app records the method (`authentication_method`, in the audit log) but doesn't act on it.
Check which methods are on in AuthKit, then pick one:
- (a) turn off every method but email and password, so MFA always runs (simplest);
- (b) keep SSO for clients whose identity provider enforces MFA, and write that into the policy;
- (c) code: refuse to open Plaid Link unless the session signed in by password.

**F3. The patch SLA is shorter than what our docs say now.** `.github/dependabot.yml` and
`docs/hipaa-plan.md` §8 say critical and high fixes within a month (PCI DSS 6.3.3). The proposed SLA
is critical 7 days, high 30, medium 90, low as scheduled. Once the policy is signed, change both
(dependabot.yml with task 19's pull request, since it's CI config).

**F4. The app has no way to remove a person.** Operators are added by the Add operator workflow;
client users are invited from the back office. Nothing removes a membership: today it's deleting the
user in WorkOS and their `membership` rows by hand. Sessions end within 30 minutes idle or 12 hours
in any case. Suggested code: a "Remove operator" workflow beside Add operator, and removing a user
from a client in the back office, each audited. That's what task 18's dummy-user test would
exercise.

**F5. Two end-of-life dates fall before Plaid's deadline** (`docs/eol-inventory.md`):
- Node.js 22, which builds, tests and runs CI, reaches end of life on 2027-04-30. Move to Node 24
  before then.
- `github/codeql-action@v3` is due to be deprecated in December 2026. Move to v4.

**F6. Zero trust: what's actually internal.** There are no servers or ports. The internal surfaces
are:
- the back office (`/ops`, `/api/ops`, the Ops MCP connector): already per person and per role
  through WorkOS, with MFA, session limits and the audit log;
- staging (`staging.mezonas.com`), reachable by anyone who can sign in;
- vendors' consoles: Cloudflare, Neon, WorkOS, GitHub, Plaid, Google Workspace and the rest in §4;
- GitHub Actions secrets, used only by workflows on protected `main` and by the owner.

Suggested: Cloudflare Access (Zero Trust, free for small teams), with Google Workspace as its
identity provider, in front of all of staging; consoles behind Google SSO where each tool allows
it; no shared accounts (§4 shows any). Putting Access in front of production's `/ops` needs care:
the Ops MCP connector calls `/mcp` with WorkOS tokens, and Plaid and other webhooks must stay open.
The diagram for the evidence can be drawn from this list and `security.md` §6.

## 4. Accounts inventory (task 10)

One row per system. The owner fills in people; this is the baseline for the first access review
and the offboarding checklist.

| System | Holds client or bank data | Who has access, and role | MFA enforced | Sign-in by Google SSO | Removed by |
|---|---|---|---|---|---|
| Google Workspace | email | | | — | suspend user |
| GitHub (`jammil-alt/countersign`) | code, Actions secrets | | | Enterprise only | remove collaborator |
| Cloudflare | all traffic, R2 files, Workers | | | | |
| Neon | the database | | | | |
| WorkOS dashboard | app users' names and emails | | | | |
| Plaid dashboard | bank items | | | | |
| Domain registrar and DNS | — | | | | |
| Sentry | scrubbed error reports | | | | |
| Stripe | billing | | | | |
| Twilio, Resend, ElevenLabs | messages and calls, when used | | | | |
| Anthropic, OpenAI consoles | API keys | | | | |
| Mezonas back office (production) | everything | `/ops/audit` → Access review | WorkOS | | F4 |

## 5. Draft: "Reason for data access" (task 1)

> Mezonas is a back-office service for small and mid-sized businesses. A business's administrator
> connects the business's own bank and card accounts through Plaid Link in the Mezonas client
> portal. We request only the Transactions product, read-only. We use it to match the business's
> bank and card transactions with its bills, receipts and invoices and to keep its bookkeeping
> (QuickBooks Online) current; changes to its books need the business's approval by default. We
> never move money: we refuse any connection with Auth, Transfer, Payment Initiation or Signal. A
> business's data is used only for that business.

## 6. Decisions for the owner

- [ ] F1: bank data kept until the client leaves, or deleted on disconnect or request (code).
- [ ] F2: which sign-in methods the portal allows, and how MFA is guaranteed for the rest.
- [ ] Identity provider: Google Workspace (suggested) or Okta.
- [ ] Where the signed policies live: suggest a shared Google Drive folder "Compliance", one
      subfolder per attestation (task 24), with drafts written in `docs/policies/` here so each
      version has a history.
- [ ] Whether to use a compliance tool (Vanta, Drata) now, since it would also cover SOC 2
      (`docs/hipaa-plan.md` §9).

## 7. After attesting

These join the routines in `docs/hipaa-plan.md` §8:
- monthly: review scan findings and confirm the SLA was met;
- quarterly: access review (§4 plus the `/ops/audit` CSV) and the EOL inventory;
- yearly: review and re-sign the policies;
- each person who leaves: the offboarding checklist, logged.
