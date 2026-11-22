# Working through the open list (2026-11-22)

`docs/open.md` says what is still open. This page puts it in the order we work it: one item at a
time, each its own branch and PR, each ending green. Two tracks run side by side:

- **Track C, code.** We build it. Most items need no key and no decision.
- **Track O, the owner.** Keys, accounts, settings, the lawyer and decisions. Ordered by what each
  one unblocks.

The owner's priority still holds: **1. purchasing, 2. the site, 3. the connectors and the rest.**
Bookkeeping sits beside purchasing because it is one code fix away from being safe to switch on.

## How each item is worked

1. A branch per item, and its draft PR opened with the first push (CLAUDE.md).
2. A migration goes in its own PR, merged first; the code follows in a second PR.
3. `pnpm check` is green before the PR is marked ready.
4. When it merges, the item is struck from `docs/open.md` and ticked here.
5. A decision the code needs and nobody has made: the simplest option, recorded in `docs/plan.md`
   §1 with a `// DECISION:` comment, and listed under "Decisions taken for you" at the end of the PR.

Items marked **parallel** touch separate files and can run in their own sessions at the same time.

## Track C: code, in order

### C0. Land what is open (first)

| # | What | Done when |
|---|---|---|
| C0.1 | Review and merge jammil-alt/countersign#518 (each way a workflow starts, with its own first steps). | Merged, staging green. |
| C0.2 | jammil-alt/countersign#519 and jammil-alt/countersign#520 are the same branch opened twice: close #519 (the draft), review and merge #520. | One PR left, merged. |
| C0.3 | jammil-alt/countersign#501 (main merged into the issue close-out): finish it or close it. | Owner says which. |
| C0.4 | Bring `docs/open.md` up to date: its date, §1e's PRs (merged or not), the merged items still listed, and "Docs housekeeping" (ARCHITECTURE is v0.21 now; only Marketing and Bookkeeping are still to be folded in). Delete `docs/merge-backlog.md` if every row is done. | The list matches `main`. |

### C1. Bookkeeping, safe to switch on (`open.md` §1b, `plan.md` §1.145)

| # | What | Size | Done when |
|---|---|---|---|
| C1.1 | **A check right before each write.** A booking already laid out for a signature when the bank re-sent the transaction can still be approved alongside the new copy. Before each posting, re-read the bank transaction's chain and refuse when another copy is posted or approved. A new template version (v5), reaching client agents only through the reviewed update. | M | A test signs both copies and sees one write. |
| C1.2 | **Deposits and transfers written but never recorded.** They don't sync back from QuickBooks, so the guard can't see them. Before writing one, ask QuickBooks for a deposit or transfer that carries the transaction's mark (`[Mezonas bt-<id>]`) and record it as posted if found. | M | A test stops a run after the write; the next run records it, not writes it again. |
| C1.3 | `qbo/NOTES.md`: add the query C1.2 relies on to the sandbox checks (K4). | S | Listed. |

Bookkeeping stays off for clients until C1.1 and C1.2 merge and K1–K5 are walked.

### C2. Purchasing (`open.md` §1.4)

| # | What | Size | Done when |
|---|---|---|---|
| C2.1 | **Migration: `vendor_item`** (`plan.md` §1.88): each vendor's items for the client, with pack size, unit conversion, last price and preferred vendor. Tenant RLS. Its own PR. | S | Already built: migration 0047 (found 2026-11-22; `open.md` was stale). |
| C2.2 | **The vendor catalog's code**: filled from the bill-price import and from quotes; matching reads its pack size and conversion (fewer lines held since §1.144); the vendor pick prefers the preferred vendor; a screen in the Materials pack. | L | The purchasing email test passes with a line that matched only through `vendor_item`. |
| C2.3 | **Replies from a colleague's address.** Today they are dropped. Keep them on the thread as unverified for a person to enter, as late replies already are (§1.129). Never answer the reach-out from them. | S | Test: a reply from another address at the vendor waits on the thread. |
| C2.4 | **QuickBooks item ids on PO lines**: a catalog item tied to its QuickBooks item, so PO lines can be item lines. After C2.2. | M | A PO with one item line and one account line. |
| C2.5 | RFQs in the vendor's language. Waits for the owner's RFQ wording (§1.3). | S | |

### C3. Reporting and search by data (new: `docs/reporting-plan.md`)

R1 to R6 in that page's order. R1's migration is its own PR. The owner answered its §5 on 2026-11-22.

### C4. Pre-launch hardening and compliance (`open.md` §4; each **parallel**)

