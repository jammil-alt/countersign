# Plaid compliance: the 11 attestations

What Plaid's Compliance Center asks of us, what we have, and what's left. The controls are in the
register (`packages/core/src/compliance/controls.ts`, shown at `/ops/security`); how the code
enforces them is in `docs/security.md`; what we commit to is in `docs/policies/`. HIPAA, SOC 2 and
PCI are in `docs/hipaa-plan.md`. It is mostly the same work: one set of controls, policies and
routines covers all of them.

- Entity: Twelve Thirty-Four Consulting LLC. App: Mezonas.
- Questionnaire submitted 2026-11-08. Plaid's deadline for all 11 attestations: **2027-05-10**.
  Our target: attest by **2027-04-10**.
- Plaid's production review and the OAuth banks' registration are separate (`docs/open.md` K3).
- Last updated 2026-11-20.

**Where we are:** the technical controls for all 11 are on `main` and on staging, and both policies
are adopted (2026-11-09). What's left is settings in vendors' consoles (`docs/security.md` §10,
"Still to set"), the accounts inventory (§3), and collecting the evidence.

Plaid Link runs in the client portal: a client's admin connects the business's bank or card account
there (`packages/connectors/src/bankfeed`, `docs/plan.md` §1.52). The portal is our
"consumer-facing app" for these attestations, though its users are businesses.

## 1. The attestations: control and evidence

| Plaid attestation | The control | Register | Evidence to collect |
|---|---|---|---|
| MFA on consumer-facing app (Plaid Link) | WorkOS multi-factor is required for every sign-in (owner, 2026-11-16; `docs/open.md` A1). Our own second step (`docs/plan.md` §1.100) is built and takes over once Twilio Verify is on (A2); it asks Google and Microsoft sign-ins too. A client's SSO uses its own second factor | ACC-2 | WorkOS → Authentication → Multi-factor auth; a portal sign-in showing the second factor; `docs/security.md` §2 |
| MFA on internal systems with consumer data | Passkeys or hardware keys on every system that holds client data or can change production (`docs/policies/information-security.md` §3). In place on Google, GitHub, Cloudflare, Sentry and Stripe; Neon and WorkOS's dashboard have an authenticator app (WorkOS offers no passkey); Intuit and Plaid not recorded (`docs/security.md` §10, 2026-11-18) | ACC-2 (partial) | A screenshot per row of §3 |
| Zero trust access architecture | No servers, admin ports or VPN: Workers and vendors' consoles. Every request is checked for its person, role and client (WorkOS, a second factor, session limits, row-level security, the audit log). No person holds the database owner's password. Named accounts only | ACC-1, ACC-4, ISO-1 | §2 below as the description; `docs/security.md` §1–2 and §8 |
| Access control policy | `docs/policies/information-security.md` §3: least privilege, named accounts, MFA, sessions 30 minutes idle and 12 hours, joining and leaving, quarterly review | GOV-2, ACC-4 | The policy, with its record of approval |
| Periodic access reviews and audits | `/ops/security/audit?view=access` (a dated CSV) every quarter, plus §3 for our other systems; the audit log kept 6 years | ACC-5 (partial), LOG-1 | Each quarter's CSV and §3, dated, with what was removed |
| Automated de-provisioning | Remove (the portal's Team, the back office's People and Users) and Actions → Remove operator end access within 5 minutes; the rest of the steps within one business day (`docs/operations.md` §1.3) | ACC-6 | The workflow run, the `operator.remove` audit row, and a logged test with a dummy user |
| Information Security Policy | `docs/policies/information-security.md`, v1.0, adopted 2026-11-09 | GOV-2 | The policy |
| Data deletion and retention policy | `docs/policies/data-retention.md`, v1.0. Disconnecting a bank removes the Plaid item and the token at once; a client's files are deleted 30 days after it leaves and its rows purged then; backups expire 7 days later; the audit log is kept 6 years | LIF-1, LIF-2 | The policy; the audit rows `client.retire`, `client.purge_files`, `client.purge` |
| Vulnerability scanning | Dependabot, CodeQL and OSV-Scanner on every change and weekly; secret scanning with push protection; production scanned from outside every week once it has its first release | CHG-3, CHG-7 | The Security tab; the workflows' runs; the production scan's issue |
| Patch vulnerabilities within a defined SLA | Critical 7 days, high 30, medium and low at the next monthly update (policy §6). A daily workflow puts each alert in an issue with its due date | CHG-4 | Each month's Vulnerability deadlines summary; closed `vulnerability` issues |
| EOL software monitoring and policy | Policy §6: monthly updates, and an end-of-life component replaced within 90 days. `docs/eol-inventory.md`, reviewed every quarter | None yet (policy §6) | The inventory with each review's date |

## 2. Decisions

