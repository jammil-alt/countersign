# Documents

Where each document lives and whether it is still a plan. Updated 2026-11-26.

**Start with `docs/open.md`**: the one forward plan, its To do on top. Every plan below that is
done or partly done says so in a status line under its title, and what is left of it is in
`docs/open.md`, not in the plan. A new plan document gets a row here and, once built, its status
line.

## Live: read these to work

| Document | What it is |
|---|---|
| `docs/open.md` | Everything still to do, by area, To do first. |
| `docs/ARCHITECTURE.md` | What the platform is (v0.24). Changed by a new version, never silently. |
| `docs/plan.md` | How it was built: milestones and every decision (§1.x), in order. The record, not a to-do. |
| `docs/operations.md` | Environments, secrets, CI, deploys, the owner's setup steps. |
| `docs/local-development.md` | Running it locally. |
| `docs/security.md` | The security controls and the settings in each console. |
| `docs/step-model-plan.md` | The step model: agreed design, as built; its follow-ups are in `open.md` §2. |
| `docs/hipaa-plan.md` | HIPAA, SOC 2 and PCI: what's built and the owner's open steps. |
| `docs/plaid-plan.md` | Plaid's attestation, due 2027-04-10. |
| `docs/marketing/trust-plan.md` | What we promise clients about their data, and what's left to back it. |
| `docs/enterprise-readiness.md` | The enterprise pilots' list (E1–E16). |
| `docs/policies/` | The company's policies (three still drafts). |
| `docs/eol-inventory.md` | The end-of-life register, reviewed each quarter. |
| `docs/marketing/claims.md`, `privacy-measurement-draft.md`, `processor-terms-draft.md` | Content and drafts waiting on the owner and the lawyer. |
| `docs/design/` | The owner's prototype and the mock-ups. |
| `docs/connect-zapier.md`, `docs/10dlc/` | How-tos for clients and for texting registration. |

## Plans, partly done (the rest is in `open.md`)

| Document | Status |
|---|---|
| `docs/audit-plan.md` | The 2026-11-11 performance audit; what's open is `open.md` §13. |
| `docs/cases-plan.md` | Sales, onboarding and Build; O4–O6 open (§10). |
| `docs/forms-plan.md` | Forms; F-4 to F-6 open (§10). |
| `docs/sop-plan.md` | The agent's SOP; §7 and S3 open (§11). |
| `docs/agent-assurance-plan.md` | Agent assurance; A3 open (§11). |
| `docs/marketing-plan.md` | The Marketing area; built, the owner's steps and the v5 agent set open (§8). |

## Done: kept as the record (code cites them)

`docs/builder-plan.md` (superseded by the step model), `docs/setup-plan.md`,
`docs/connectors-plan.md`, `docs/reporting-plan.md`, `docs/ui-plan.md`, `docs/work-plan.md`,
`docs/merge-backlog.md`, `docs/audit-plan-run.md`, `docs/speed-run/`, and the root checklists
`STAGING_QA.md`, `PLATFORM_QA.md` and `BUILDER_QA.md`.

## Not started

`docs/fpa-plan.md`: on hold until the owner says (`open.md` §17).

## Next to the code

Each connector's unchecked facts are in `packages/connectors/src/<name>/NOTES.md`; each app and
pack has a `README.md`; the design system's brand book is `packages/design-system/README.md`.
