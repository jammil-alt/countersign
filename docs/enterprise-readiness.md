# Enterprise readiness (2026-11-15)

The owner's list of what to close before the first enterprise and high-volume pilot clients, checked
against the code on 2026-11-15. What matters most for pilots: **a clean security answer for the
client's IT, getting started smoothly, and the tool working smoothly from day one.**

The list came in two groups: platform work done once, and setup repeated for each new client.
Safety items are built as **platform rules** that every connector inherits, not as QuickBooks
code: high-volume clients won't all be on QuickBooks.

## Open question for the owner (decide first)

**Which accounting system or ERP are the pilot and high-volume prospects on?** QuickBooks is our only
accounting connector. Neither ARCHITECTURE nor the plan mentions NetSuite, Sage Intacct, Dynamics,
Xero or Yardi. A new accounting connector is real work (sync, mapping, write tools with undo,
catch-up sync, a live-sandbox pass), and partner or sandbox access can take weeks, so it should start
early. Adding one changes ARCHITECTURE's v1 scope, which is the owner's call.

## Items that don't apply to our stack

| Item on the list | Here |
|---|---|
| Supabase service-role key | No Supabase. The Worker is `cs_worker`, which can't bypass RLS; only migrations use the owner role. |
| Inngest concurrency | Cloudflare Workflows. A per-client run cap is under "Later". |
| Gmail push | Gmail is send only; inbound email comes through Cloudflare Email Routing, already push. |
| KMS envelope encryption | Each client has its own data key wrapped by `ENCRYPTION_KEY`; re-wrapping after a rotation exists (`packages/connectors/src/tenant-keys.ts`). Same pattern, not a cloud KMS. Enough for pilots. |

## Already built

| Item | Where |
|---|---|
| Idempotency keys on writes | Each write is one `external_action` with a key, passed to the provider by the connectors |
| QuickBooks SyncToken | `packages/connectors/src/qbo/` (fake only) |
| Reversal | The undo window, and a person's undo of a done write from its before state |
| Missing tenant → zero rows; cross-client tests in CI | RLS falls back to `{}` (migration 0000); `packages/db/src/rls.test.ts` |
| `SET LOCAL` | `set_config(…, true)` inside each transaction (`packages/db/src/client.ts`) |
| SSO | WorkOS; SSO sign-ins are exempt from our second step |
| Audit export | `/ops/security/audit` with CSV (operators only) |
| Catch-up sync for QuickBooks | CDC with its 30-day lookback, starts over past that (`qbo/sync.ts`) |
| LLM cost per client | `usage_daily` per client and agent |
| Run budgets | Per agent bundle (`maxSteps`, `maxCostUsd`) |
| Approval thresholds; client staff approve | Approver rules match on amount (`packages/core/src/approvals/rules.ts`); client users sign |
| Shadow mode | Agent stages bench → trial → signoff → live; trial and sign-off sign every write |
| Backups | Neon point-in-time history, 7 days |
| Sentry alerts to the phone | Documented in `docs/operations.md`; set by hand in Sentry, **not checked** |

## Gaps

### Platform rules (code, one PR each, every connector inherits them)

| # | Gap | Fix |
|---|---|---|
| E1 | **Token refresh has no lock across Worker isolates.** QuickBooks' guard is per isolate (`qbo/api.ts:283`), and the shared OAuth layer (`packages/connectors/src/oauth/tokens.ts`) has none for Outlook, Zoho, HubSpot, Ramp, Gmail, Sheets. Two refreshes at once spend a rotated token and the connection drops. | A lock on the connection's row (or its credentials row) in the shared OAuth layer; the second caller re-reads the stored token. |
| E2 | **No block on closed accounting periods.** Nothing reads QuickBooks' `BookCloseDate`. | A platform lock date per client connection, set at onboarding; the gate refuses a write dated on or before it. Each write tool declares its posting-date input; a connector may supply the system's own close date (QuickBooks `BookCloseDate`, Xero lock date, NetSuite closed periods), and a person can set it by hand for a system without one. |
| E3 | **Vendor bank and remittance fields have no hard rule.** Approval is on by default but can be loosened per step. | Write tools declare sensitive fields (bank account, remit-to, payment email); the gate always requires a signature on a change to them, whatever the step, matrix or mode. |
| E4 | **The kill switch is soft.** Pause (per agent, per client) stops new runs; running ones finish. No platform-wide stop. | A hard stop that also cancels waiting writes, per agent and per client, and an operator "all writes off" across clients. |
| E5 | **Stale-write check, generalised.** SyncToken is QuickBooks' version. Not checked whether the runtime already compares the approved `before` with the record just before writing. | Check first. If missing: re-read before `run`, refuse if it changed since the approver saw it, using the system's own version when it has one. |

### Security answer for IT

| # | Gap | Fix |
|---|---|---|
| E6 | **Multi-factor is optional today** (`docs/open.md` A1), while `docs/security.md` says it's required. | Owner: WorkOS back to required now, or `TWILIO_VERIFY_SERVICE_SID` so our own second step (A2) turns on. |
| E7 | No security packet for reviewers. | A two-page overview and pre-filled answers to the standard questionnaire, from `docs/security.md` and the controls register. Refresh `docs/security.md` (it still says "in PR" for merged work). |
| E8 | Clients can't see their own audit log (`docs/hipaa-plan.md` T3, control LOG-3). | A portal page, `client_admin` only. |
| E9 | Data residency. | US only (Neon `aws-us-east-2`). Say so in the packet; EU hosting is later. |

### Getting started and running smoothly

| # | Gap | Fix |
|---|---|---|
| E10 | **Nothing has run against a live provider.** | The QuickBooks sandbox pass (`docs/open.md` P3): the first real run of the write path (approval, once-only, undo), useful whichever system pilots use. Then the pilots' own system. |
| E11 | No pilot onboarding checklist. | One checklist from the per-client list below, mapped to what exists (`docs/operations.md` §1.1, agent stages). |
| E12 | No runbooks. | Connection dropped, run stuck, wrong write. |
| E13 | No status page. | A hosted one. |
| E14 | First quarterly restore test not done (control BCK-2). | Do it and record it (`docs/operations.md` §4). |
| E15 | No tagged production release and no written rollback. | Cut the first `v*` release; write rollback (Worker versions roll back; migrations only go forward). |
| E16 | Bulk approvals: not checked. The inbox and desk screens may have it. | Check. |

### Later (not for pilots)

Per-client caps on runs and connection calls (QuickBooks has a per-realm throttle per isolate);
a priority queue for model calls; `raw_record` partitioning (today one index on
`tenant_id, entity_type`); a separate ElevenLabs workspace for Mezonas; Yardi partner access (start
the application early if a pilot needs it); EU hosting; SOC 2; a penetration test (T10).

## Per client (startup checklist, for E11)

- Create the client, roles and SSO.
- Connect their tools and set each connection's permission matrix.
- First historical sync, under the per-client limits.
- Note their ERP customisations and custom fields.
- Set the closed-period lock date (E2).
- Twilio A2P 10DLC registration if we text for them (built, M41; takes weeks).
- Data residency check (E9).
- Run budgets and cost alerts.
- Approvers and approval thresholds.
- Agent stages: trial for 2–4 weeks (every write signed), then sign-off, then live with automatic
  writes only for low-risk actions.

## Suggested order

1. Owner: answer the open question; E6 (five minutes in WorkOS).
2. Code: E1, E2, E3, E4, E5 (check first).
3. Docs: E7, E11, E12.
4. Then E10 (needs the Intuit sandbox keys), E8, E13, E14, E15.