| # | What | Size |
|---|---|---|
| C4.1 | **T1**: the MCP server holds to a client's HIPAA mode (`hipaa-plan.md`). Before any HIPAA client. | S |
| C4.2 | **H8**: `refresh_failing` connections counted in the ops MCP's `needsAttention` and the daily troubled list. | S |
| C4.3 | **H7**: the portal's resume screen shows the events that arrived while an agent was paused (`missedEvents`), with the copy in six languages. | S |
| C4.4 | **H5**: voice typing's model calls write usage and cost rows. | S |
| C4.5 | **H10**: the two texting edge cases (a double submit's 500, a used invitation still showing the form). | S |
| C4.6 | **Fingerprints** on the back office's own resolve (`/api/ops/inbox/:id/resolve`) and the operator's step-in (audit 3.4). | S |
| C4.7 | **H4**: a per-site limit on the beacon (its own Rate Limiting binding, in `wrangler.jsonc`). | S |
| C4.8 | **H9**: each language's wording loaded on demand, the first load back under 470 kB. | M |
| C4.9 | **H6**: who is asking on the Claude approval page. Migration on `mcp_session_approval` (own PR), then the code. | M |
| C4.10 | **Urgent notices** through the outbox: migration of `notification_kind_check` (own PR), then send from the outbox, never held for quiet hours. | M |
| C4.11 | **M9**: the phone's signed text v2 (`mezonas-sign:v2`) covering an answer's text and a note. | S |

### C5. The desktop app's API (`open.md` §4, D2–D3)

| # | What | Size |
|---|---|---|
| C5.1 | **D2, migration**: `desktop_device` and `desktop_job`, tenant RLS, never deleted. Own PR. | S |
| C5.2 | **D3, the API**: device registration and folders (client admin), the device's signed routes, `services.desktop`, the connector registered, files into documents. Contract tests: no portal route returns the key; a revoked computer is refused. | L |
| C5.3 | **D7**: the handoff's audit row names the desktop, and the confirm page before the handoff (shared with M8). | M |

### C6. Builder, SOP and assurance follow-ups (each **parallel**)

G3 (a POC try on a Sandbox record; a skill tried on a document), G4 (a decision's words changed on
its card; a custom skill's write in the high-risk check), G5 (known risks counted from runs;
deleting a learned note), G10 and G11 (the setup checklist and client adjustments gaps), G12 (area
owners read feedback's link), F-C (the drafter names the step), S-E (an issue links to its skill
build and the Dev queue), SOP-2 (Sloan's `sop.read`, the Procedures page), SOP-W's chart words in six
languages, assurance A4 (evidence export, the `/ops/security` rollup), the two missing assurance
checks (no secret in a stored model request; OAuth scopes as granted), and the AI providers' terms
in `packages/core/src/assurance/terms.ts` from their public pages.

Need a model key to re-record fixtures (`LLM_MODE=record`), so they wait for one: SOP-B (the
Builder writes each step's purpose), G6 (`manual.read` for every agent), A3 (attack cases).

### C7. Onboarding's smaller items (`plan.md` §1.149.5–6)

Delivered and bounced from Resend's webhooks; "send it again" for an invite that didn't go; "Just
the account" sends our own welcome email; the retention job for lost prospects. Each a small PR.

### C8. Docs

ARCHITECTURE: fold in the Marketing area (`marketing-plan.md` §9) and the Bookkeeping area
(`plan.md` §1.79–§1.80, §1.145). CLAUDE.md's status line and version (it still says v0.15).
`hipaa-plan.md` §1's merged PRs.

### Not planned

F-E (new step kinds for "Ask an agent"), D8 (the desktop's next features), a Zoho Books, Inventory
or Expense connector, SharePoint. Each waits for the owner to ask.

## Track O: the owner, by what each step unblocks

Steps that take days or weeks to come back are marked **start now**.

| Order | Step | Unblocks |
|---|---|---|
| 1 | **P1** Email Routing for `in.staging.mezonas.com` | The buyer, forwarded invoices, Sloan by email, P5. |
| 2 | **P2** Resend: key, fallback domain, `mezonas.com` verified | RFQs and POs, Sloan's answers, onboarding's invites. |
| 3 | **P3** Intuit sandbox keys; **P4** confirm the model key | QuickBooks for the buyer and the Bookkeeper; re-recording fixtures. |
| 4 | **K1** Plaid sandbox keys | The Bookkeeper on staging (after C1). |
| 5 | **S1–S2** the site's DNS and its deploy | The site; then S4. |
| 6 | **S6** Search Console (**start now**: it collects from the day it is verified) | Marketing's reports. |
| 7 | **A4** finish staging's sign-in switch-over; **H3** Hyperdrive caching and `staging`'s branches | Sign-in codes; quick deploys from branches. |
| 8 | **Start now**: Google OAuth verification (S4, after S1–S2), Intuit's app review, Plaid's production review and OAuth banks (K3), the Apple Developer Program with a D-U-N-S number (M3, D5), Meta business verification (A6), the lawyer's reads (S3, S8, S13, calls and texts). | Production for each provider. |
| 9 | Production's first `v*` release, with A3 and A5. | Everything merged since `747d7ff` reaching clients. |

**Decisions, best answered in one sitting:** the buyer's four (§1.3), K6 (Plaid's price, the auto
threshold, learned rules), SOP-Q, the builder's §11.5 if not settled by #498, G13, M7 and M10, the
billing prices and allowances, the name pool, Sloan's words on the site.

## The next two days

Several sessions at once, one item each:

- **Day 1.** C0 (merge, close, refresh `open.md`). C1.1 and C1.2. C2.1, the migration. C4.1 and
  C4.2 in parallel. R1's migration once the owner has answered `reporting-plan.md` §5 question 1.
- **Day 2.** C2.2. R1's writer and backfill, then R2. C4.3 to C4.6 in parallel.
- **After that.** R3 to R6, C5, the rest of C4, C6 and C7, in that order.

## Progress

Tick each one as it merges. Round 1 (2026-11-22): C1.1–C1.3 #525, C2.2 #529, C4.1 #526, C4.2 #527,
C4.6 #528, C4.8 #531, R1 #524 and #530.

- [x] C0.1 [x] C0.2 [ ] C0.3 [x] C0.4
- [x] C1.1 [x] C1.2 [x] C1.3
- [x] C2.1 [x] C2.2 [x] C2.3 [ ] C2.4 [ ] C2.5
- [x] R1 [x] R2 [ ] R3 [ ] R4 [ ] R5 [ ] R6
- [x] C4.1 [x] C4.2 [x] C4.3 [x] C4.4 [x] C4.5 [x] C4.6 [x] C4.7 [x] C4.8 [ ] C4.9 [ ] C4.10 [ ] C4.11
- [ ] C5.1 [ ] C5.2 [ ] C5.3
- [ ] C6 [ ] C7 [ ] C8
