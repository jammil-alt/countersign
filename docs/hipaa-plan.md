# HIPAA, SOC 2 and PCI: what's still open

The plan from here to a client in HIPAA mode, a SOC 2 report and a PCI self-assessment.
`docs/security.md` has what is done. The design is in `docs/plan.md` §1.35.
Plaid's attestations (`docs/plaid-plan.md`) need the same policies and routines.
Last updated 2026-11-09.

**Where we are:**
- The technical controls are built: #81–#84 are on staging; the second round (below) is on
  `claude/clever-volta-s13mur`, not merged yet.
- The first settings (WorkOS, Cloudflare, GitHub, Neon) are done; a second list is open (§2).
- Nothing administrative has started: no BAAs, policies, risk assessment or audit. We write those
  outside the repo.
- No client can be put in HIPAA mode until the first BAAs are signed.

## 1. Merge the code

#81–#84 are merged. The second round is on `claude/clever-volta-s13mur`; split it into pull
requests in this order (CLAUDE.md: sign-in and CI changes go alone):

| Commit | What | Notes |
|---|---|---|
| Sign-in | A session only for password (with MFA), passkey or SSO sign-ins | Turn the other methods off in WorkOS first (§2), so nobody meets the refusal unwarned |
| HIPAA mode | T1 (Ops MCP connector) and T2 (Builder, run questions) | |
| De-provisioning | Remove a client's person; Remove operator workflow | |
| CI | CodeQL v4, OSV-Scanner, patch deadlines | Then add `ALERTS_TOKEN` and the required check (§2) |
| Node 24 | `.nvmrc`, engines, `@types/node` 24 | Node 22 ends 2027-04-30 |
| Docs | This file, `security.md`, `operations.md` §1.3–1.4, `plaid-plan.md`, `eol-inventory.md` | |

## 2. Settings outside the code

