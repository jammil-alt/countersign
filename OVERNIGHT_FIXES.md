# Overnight remediation plan (2026-11-23)

What to fix from the two staging walks (`MERGE_QA.md` W1–W14, the full regression `QA2` of 22 Nov,
and two sign-in problems the owner reported), split into streams that one session each can work on
overnight without colliding. Every cause below was traced in the code; file and line references
are in each stream's brief.

**What the walks proved.** No client saw another's data, the portal showed no cost or prompts,
approvals held every write, a QuickBooks bill was written exactly once, a rejected card wrote
nothing, and a second approve was refused. Nothing here is a data leak. Two findings widen access
or hide a failure from a client, so they go first.

## How the night runs

- **One session per stream**, each on its own branch with a draft PR opened at the first push
  (CLAUDE.md). Workers don't edit `docs/plan.md`, `docs/open.md` or `docs/work-plan.md`: each puts
  its plan entry in its PR description, and one docs PR lands at the end.
- **No migrations tonight.** None of these fixes needs one. A stream that finds it does stops that
  item and leaves it for the morning.
- **Sign-in changes get their own PR** (CLAUDE.md), so S1's sign-in fixes are separate from its
  access fixes.
- **Merging** (owner's choice, asked separately): either a coordinator merges each PR when its CI is
  green, one at a time, which deploys to staging only; or every PR is left ready for the morning.
  Nothing goes to production either way.
- **Merge order**, to keep the shared language files from conflicting: S1, S2, S3, S4, S6, S7, then
  S5 (the widest) last. Each PR merges `main` in right before it is marked ready.
- **No staging data is changed by a session.** Things that need a person in the back office are in
  "Morning steps".
- Each fix comes with a test that fails before it and passes after. `pnpm check` green before ready.

## The streams

### S1. Access and sign-in (first; two PRs: access, then sign-in)

| # | Fix | From | Size |
|---|---|---|---|
| S1.1 | **Changing a person from Admin back to User gives them every agent with approvals on**, losing the limits set before. On a switch to User, start from the narrow choice (approvals off, agents to pick); the server refuses an Admin→User change that doesn't say which agents and whether they approve. `apps/web/src/people/Access.tsx:101-105`, `apps/api/src/routes/onboarding.ts:211-217`. | PP3 | S–M |
| S1.2 | A new User invite starts with "Approves changes" ticked. Default it to off (decision taken; reversible). `people/Members.tsx:161`, `onboarding.ts:340`. | PP3 | S |
| S1.3 | The team row says "Works on Bill clerk" and "Can read everything". Make it "Doesn't approve." `en.ts:2159`. | PP4 | S |
| S1.4 | Security → Clients says "Last sign-in: Never" for every client. Sign-in rows have no client; join them to the person's memberships. `apps/api/src/routes/compliance.ts:192-202`, `routes/session.ts:156-171`. | SC1 | S |
| S1.5 | **"Remember this browser for 30 days" doesn't remember.** Cause in the sign-in brief below. Own PR. | Owner | — |
| S1.6 | **Sign-out takes two clicks.** Cause in the sign-in brief below. Same PR as S1.5. | Owner | — |

### S2. Sloan answers, or says it couldn't

| # | Fix | From | Size |
|---|---|---|---|
| S2.1 | **When Sloan's answer fails, the client sees "Sloan is answering…" forever.** On a failed or escalated `account.chat` run, code (not the model) posts a fixed message in the thread: "I couldn't answer that. We've told your lead." The panel also stops waiting after a timeout. `apps/web/src/portal/screens/Sloan.tsx:204`, where `run.failed` is dispatched in `apps/api`. | SN1, SN7 | M |
| S2.2 | Sloan's "what is waiting" reads full Desk items (22 change cards) and resends them with every model call, so one question cost $0.32 against a $0.30 cap. Return a slim list (id, title, kind, due); the detail stays with `account.explain_wait`. `packages/agents/src/tools/account.ts`, `packages/core/src/account/views.ts:35`. | SN1 | S |
| S2.3 | **Sloan answers about any company name with this client's data.** Its prompt never names the client. `account.owner` returns the client's name, and `account.chat` gets one line: "You serve only <client>. If a message names another business, say you can only speak for <client>'s account." Built-in skill, so it ships with the code. `account.ts:618-632`. | BX5 | S |
| S2.4 | A new Sloan seed version (`supervisor.v7.json`, extends 6) with the answer step's model and budget set (decision D1). Reaches each client's Sloan only through the reviewed update merge (morning step). | SN1 | S |
| S2.5 | Sloan can't tell a client how to add a Knowledge note. Add a Knowledge entry to the portal guide (`packages/core/src/help/guide.ts`). Saving notes itself is decision D2. | SN6 | S |
| S2.6 | Reggie and Sloan quote UTC times. Give both the client's time zone and the current time in the prompt. `apps/api/src/reggie/reggie.ts:67-99, 185`, `packages/agents/src/runtime/run-agent.ts:783`. | HM4 | S |

### S3. Runs, records and documents

| # | Fix | From | Size |
|---|---|---|---|
| S3.1 | **A bill's page doesn't list the run that created it.** The run keeps QuickBooks' id `149`; the page looks up `Bill:149`. Match both forms in `toolRefs`, and fix the test that seeds a bare id. `apps/api/src/runs/record-runs.ts:57-63`, `record-runs.test.ts:166-206`. | W1, WR5 | S |
| S3.2 | A vendor's page and search show no runs for a vendor runs created bills for. Write tools name their counterparty (the vendor) as a second subject; search and the `about=` filter use the same match as the record page; the hourly backfill picks up runs missing the new rows. `packages/agents/src/log/run-subjects.ts`, `apps/api/src/runs/about.ts`, `runs/subject-log.ts:104`, the QuickBooks write tools. | W2, CL2 | M |
| S3.3 | **A bill made by a run never gets its document.** A document is linked once, on arrival, before the bill exists. When sync brings in a bill, link the document from the run whose `qbo.bill.create` returned that id. `apps/api/src/qbo/store.ts`, `packages/documents/src/link.ts`. | CL3, WR5 | M |
| S3.4 | The seeded Bill clerk template never attaches the invoice on its new-bill path (only on the itemize path). Template v5 adds attach after create, approval required. Reaches client agents only by the reviewed update merge. `packages/db/seed/agents/bill-clerk.v4.json:514-546`. | WR5 | S |
| S3.5 | Prepare bill is told to cite the document and reading ids but isn't given them, so its sources say "no document id was provided". Pass `documentId` in; set sources in code. `packages/agents/src/tools/docs-split.ts:321-334`. | WR7 | S |
| S3.6 | A test run accepts a payload that doesn't match its trigger (30 Sandbox runs failed on "Invalid UUID at documentId"). Refuse it with a 422 before a run is made. `apps/api/src/routes/ops-agents.ts:507-515`, `packages/workflows/src/router.ts:696-744`. | HM4 | S |
| S3.7 | **A connection whose stored sign-in can't be opened still reads Connected.** A credential that can't be decrypted raises "needs attention" like a refused sign-in. `apps/api/src/qbo/sync.ts`. And the portal's connector page shows the sync time it loaded with; reload it after a sync. | R12 | S |

Left for later (bigger, or a template decision): the model picking accounts afresh each run with no
vendor history or deterministic check (WR7's two accounts for the same items), the vendor written
with its name only, and a test run's lookup after a simulated create.

### S4. Your call, Home and run states (back office)

| # | Fix | From | Size |
|---|---|---|---|
| S4.1 | Home lists each failed Sloan run twice and titles it "escalated: max_cost". Skip a failed run that an open item already names; put escalation reasons into words. `apps/api/src/routes/command-center.ts:116-123, 413-432`. | HM1 | S |
| S4.2 | Your call's header count stays stale after Done or Later. Reload it after a write. `apps/web/src/ops/OpsLayout.tsx:138-148`. | HM2 | S |
| S4.3 | A snoozed to-do can't be found again. Add a Snoozed view. `apps/api/src/work/todos.ts:55-60`, `packages/core/src/api/todos.ts`. | HM2 | M |
| S4.4 | Resolved Escalations still read "Waiting on the client admin for 11 days". | HM3 | S |
| S4.5 | **A run whose approval expired reads Stopped, with its change "Waiting for approval".** On expiry, mark the change not made with `approval_expired`, worded "Not made: no answer in time". `apps/api/src/runs/ports.ts:804-816`, `packages/agents/src/log/external-actions.ts`. Old rows stay as they are tonight (a backfill is a morning decision). | PH4 | M |
| S4.6 | Accounts says "2 clients need us" while Home says nothing does. Accounts reuses Needs us per client (decision D5). `apps/api/src/runs/account-report.ts:188-200`. | W4 | M |
| S4.7 | "Critical, held 0" above "held for review" runs: rename to "Agents on safety hold" and "Run to check". `packages/core/src/work/call.ts:105, 192`. | W8 | S |
| S4.8 | Failed model calls are counted as calls with no tokens. Count them apart. `apps/api/src/routes/usage-spend.ts:198`. | W7, US1 | S |
| S4.9 | Step counts: 14, 18 and 13 for one agent; 8 and 10 for one run. One definition, labelled. "The latest 50" over 21 rows. | TP1, RN4, W13 | S |

### S5. Dates, time zones and raw codes (widest; merges last)

| # | Fix | From | Size |
|---|---|---|---|
| S5.1 | One date format everywhere ("23 Nov 2026"). Replace the hand-made helpers `shortDay` (`packages/core/src/work/deals.ts:278`) and `shortDate` (`apps/web/src/ops/work/parts.tsx:13`) and the raw `2026-11-22` slices with the shared formatter (`apps/web/src/i18n/format.ts`). `shortDay` is used in `ops/work/sales/DealPage.tsx:660,970`, `sales/parts.tsx:114-129`, `sales/TermsPanel.tsx:85`, `onboarding/ClientFile.tsx:144,258,295,310`, and in server-built text at `apps/api/src/routes/deals.ts:339,406`, `onboarding/invite.ts:655,664,1264`, `account-deal.ts:165`, `packages/core/src/work/work-order.ts:62,127`. `shortDate` in `ops/client/ClientOverview.tsx:91,177,462`, `ops/client/SetupProgress.tsx:104,242,301,333`, `ops/work/build/IssuePage.tsx`, `EnhancementPage.tsx:93`. Raw slices: `ops/agents/VersionsTab.tsx:224`, `ops/skills/SkillPage.tsx:268`, `ops/skills/AutomationPage.tsx:181`, `ops/builder/reshape-step.tsx:454`, `ops/security/Evidence.tsx:28,88,113`, `ops/work/onboarding/SignUpNow.tsx:226`, `InviteSheet.tsx:1067`, `packages/core/src/assurance/build.ts:59,312,314`. Leave the date pickers (`<input type="date">`) as they are. | W10, TP2, HM2 | M |
| S5.2 | **The deal timeline stamps "Nov 23 20:58" for 22 Nov 20:58**: UTC day beside the browser's clock. `DealPage.tsx:658-661`. | SL3 | S |
| S5.3 | The portal home flips from "Sunday evening" to "Monday morning" two seconds after loading (browser zone, then client zone). Use the client's zone from the start. | PH1 | S |
| S5.4 | A 1–30 Nov period's links start "31 Oct". Show the filter chip in the client's zone, and the end as the last day. `apps/web/src/portal/screens/Runs.tsx:283-286`, `ops/screens/Runs.tsx:135-138`. | W10 | S |
| S5.5 | Usage "Today", a client's "Next run" and Reggie's answers use UTC. Use the client's or the operator's zone, and say which. | US1, CL1 | S |
| S5.6 | Raw codes on screen: "Qbo", "QboBill:146", "Tool: Qbo" with a JSON dump, "changed in qbo", "Query purchaseorder", "Record ·f752ac" and "vendor:59" chips, `No qbo connection is bound for "qbo.vendor.create"`, `trg-invoice-read`, `totalsValid`, a dated model id, money as $0.2106. Pass the names table where it is missing; use the cost formatter. Sites: `apps/web/src/records/RecordDetail.tsx:102,137-138,251,279` call `connectorName(id)` with no names (`apps/web/src/inbox/change.ts:449-452`; the names are in `apps/web/src/runs/labels.ts:211-244`); `ops/screens/Runs.tsx:102,227` and portal `Runs.tsx:175` pass an empty connectors map; `runs/labels.ts:176-183` has no `qbo.*.query` names (use the manifest's entity label, `packages/connectors/src/qbo/index.ts:144`; also `apps/api/src/platform.ts:121-125`); a role with no label is humanised at `packages/core/src/reach/rules.ts:92-96`; raw four-decimal money at `ops/agents/ReportTab.tsx:53,59`, `ops/interviews/InterviewsScreen.tsx:244`, `ops/lab/ScorecardScreen.tsx:26`, `ops/builder/reshape-step.tsx:435` (use `apps/web/src/usage/format.ts`). | W11, CL2, TP3, LB1 | M |
| S5.7 | The Spanish chart still says "We start it by hand", "the run stops", "Adds bills to QuickBooks Online": server-built English. Return keys from `packages/core/src/sop/build.ts` and translate in the app. Also the inbox's "Add … to the directory" titles. | W12, PL1 | M |

### S6. Setup, builder and the back office's smaller screens

| # | Fix | From | Size |
|---|---|---|---|
| S6.1 | A new client's runbook reads "day 2 of about 17" and "Day 17 · done". Leave Sloan out of "live"; say "Next: kickoff, planned day 2"; don't mark the invite sent when none went. `apps/api/src/setup/board.ts:249-272`, `ops/client/SetupProgress.tsx:314-320`. | W3, CL8 | S |
| S6.2 | A new client is never sent to Getting started: Home counts Sloan as a live service. `apps/web/src/portal/screens/Home.tsx:106-116`, `apps/api/src/weekly/stats.ts:137`. | W14 | S |
| S6.3 | Trying a draft in Draft phase fails with "examples are tried in the POC test". Send an all-steps try to the test-run route. `apps/web/src/ops/flow/TryPanel.tsx:319`. | W5, A4 | S |
| S6.4 | Evidence has no client or agent picker. `apps/web/src/ops/security/Evidence.tsx`. | W6, B7 | S |
| S6.5 | A draft's invalid schedule ("99 99 99 99 99", zone "Not/AZone") shows as On with no issue. Run the validator on stored drafts and show its issues on the Triggers rows. | LB4 | S |
| S6.6 | The Builder says "I made 5 decisions" where the build lists 2. | LB3 | S |
| S6.7 | An unpublished template draft is offered as a template for new agents. Offer published versions only. | TP1 | S |
| S6.8 | The deal form's "Add the deal" stays disabled with no hint that "A month" is needed; deals aren't found by ⌘K. | SL2, HM5 | S |
| S6.9 | Audit: the run page's 2-second poll writes an audit row each time ("opened 182 times"). Keep every row (invariant 14), tag polls, and count a person's opens as visits. Show actions in words with names, not API paths and ids. `apps/api/src/http.ts:902-955`, `routes/audit-export.ts:226-349`, `ops/screens/AuditLog.tsx:441`. | PH4, SC2 | M |

### S7. Portal pages and the SOP

| # | Fix | From | Size |
|---|---|---|---|
| S7.1 | Procedures says "Live" for a paused agent. Add Paused to the SOP stage, without making the hourly check record a revision on every pause. `packages/core/src/sop/build.ts:148-153`, `apps/api/src/sop/change-routes.ts:88`. | W9 | M |
| S7.2 | "In trial" in the back office, "On trial" in the portal: "In trial" everywhere. "First revision" on 4.0 → "First recorded revision". | W9 | S |
| S7.3 | A portal request has no number and says "We're on it" at once. Show its number; say "Sent" until someone picks it up. | PH3 | S |
| S7.4 | The approval card for a new vendor says "Nothing recorded"; the bill card's Evidence has no link to its PDF. | WR3 | S |
| S7.5 | Controls 31 of 45, 43 and 42 on three screens; open items 22, 24 and 26. Label each count by what it counts. | SC1, CL1 | S |

## Owner decisions (answer any time; each stream uses the default until then)

| # | Decision | Default tonight |
|---|---|---|
| D1 | Sloan's answer model and cost cap. Opus with a $0.30 cap fails on ordinary questions. | Sonnet 5.5 on the answer step, cap unchanged at $0.30. |
| D2 | May Sloan save a Knowledge note for the client (as a Desk item the admin signs)? Today it can't, by design (ARCHITECTURE §9.8). | No; it tells the client how to add one. |
| D3 | A User invite approves changes by default. | Off. |
| D4 | Reject asks for no reason and has no undo. | Unchanged; an optional reason box is a later item. |
| D5 | Accounts' "need us" uses a different, wider definition than Home. | Use Home's definition. |
| D6 | Count audit "opens" as visits (a person's opens within 30 minutes count once). | Yes. |
| D7 | Old runs whose approval expired keep "Waiting for approval" until backfilled. | Not backfilled tonight. |
| D8 | Start trial, Nudge and the pack reports are hard to find (both walks missed them first). | Not changed tonight. |
| D9 | Staging data: Demo client's contacts hold a real-looking gmail address (Susana Arce); an operator with an outside address (Darren Marshal) serves 4 of 5 clients. | Not touched. Confirm both are intended. |

## Morning steps (a person in the back office)

1. Merge the Sloan update (S2.4) into Demo client's Sloan, and the Bill clerk template update (S3.4)
   where it applies. Both are reviewed update merges.
2. Publish a new version of Demo client's own "AP bill clerk" with "Attach the invoice to the bill"
   back after "Create the bill" (`documentId` from the trigger, `entityId` from the create step,
   approval required). Version 4 dropped it on 11 Nov after a test-run failure that no longer
   happens.
3. Reconnect Sandbox's QuickBooks if Sandbox should be testable.
4. Clean up the walks' test data (both walks' Clean-up sheets).
5. Re-run the checks that failed (a short script follows the night's merges).

## Not tonight

Prompt caching in the agent loop (it would have kept Sloan's question well under its cap), account
choice from the vendor's history with a deterministic check, structured vendor details from
invoices, an optional reason on Reject, and a backfill of expired approvals. Each is worth its own
item once the night's work has landed.