**Bank data** (`docs/policies/data-retention.md` §5). We read bank and card data only to keep the
client's books and reconcile its accounts; we never sell it, share it for advertising or train
models on it. Disconnecting a bank removes the item at Plaid and deletes the access token at once,
and nothing more is read. Transactions already read stay part of the client's books until the client
leaves, then go with its rows. Plaid access tokens are encrypted with the client's own key, never
shown or logged.

**Portal sign-in.** A second factor on every sign-in except a client's SSO; Google sign-ins get a
code too (owner). An earlier plan to refuse Google, Microsoft, GitHub and Apple sign-ins was dropped:
it went against that decision (`docs/merge-backlog.md`).

**Zero trust, in practice.** The surfaces:
- the back office (`/ops`, `/api/ops`, the MCP connector): per person and per role, through WorkOS,
  a second factor, session limits and the audit log. Once our own second step is on, the MCP
  connector answers no tool call until the person approves that Claude sign-in from a browser that
  passed it (`docs/plan.md` §1.120);
- vendors' consoles: one named account per person, none shared, each with a passkey or hardware key;
- keys: only in GitHub secrets and Worker secrets, set by workflows, never held by people. The
  database owner's connection is fetched inside each workflow (`docs/operations.md`, "Break-glass
  database access").

**Patching deadlines and end of life:** as the policy says (§1). An earlier draft had medium 90 days
and low 180; the policy is stricter and wins.

**Where the policies live:** `docs/policies/`, with their record of approval. The register points at
them.

**Open (owner):**
- The retention policy lets a client ask for specific data to be deleted within 30 days. Nothing in
  the product deletes one bank's transactions short of the client leaving, because synced records are
  immutable history (CLAUDE.md invariant 3). Decide how we answer such a request before the first
  one comes.
- Whether to put staging (`staging.mezonas.com`) behind Cloudflare Access, with Google Workspace as
  the identity provider and the webhook paths, `/mcp` and the phone and desktop apps' routes let
  through. Plaid's zero trust question doesn't require it.

## 3. Accounts inventory

One row per system. Fill in the people. This is the baseline for the first access review and the
list for the leaving steps (`docs/operations.md` §1.3).

| System | Holds client or bank data | Who has access, and role | Passkey or key enforced | Removed by |
|---|---|---|---|---|
| Google Workspace | email | the owner, admin | passkeys; 2-Step Verification enforced (2026-11-18) | suspend the user |
| GitHub (`jammil-alt/countersign`) | code, Actions secrets | `jammil-alt` only, admin | passkeys (2026-11-18) | remove the collaborator |
| Cloudflare | all traffic, R2 files, Workers | the owner, Super Administrator | security keys; required for every member (2026-11-18) | |
| Neon | the database | the owner, Admin | authenticator app; required for the organization (2026-11-18) | |
| WorkOS dashboard | app users' names and emails | the owner, Admin | authenticator app (no passkey offered); team requirement off (2026-11-18) | |
| Intuit developer portal | QuickBooks app keys | | | |
| Plaid dashboard | bank items | | | |
| Domain registrar and DNS | none | | | |
| Sentry | scrubbed error reports | the owner, Owner | Touch ID; required (2026-11-18) | |
| Stripe | billing | the owner, Owner | passkeys; team requirement off (2026-11-18) | |
| Twilio, Resend, ElevenLabs | messages and calls, when used | | | |
| Model providers' consoles (Anthropic, OpenAI, xAI, Google) | API keys | | | |
| Mezonas back office, production and staging | everything | `/ops/security/audit?view=access` | WorkOS | Actions → Remove operator |

The repository is under a personal account, which can't require 2FA of others. It has one
collaborator today; before adding anyone, check their two-factor, or move it to an organization
that requires it (`docs/security.md` §10).

## 4. Draft: "Reason for data access"

> Mezonas is a back-office service for small and mid-sized businesses. A business's administrator
> connects the business's own bank and card accounts through Plaid Link in the Mezonas client
> portal. We request only the Transactions product, read-only, with the account balances it returns.
> We use it to match the business's bank and card transactions with its bills, receipts and
> invoices and to keep its bookkeeping (QuickBooks Online) current; changes to its books need the
> business's approval by default. We never move money: we refuse any connection with Auth,
> Transfer, Payment Initiation or Signal. A business's data is used only for that business.

## 5. What's left, in order

1. The settings in `docs/security.md` §10, "Still to set", with a dated screenshot each.
2. Plaid dashboard: the "Reason for data access" field (§4). The Legal Entity Identifier is
   optional; skip it unless Plaid asks.
3. Fill in §3, then the first access review.
4. A dummy-user leaving test: invite, sign in, remove, confirm the refusal; log it.
5. Everyone with access confirms the policies in writing (control GOV-4).
6. The evidence folder, one subfolder per attestation (§1's last column), then attest.

## 6. After attesting

The routines are in `docs/hipaa-plan.md` §8, the one table:
- monthly: the patch deadlines summary;
- every quarter: the access review and the end-of-life inventory;
- every year: review and re-approve the policies;
- each person who leaves: the leaving steps, dated.
