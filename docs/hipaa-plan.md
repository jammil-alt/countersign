# HIPAA, SOC 2 and PCI: what's still open

> **Status (2026-11-26): Live.** T1 and T2 built; §1 merged. What's open: `docs/open.md` §14.2.

The plan from here to a client in HIPAA mode, a SOC 2 report and a PCI self-assessment.
`docs/security.md` has what is done. The design is in `docs/plan.md` §1.35. Each control, its
status and its SOC 2, HIPAA and PCI references are in the register
(`packages/core/src/compliance/controls.ts`), shown in the back office at `/ops/security`
(`docs/plan.md` §1.102). Plaid's 11 attestations need the same controls, policies and routines:
`docs/plaid-plan.md`.
Last updated 2026-11-22.

**Where we are:**
- The technical controls are built and on staging (`docs/security.md`, status).
- The first settings in WorkOS, Cloudflare, GitHub and Neon are done; a second list is open (§2).
- The information security and data retention policies are adopted (2026-11-09,
  `docs/policies/`). No BAAs, risk analysis or audit yet.
- No client can be put in HIPAA mode until the first BAAs are signed.

## 1. Merge the code

Done. #81–#84 merged by 2026-11-09. The rest followed: CodeQL v4 (#315), OSV-Scanner and patch
deadlines (#316), Node 24 (#317), the register (#318), removing people (#325, #370) and the model
gate (#414), then the MCP connector's HIPAA check (T1, §1.190). What is left in code is T3 (§3).

## 2. Settings outside the code

Set on 2026-11-06: WorkOS (MFA and session limits), Cloudflare, GitHub and Neon. WorkOS multi-factor
is required for every sign-in since 2026-11-16. The record is `docs/security.md` §10. Still to set:
`docs/security.md` §10, "Still to set" (passkeys on Neon and WorkOS's dashboard, Intuit and
Plaid's second factors, Google Workspace's allowed methods, the scan as a required check,
`ALERTS_TOKEN`, the bank feed's webhook in the rate limit's exclusions). Staff second factors on
the rest were set on 2026-11-18.

## 3. Technical items still open

| # | Item | Why it matters | Suggested fix |
|---|---|---|---|
| T1 | Done (2026-11-22, `docs/plan.md` §1.190): the Ops MCP connector is held to HIPAA mode. A call that names a client in HIPAA mode is refused, a call across clients is refused while the operator serves one, and whoami and clients_list leave it out, until `claude_ai` is in `BAA_PROCESSORS` (`apps/api/src/mcp/hipaa.ts`). | Was: an operator using Claude with the connector sent what the tools return to Anthropic through claude.ai, a disclosure unless covered. | Nothing left. |
| T2 | Done (2026-11-17, PR #414): the Builder's model calls, and every other model call outside a run, go through one entry point held to the HIPAA mode of each client whose data they may carry (`apps/api/src/compliance/models.ts`, `docs/plan.md` §1.143). Work on a template or a shared skill names no client. | Was: fine while the Builder only sees templates, not if an operator pastes a HIPAA client's data into it. | Nothing left. |
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
| OpenAI | Only agents set to `openai:` models | Not needed yet | `openai` |
| xAI | Only agents set to `xai:` models (Grok) | Not needed yet | `xai` |
| Google (Gemini API) | Only agents set to `google:` models (Gemini) | Not needed yet | `google` |
| Twilio | Texts and calls | Not started | `twilio` |
| ElevenLabs | Live calls | Not started | `elevenlabs` |
| Resend | Our sending email | Not started | `resend` |
| Plaid | The bank feed | Not started; may not sign one. Until then, no bank feed for HIPAA clients | `plaid` |
| BILL | The BILL connector (plan §1.87), on our developer key | Not started | `billcom` |
| Meta (WhatsApp) | WhatsApp | Meta doesn't sign BAAs as far as we know; keep WhatsApp off for HIPAA clients | none |

Each signed BAA becomes a one-line pull request to `apps/api/wrangler.jsonc`. Keep the signed copy
with the policies.

## 5. Administrative work

These are the HIPAA Security Rule's administrative safeguards, which are most of SOC 2's common
criteria too. Written policies and records count as much as code.

- [x] **Security officer:** Jammil, Founder & CEO (2026-11-09, `docs/policies/information-security.md`).
- [ ] **Risk analysis** (§164.308(a)(1)): what could go wrong, how likely, what we do about it.
      Redo yearly and after big changes.
- [ ] **Policies** (drafted 2026-11-09: `docs/policies/information-security.md` covers information
      security, access control, change management, vulnerabilities, incidents, backups and devices;
      `docs/policies/data-retention.md` covers retention and disposal; drafted 2026-11-22 for the
      owner to adopt, §1.218: `change-management.md`, `incident-response.md`,
      `vendor-management.md`):
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

Where we stand against each criterion: `/ops/security/soc2` (plan §1.218).

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
| Every quarter | Access review: remove anyone who shouldn't be there; record it (the record keeps who was found and who should go, downloadable as CSV) | `/ops/security/soc2` → Record this quarter's review |
| Yearly | Deletion drill on staging: a Sandbox client purged end to end, nothing left | `docs/operations.md` §1.2 |
| Every quarter | Restore test from Neon's history; note the result | `docs/operations.md` §4 |
| Weekly | Read the production scan's issue; fix findings on the policy's deadlines | GitHub → Issues, "Production scan: findings" |
| Every quarter | Review Cloudflare's Security Insights; fix or accept each finding | Cloudflare → Security Center |
| Monthly | Merge Dependabot's grouped update once green | GitHub |
| Monthly | Read the latest Vulnerability deadlines run: fix or plan anything near its date; save its summary with the date | `docs/operations.md` §2 |
| As they come | Fix Dependabot, CodeQL and OSV-Scanner alerts within the policy's deadlines (critical 7 days, high 30, medium and low at the next monthly update); secret-scanning alerts at once | GitHub → Security, issues labelled `vulnerability` |
| Every quarter | End-of-life review: update `docs/eol-inventory.md`; plan anything within 12 months of its end | `docs/eol-inventory.md` |
| Each person who leaves | The leaving steps, within one business day, each dated | `docs/operations.md` §1.3 |
| Yearly | Risk analysis, policy review, training, penetration test (from T10) | — |
| On each client exit | Retire, the vendor checklist, then the row purge once the files are gone (day 30) | `docs/operations.md` §1.2 |

## 9. Decisions for the owner

- [ ] When to start the BAAs, and which plans we're willing to pay for (most BAAs need a higher
      tier).
- [x] T1 (the MCP connector and HIPAA clients): build it when the first HIPAA client comes
      (2026-11-16).
- [ ] Whether to use a compliance tool for SOC 2, and when to start the Type II period.
- [ ] Counsel for the client BAA template and contract terms.
