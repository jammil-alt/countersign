# HIPAA, SOC 2 and PCI: what's still open

The plan from here to a client in HIPAA mode, a SOC 2 report and a PCI self-assessment.
`docs/security.md` has what is done. The design is in `docs/plan.md` §1.35.
Plaid's attestations (`docs/plaid-plan.md`) need the same policies and routines.
Last updated 2026-11-06.

Until #82 and #84 merge, `docs/plan.md` §1.35 and `docs/operations.md` §1.2 exist only on their
branches.

**Where we are:**
- The technical controls are built and green, in four pull requests not yet merged.
- The settings in WorkOS, Cloudflare, GitHub and Neon are done.
- Nothing administrative has started: no BAAs, policies, risk assessment or audit.
- No client can be put in HIPAA mode until the first BAAs are signed.

## 1. Merge the code

| PR | What | Order |
|---|---|---|
| #81 | CI: no database copy (CI never connects to Neon), CodeQL, Dependabot | First. "analyze" is a required check and comes from this PR |
| #83 | Sign-in: 30-minute idle limit, 12-hour sessions | Any time after #81 |
| #82 | Migration 0017: the audit log, `tenant.retired_at`, plan §1.35 | Before #84 |
| #84 | The controls and the back-office screens | Last. Retarget its base to `main` first |

After #81 is merged, open PRs need "Update branch" so their CodeQL check runs. Each merge deploys
to staging.

## 2. Settings outside the code

All set on 2026-11-06: WorkOS (MFA and session limits), Cloudflare, GitHub and Neon. The record is
`docs/security.md` §10.

## 3. Technical items still open

| # | Item | Why it matters | Suggested fix |
|---|---|---|---|
| T1 | **The Ops MCP connector doesn't check HIPAA mode.** An operator using Claude with the connector sends what the tools return to Anthropic through claude.ai. | That's a disclosure to a vendor unless it's covered. Anthropic's BAA for claude.ai plans, if any, may differ from the API's. | Refuse MCP tools on clients in HIPAA mode unless a `claude_ai` processor is listed, or until the plan we use is covered. Small change in `apps/api/src/mcp`. |
| T2 | The Builder's model calls aren't held to HIPAA mode. | Fine while the Builder only sees templates. Not fine if an operator pastes a HIPAA client's data into it. | Gate the Builder for client agents of HIPAA clients, or write it into the policy. |
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
| Anthropic (claude.ai) | The Ops MCP connector (T1) | Not started | after T1 |
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
| Monthly | Merge Dependabot's grouped update once green; security updates as they arrive, within a month (PCI DSS 6.3.3) | GitHub |
| As they come | Fix CodeQL findings and secret-scanning alerts | GitHub → Security |
| Yearly | Risk analysis, policy review, training, penetration test (from T10) | — |
| On each client exit | Retire, the vendor checklist, then the purge after 30 days | `docs/operations.md` §1.2 |

## 9. Decisions for the owner

- [ ] When to start the BAAs, and which plans we're willing to pay for (most BAAs need a higher
      tier).
- [ ] Whether to fix T1 now (the MCP connector and HIPAA clients), or rule out using it on them in
      policy.
- [ ] Whether to use a compliance tool for SOC 2, and when to start the Type II period.
- [ ] Counsel for the client BAA template and contract terms.
