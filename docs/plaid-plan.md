# Plaid compliance: the 11 attestations

What Plaid's Compliance Center asks of us, what we have, and what's left. The technical record is
`docs/security.md`; HIPAA, SOC 2 and PCI are in `docs/hipaa-plan.md`. Most of the work is the same
work: one set of controls, policies and routines covers all of them. Policies and other written
items are made outside the repo; this file tracks the technical side and the settings.

- Entity: Twelve Thirty-Four Consulting LLC. App: Mezonas.
- Questionnaire submitted 2026-11-08. Plaid's deadline for all 11 attestations: **2027-05-10**.
  Our target: attest by **2027-04-10**.
- Last updated 2026-11-09.

**Where we are:** the technical controls for all 11 are built. Some were already on staging. The
rest are on `claude/clever-volta-s13mur`, marked **(branch)** below, waiting to be merged. What's
left is settings in vendors' consoles (`docs/security.md` §10, "Still to set"), the written
policies, and collecting evidence.

Plaid Link runs in the client portal: a client's admin connects the business's bank or card account
there (`packages/connectors/src/bankfeed`). The portal is our "consumer-facing app" for these
attestations, though its users are businesses.

## 1. The attestations: control and evidence

| Plaid attestation | The control | Evidence to collect |
|---|---|---|
| MFA on consumer-facing app (Plaid Link) | WorkOS requires MFA for password sign-ins; the app gives a session only to password, passkey or SSO sign-ins, and refuses the rest (branch) | WorkOS Authentication → Features and → Methods; a portal sign-in showing the second factor; `docs/security.md` §2 |
| MFA on internal systems with consumer data | Google Workspace 2-Step Verification (passkeys or keys only); MFA or Google sign-in on every console (§3) | A screenshot per row of §3 |
| Zero trust access architecture | No servers, admin ports or VPN: Workers and vendors' consoles. The back office is per person and per role (WorkOS, MFA, sessions, audit log); staging behind Cloudflare Access; consoles behind Google sign-in; no shared accounts | §2 below as the diagram; the Access policy; §3 |
| Access control policy | Roles `operator`, `client_admin`, `client_user`; least privilege by role and client (row-level security); sessions 30 minutes idle, 12 hours | The policy (written outside); `docs/security.md` §1–2 |
| Periodic access reviews and audits | `/ops/audit` → Access review (CSV), plus §3 for internal systems; the audit log kept 6 years | Each quarter's CSV and §3, dated, with what was removed |
| Automated de-provisioning | Remove (portal Team, back office People) and the Remove operator workflow end access at the next request; suspending Google Workspace ends Google sign-ins; the checklist for the rest (branch) | The workflow run, the `operator.remove` audit row, and a logged test with a dummy user |
| Information Security Policy | `docs/security.md` is the technical record it points to | The signed policy |
| Data deletion and retention policy | Client exit: access and tokens at once, files after 30 days, rows within 30 more; bank data as below; audit log 6 years; Neon history 7 days | The audit rows `client.retire`, `client.purge_files`, `client.purge` |
| Vulnerability scanning | Dependabot, CodeQL and OSV-Scanner (branch); secret scanning | Security tab; the workflows' runs |
| Patch vulnerabilities within a defined SLA | Critical 7 days, high 30, medium 90, low 180; a daily workflow puts each alert in an issue with its due date (branch) | Each month's Vulnerability deadlines summary; closed `vulnerability` issues |
| EOL software monitoring and policy | `docs/eol-inventory.md`, reviewed quarterly; Node 24 before Node 22's end (branch) | The inventory with each review's date |

## 2. Decisions (2026-11-09)

**Bank data.** Disconnecting the bank feed removes the item at Plaid and deletes the access token
at once, and nothing more is read. Transactions already synced are the client's business records:
kept while it is a client, deleted when it leaves (files 30 days after retiring, rows within 30
days after that). They are not deleted connection by connection: synced records are immutable and
are copied into events and the runs that used them. A client that wants its data gone sooner
leaves through the same steps. Plaid access tokens are encrypted with the client's own key, never
shown or logged.

**Portal sign-in.** A session only for email and password (with WorkOS MFA), a passkey, or a
client's SSO where its identity provider requires MFA. Everything else is refused in code, and
switched off in WorkOS so the MCP connector is held to it too.

**Identity provider for our own tools:** Google Workspace. It is already our email, and suspending
an account there ends every Google sign-in at once. Okta adds a vendor and a cost for a small team.

**Zero trust, in practice.** The surfaces:
- the back office (`/ops`, `/api/ops`, the Ops MCP connector): per person and per role through
  WorkOS, MFA, session limits and the audit log;
- staging (`staging.mezonas.com`): behind Cloudflare Access with Google Workspace, our people
  only. Webhook paths and `/mcp` bypass Access; they check their own signatures and tokens;
- vendors' consoles: Google sign-in where offered, else MFA by app or passkey; one account per
  person, none shared;
- keys: only in GitHub secrets and Worker secrets, set by workflows, never held by people.
Production's `/ops` stays on WorkOS alone: Access in front of it would break the MCP connector
and the webhooks for no gain over the per-person controls already there.

**Patching deadlines:** critical 7 days, high 30, medium 90, low 180 ("low as scheduled" made
concrete: by the next quarterly review at the latest).

**Where the written policies live:** outside the repo, in the compliance folder; they point at
`docs/security.md` for the technical controls.

## 3. Accounts inventory

One row per system. Fill in the people; this is the baseline for the first access review and the
offboarding checklist (`docs/operations.md` §1.3).

| System | Holds client or bank data | Who has access, and role | MFA enforced | Google sign-in | Removed by |
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
| Mezonas back office (production) | everything | `/ops/audit` → Access review | WorkOS | — | Remove operator workflow |

The repository is under a personal account, which can't require 2FA of others: check each
collaborator's, or move it to an organization that requires it.

## 4. Draft: "Reason for data access"

> Mezonas is a back-office service for small and mid-sized businesses. A business's administrator
> connects the business's own bank and card accounts through Plaid Link in the Mezonas client
> portal. We request only the Transactions product, read-only. We use it to match the business's
> bank and card transactions with its bills, receipts and invoices and to keep its bookkeeping
> (QuickBooks Online) current; changes to its books need the business's approval by default. We
> never move money: we refuse any connection with Auth, Transfer, Payment Initiation or Signal. A
> business's data is used only for that business.

## 5. What's left, in order

1. Merge the branch (`docs/hipaa-plan.md` §1 has the order).
2. The settings in `docs/security.md` §10, "Still to set", with a screenshot each.
3. Plaid dashboard: the "Reason for data access" field (§4). The Legal Entity Identifier is
   optional; skip it unless Plaid asks.
4. Fill in §3, then the first access review.
5. A dummy-user offboarding test: invite, sign in, remove, confirm the refusal; log it.
6. The written policies (outside the repo).
7. The evidence folder, one subfolder per attestation (§1's last column), then attest.

## 6. After attesting

These are in `docs/hipaa-plan.md` §8, the one routines table:
- monthly: the patch deadlines summary;
- quarterly: access review and the EOL inventory;
- yearly: review and re-sign the policies;
- each person who leaves: the offboarding checklist, logged.