Set on 2026-11-06: WorkOS (MFA and session limits), Cloudflare, GitHub and Neon. The record is
`docs/security.md` §10. Still to set: `docs/security.md` §10, "Still to set" (WorkOS sign-in
methods, Google Workspace 2-Step Verification, GitHub 2FA, `ALERTS_TOKEN`, Cloudflare Access on
staging, the bank feed's webhook in the rate-limit exclusions, MFA on every console).

## 3. Technical items still open

| # | Item | Why it matters | Suggested fix |
|---|---|---|---|
| T1 | ~~The Ops MCP connector doesn't check HIPAA mode.~~ **Done (branch):** a client in HIPAA mode is left out of the operator's MCP session, so of every tool, until `claude_ai` is in `BAA_PROCESSORS`. | Anthropic's BAA for claude.ai plans, if any, differs from the API's. | List `claude_ai` only once the plan we use is covered. |
| T2 | ~~The Builder's model calls aren't held to HIPAA mode.~~ **Done (branch):** the Builder on a HIPAA client's agent, and questions about its runs, are refused unless the model's provider is covered. | | |
| T3 | Clients can't see their own audit log. | Covered entities may ask for an access report. | A portal page, `client_admin` only, showing their own client's rows. |
| T4 | Audit log retention past 6 years is manual. | It only matters in 2032, but should be written down. | A yearly owner task, or a script like `db:purge-client`. |
| T5 | Data at other vendors is deleted by hand when a client leaves: Twilio subaccount, ElevenLabs transcripts, Resend domain, Stripe customer. | A missed step leaves health data behind. | Keep the checklist (`docs/operations.md` §1.2); automate it later. |
| T6 | Records and files rely on Neon's and R2's encryption at rest, not our own. | Accepted by all three frameworks. Some clients ask for client-held keys. | Revisit if a client asks: encrypt files and sensitive columns with the client's data key. |
| T7 | The Cloudflare rate limit is per path, not per hostname (Free plan). It's 10-second blocks. | Enough for now. | Upgrade to Pro if abuse shows up, then scope it to `app.` and `staging.`. |
| T8 | When notification emails are built, they must carry no record content. | Email isn't a safe channel for health data. | A count and a link only (plan §1.35). Check it in that PR. |
| T9 | Sentry is kept out of scope by scrubbing, not by a BAA. | A scrubber miss could send health data. | Get Sentry's BAA if its plan allows, or keep the scrubber tests strict. |
| T10 | No penetration test yet. | Expected for SOC 2 and by larger clients. | Once a year, from an outside firm, after the MVP. |

## 4. BAAs (business associate agreements)

Two directions:
- **With our clients:** Mezonas is their business associate. We sign their BAA, or offer ours,
  before switching a client to HIPAA mode. We need a BAA template, reviewed by counsel.
- **With our vendors:** each vendor that receives a HIPAA client's data must sign a BAA with us.
  Most only do so on business or enterprise plans; check current terms with each.

| Vendor | Needed for | Status | Then add to `BAA_PROCESSORS` |
|---|---|---|---|
| Cloudflare | Every HIPAA client | Not started | `cloudflare` |
| Neon | Every HIPAA client | Not started | `neon` |
| WorkOS | Every HIPAA client | Not started | `workos` |
| Anthropic (API) | Agents and document reading | Not started | `anthropic` |
| Anthropic (claude.ai) | The Ops MCP connector (T1) | Not started | `claude_ai` |
| Plaid | The bank feed | Not started; may not sign one | `plaid` |
| OpenAI | Only agents set to `openai:` models | Not needed yet | `openai` |
| Twilio | Texts and calls | Not started | `twilio` |
| ElevenLabs | Live calls | Not started | `elevenlabs` |
| Resend | Our sending email | Not started | `resend` |
| Meta (WhatsApp) | WhatsApp | Meta doesn't sign BAAs as far as we know; keep WhatsApp off for HIPAA clients | none |

Each signed BAA becomes a one-line pull request to `apps/api/wrangler.jsonc`. Keep the signed copy
with the policies.

## 5. Administrative work

These are the HIPAA Security Rule's administrative safeguards, which are most of SOC 2's common
criteria too. Written policies and records count as much as code.

- [ ] **Security officer:** name one person, probably the owner.
- [ ] **Risk analysis** (§164.308(a)(1)): what could go wrong, how likely, what we do about it.
      Redo yearly and after big changes.
- [ ] **Policies:**
  - information security;
  - access control (who gets which role, and how access is removed);
  - acceptable use;
  - incident response and breach notification (HIPAA: clients told without unreasonable delay,
    within 60 days at most);
  - business continuity and backups;
  - vendor management;
  - data retention and disposal;
  - change management (our PR rules);
  - laptop and workstation rules (disk encryption, screen lock, no client data on personal
    devices).
- [ ] **Training:** security and HIPAA awareness for everyone with operator access, at hire and
      yearly; keep a record.
- [ ] **Sanctions policy:** what happens when someone breaks the policies.
- [ ] **Background checks** for operators, if we choose (SOC 2 asks about them).
- [ ] **Client contract terms:** the BAA, a data processing addendum, the subprocessor list (the
      site has one), and notice of subprocessor changes.

## 6. SOC 2

1. Pick the scope: Security, plus Availability and Confidentiality.
2. Consider a compliance tool (Vanta, Drata, Secureframe). They collect evidence from GitHub,
   Cloudflare, WorkOS and Neon automatically and come with policy templates.
3. **Type I:** an auditor checks the controls exist at a point in time.
4. **Type II:** an observation period of 3–12 months showing they work. The quarterly routines
   below are the evidence.

## 7. PCI DSS

Mezonas doesn't take card payments itself: Stripe's hosted invoices do. That likely means
**SAQ A**, a yearly self-assessment questionnaire. Confirm it with Stripe's guidance. Keep it that
way: no card fields in our pages, and card numbers never stored (already enforced).

## 8. Routines

| How often | What | Where |
|---|---|---|
| Every quarter | Access review: remove anyone who shouldn't be there; save the CSV with the date | `/ops/audit` → Access review |
| Every quarter | Restore test from Neon's history; note the result | `docs/operations.md` §4 |
| Monthly | Merge Dependabot's grouped update once green | GitHub |
| Monthly | Review the patch deadlines: open and overdue alerts in the latest Vulnerability deadlines run; save its summary (critical 7 days, high 30, medium 90, low 180) | `docs/operations.md` §1.4 |
| As they come | Fix Dependabot, CodeQL and OSV-Scanner alerts within their deadline, and secret-scanning alerts at once | GitHub → Security, issues labelled `vulnerability` |
| Every quarter | End-of-life review: update `docs/eol-inventory.md`, plan anything within 12 months | `docs/eol-inventory.md` |
| Each person who leaves | The offboarding checklist, the same day, logged | `docs/operations.md` §1.3 |
| Yearly | Risk analysis, policy review, training, penetration test (from T10) | — |
| On each client exit | Retire, the vendor checklist, then the row purge within 30 days of the files' deletion | `docs/operations.md` §1.2 |

## 9. Decisions for the owner

- [ ] When to start the BAAs, and which plans we're willing to pay for (most BAAs need a higher
      tier).
- [ ] Whether to use a compliance tool for SOC 2, and when to start the Type II period.
- [ ] Counsel for the client BAA template and contract terms.
