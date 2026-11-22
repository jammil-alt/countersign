# After the merge: what 21–22 November built, and how we check it (2026-11-22)

In about 24 hours, 74 pull requests merged to `main` (#507 to #593) and 8 are still open. Almost all
of it was built and tested by code alone: against fake providers, with model answers written by
hand, and without anyone looking at the screens on staging. The tests pass. What nobody has done yet
is use it.

This page says what was built in plain words, what is still underway, what the review found, and the
QA plan to run once the open work has merged. It was written from the pull requests, `main` at
`d2ac8cd3`, the deploy runs and Sentry. Staging itself was not read: the Claude connector for staging
was waiting for the operator's approval.

## 1. What we built, in groups

| Group | In plain words | Pull requests |
|---|---|---|
| **A. Building an agent** | The builder's chart is easier to read: each step shows who does it (a tool, the AI, rules or a person). Schedules and reminders are picked in words. You can see exactly what the AI will be given before any run, try just some of the steps with made-up data, and give each way a workflow starts its own first steps. | #507, #512, #513, #517, #518, #520 |
| **B. What a client can read about their agent** | Every agent has a written procedure (the SOP) with revisions, a read-only flowchart (the Workflow tab), and an "Architecture and security" section with 17 checks that run every night. The AI providers' data terms are listed. | #508, #510, #511, #514, #515, #516, #576, #578 |
| **C. Starting a client** | The client admin sets up in the portal: who fills each role, which tools are connected, a try on real documents, then a signed scope. We get a Setup tab with progress and a Nudge. Invite emails show delivered or bounced, can be sent again, and a plain new account gets our own welcome. A client contact can answer a process interview from a link with no sign-in. Lost prospects' files are deleted after 12 months. | #522, #564, #565, #567, #570, #572, #573, #574 |
| **D. The staging walk-through's fixes** | The problems you found on 22 November: counts that disagreed, links that opened the wrong place, costs that didn't add up, test runs that failed, four statuses for one agent, three date formats. | #523 |
| **E. Safer writes** | The Bookkeeper can no longer write the same bank transaction twice. Before an agent writes to a client's tool, a second AI call checks the write and shows its evidence. An approval is refused if the card changed after you looked. A phone signature now covers the answer and the note. | #525, #528, #542, #569 |
| **F. Purchasing** | The buyer matches lines through each vendor's own catalog and fills it from bills and quotes. A reply from a vendor's colleague is kept for a person instead of dropped. Purchase orders can carry QuickBooks item lines. | #529, #533, #545 |
| **G. Reports and finding runs** | Every run records what it was about. Runs can be found by vendor, customer, document or number. A record's page lists the runs that touched it. There is a report per agent, a report per account, a list of all accounts for us, and saved views in the portal. | #524, #530, #534, #544, #556, #577, #581, #582 |
| **H. Counting what it costs us** | Tiny model calls no longer read $0.00. Voice typing, emails, texts, browser minutes, bank feeds and the back office's own AI use are counted. Evals bill to their own key so Usage can match Anthropic's console. | #536, #540, #559, #580, #591 |
| **I. Hardening and compliance** | A HIPAA client is kept out of the Claude connector. Failing connections are counted. The app's first load went from 495 kB to 302 kB. The Claude approval page says who is asking. Urgent notices retry. A SOC 2 checklist, a recorded access review and a deletion drill exist. | #526, #527, #531, #535, #537, #538, #541, #543, #539, #547, #553, #560, #571 |
| **J. The desktop app's server side** | A client admin can pair a computer and choose its folders; the computer fetches jobs and sends files with signed requests. Opening the phone or desktop app from the browser asks first. | #546, #548, #562 |
| **K. New accounting building blocks** | One matching engine for "these two lists should agree". A Books health report: nine problems in a client's QuickBooks, ranked by dollars. Reports emailed from systems with no API land as rows. Packs install one way, with settings. Bills to pay, with a weekly approve-to-pay list (nothing is paid). | #555, #558, #563, #566, #568, #584, #585 |
| **L. Housekeeping** | Plans and the open list updated, a flaky test fixed, a by-hand tool to repair staging's lost keys. | #521, #532, #550, #557, #586, #593 |

Fourteen migrations landed: 0074, 0075, 0077 to 0080, 0085, 0087 and 0095 to 0100.

## 2. Still underway (8 open)

| PR | What it adds | State at 20:07 UTC |
|---|---|---|
| #590 | The work-delivered statement: each month, what the agents did, as a page and a PDF with the invoice. | Ready. Merges clean. CI running. |
| #583 | The Close pack: a month-end checklist, journal entries written only after approval, a signed-off month that can't change. | Ready, but **conflicts with `main`** (about 10 files after #585). No CI on its newest push. Its tables (0099) are already on `main`. |
| #554 | The eval harness: 74 golden cases that fail CI when a change makes an agent's writes worse, and a scorecard. | Ready, but **conflicts with `main`** (`apps/web/src/ops/routes.tsx`). No CI on its newest push. |
| #587 | The manual counts how often runs hit each known risk; a learned note can be deleted. | Draft. Merges clean. CI not run. |
| #588 | The drafter names the step each gap belongs to. | Draft. Merges clean. CI not run. |
| #589 | Try a template on a Sandbox record, and a skill on a document. | Draft. Merges clean. CI not run. Needs the Sandbox's QuickBooks connected. |
| #592 | Two more security checks: no secret in what goes to the AI; sign-ins granted no more than asked. | Draft. Merges clean. CI not run. |
| #595 | A client's request becomes one suggestion that states the exact change. | Draft. Merges clean. CI not run. |

Not open anywhere, and owed: the docs for round 4 and Wave Y (finding F3).

## 3. What the review found

| # | Finding | Why it matters |
|---|---|---|
| F1 | **Staging's QuickBooks is down.** A deploy replaced staging's encryption key on 21 November. Every connection saved before that can't be opened. Sentry shows more than 400 errors, still arriving every 15 minutes (MEZONAS-API-C, D, H), and a failed reconnect at 19:25 UTC (MEZONAS-WEB-8). The repair tool merged in #593. It has not been run. | Books health, the Bookkeeper, the Close pack, bills to pay and #589 can't be tested until it is. |
| F2 | Two ready PRs conflict with `main` (#583, #554), and five drafts have never run CI. | They can't merge as they are. |
| F3 | **The docs are behind the code.** `docs/plan.md` has no entry for §1.208 to §1.214 (round 4) or §1.230 to §1.236 (Wave Y), though the code cites them. `docs/work-plan.md` shows R4, R5 and R6 unticked. `docs/open.md` says "migrations through 0080". CLAUDE.md's status line is dated 8 November and says v0.15 and 0040; ARCHITECTURE is v0.22 and the migrations reach 0100. Several PRs moved their plan entry to the PR description "so round 4's docs land together"; that docs PR was never opened. | The decisions taken for you live only in PR descriptions. |
| F4 | Almost nothing was seen. #523 says "None of this was checked against staging data". #522 had no look in a browser. The interview, the verifier, the matching engine's AI tier and the eval cases all run on model answers written by hand. Every provider is still a fake. | Passing tests don't show a screen reads well or a live model behaves. |
| F5 | Some things now happen by themselves: lost prospects' files are deleted for good every hour once they are 12 months old (#573); the nightly security run will open one issue per AI agent until the providers' pages are confirmed (#576); the verifier is on for new agents only, and existing agents stay off until a reviewed update (#569). | Each should be watched once before it surprises us. |
| F6 | Many merges, few deploys of their own. With merges minutes apart, queued deploys were replaced by the next one (8 of the last 25 were cancelled this way). The journal is in order (checked), and the numbering has gaps from renumbering (no 0076, 0081 to 0084, 0086, 0088 to 0094). | Confirm staging runs `main`'s newest commit and applied all 14 migrations. |
| F7 | Tests that fail under load and pass alone: `RunView`, `text-signup`, and ten web tests in #578. | CI on `main` is green today, but a flaky suite hides real failures. |
| F8 | The automatic draft-PR workflow opened six duplicates (#509, #519, #549, #551, #579, #594). Old branches remain (`adoring-hopper-cqa4k8`, `relaxed-edison-gqrkyz`, `r4-agent-report`). | Noise. #552 also closed unmerged; its fix is on `main` another way (checked). |
| F9 | Two dates: the evals key expires 22 December (#591); the Q4 access review is due before 31 December (#571). | Easy to miss. |
| F10 | Production still runs `747d7ff` with migrations through 0041. It is now 59 migrations behind. | Not part of this clean-up, but the first release gets bigger every day. |

## 4. The QA plan

Seven passes, in order. Each check has an id. **Who** is the owner (O) when it needs a signed-in
browser, a key or a decision, and a Claude session (C) when it can be done from code, the staging
connector or Sentry.

**Reporting a problem.** On staging, press Feedback on the screen where it happened and start the
note with the check's id ("C3: Nudge sent twice"). A Claude session reads the feedback list through
the staging connector, groups the reports into streams and fixes each stream in one PR, as the
22 November walk-through was handled. The results are recorded at the end of this page.

**How bad is it?**

- **Stop:** money written wrong or twice; a write without the approval it needed; one client seeing
  another's data; the portal showing cost, prompts or instructions; data lost. Fix before anything else merges.
- **This week:** a dead end, a count that disagrees, a button that does nothing, an error shown raw.
- **Later:** wording, layout, a missing translation.

### Pass 0. Unblock staging (owner, about 15 minutes)

| # | Do | Done when |
|---|---|---|
| P0.1 | Actions → "Retire lost client keys" → staging, `lost_kid` `df86749ddd2f91d4`, type `RETIRE`. | The run says how many keys it retired. |
| P0.2 | Reconnect QuickBooks on the Sandbox, and any other connection on staging saved before 21 November. | The connection reads connected, and a sync finishes. |
| P0.3 | Approve the Claude connector for staging (the connect-claude link a session shows you). | A session can read staging's health, runs and feedback. |
| P0.4 | C: watch Sentry for an hour. | MEZONAS-API-C, D and H stop; resolve them and MEZONAS-WEB-8. |

### Pass 1. Land what is open, then stop merging

One at a time, each green before the next. Migrations are already in, so the order is by risk.

| # | Do | Who |
|---|---|---|
| P1.1 | #590: merge when its CI is green. | O |
| P1.2 | #583: merge `main` in, settle the conflicts (six language files, `routes.tsx`, `packs/registry.ts`, `skill-hashes.test.ts`), run the size check again, CI green, merge. | C, then O |
| P1.3 | #554: merge `main` in, settle `routes.tsx`, CI green, merge. Confirm the commit that broke a skill on purpose is gone. | C, then O |
| P1.4 | #587, #588, #592, #595: bring each up to `main`, run `pnpm check`, mark ready, merge. #589 after P0.2. | C, then O |
| P1.5 | The docs PR: plan entries §1.208 to §1.214 and §1.230 to §1.236 from the PR descriptions, the work plan's ticks, `open.md`'s "Where things stand", CLAUDE.md's status line. | C |
| P1.6 | No feature merges until Pass 3 is done. Only fixes from this plan. | O |

### Pass 2. Machine checks on the merged `main` (a Claude session, no keys)

| # | Check | Passes when |
|---|---|---|
| M1 | `pnpm check` three times in a row on the merged `main`. | Three green runs. Any test that fails once is listed and fixed or filed. |
| M2 | Migrations from production's point: build a database at 0041, apply 0042 to 0100, run the seed. | Clean, and the db tests pass on the result. |
| M3 | Staging runs the newest `main`, and its migrations table holds all of 0074 to 0100. | The deployed commit matches; the last migration applied is 0100. |
| M4 | The first-load size, measured on the merged `main`. | Under the 335 kB budget, with the figure recorded here. |
| M5 | The boundary tests still hold after every merge: no portal route returns cost, prompts or bundles; a limited client user is refused the new reports; every new tenant table has RLS forced. | The contract tests list the new routes and tables (reports, saved views, close, AP, desktop, interview). |
| M6 | Run the app locally and open every new screen in light and dark, at desktop and phone width, with screenshots. | A page of screenshots; anything broken or unreadable is filed. |
| M7 | Sentry on staging for 24 hours after the last merge. | No new issue without an owner. |
| M8 | The language files: every key added in these two days exists in all six languages. | No screen shows a raw key. |

### Pass 3. The walk-through on staging, by group

This time, click the buttons. The 22 November walk only read and navigated. Use the Demo client and
the Sandbox, never a real client.

**A. Building an agent**

| # | Do | Expect |
|---|---|---|
| A1 | Open a build with a Plaid, a Twilio and a person step. | Each box has its mark and the vendor's name; the Builder panel folds to a line, half and full. |
| A2 | Ask the Builder for "every other Monday at 9". | The schedule reads in words and saves. |
| A3 | Open "What the model gets" on an AI step of a client's agent with a charter and notes. | The prompt, tools and data show; nothing runs. |
| A4 | Try steps 3 to 5 of a workflow with "Make up data". | Each step shows its output; nothing is written to any tool. |
| A5 | Give a workflow two starts, press the button for "How did it start?", and run each path. | Each start runs its own first steps, then they join. |
| A6 | Send the Builder a request it is likely to answer badly (very long, off topic). | It asks again once; no "form we couldn't use" error. |

**B. SOP, Workflow and security**

| # | Do | Expect |
|---|---|---|
| B1 | As a client admin, open an agent's SOP; print it; search it; open its history. | One procedure with a revision and date; each step says rules, AI or person. |
| B2 | As a client user limited to one agent, open that agent's SOP, then another's by its address. | The first opens; the second is "not found". |
| B3 | Open the Workflow tab, click a box, press "This is wrong". | A card with purpose, who and approvers; the report reaches us. Switch the portal to Spanish: the chart's words change. |
| B4 | Back office, agent → Security → "Run the checks now". | 17 checks, each verified, in review or not applicable. The portal's section 14 agrees. |
| B5 | Next morning: count the issues the nightly run opened. | Known: one per AI agent for "no provider trains on your data" until the pages are confirmed (decision D6). |

**C. Starting a client**

| # | Do | Expect |
|---|---|---|
| C1 | Start a new client; as its admin, go through Getting started's five chapters; sign the scope. | Each chapter saves; a try run finishes; the scope is signed. |
| C2 | Try to turn an agent on before the scope is signed, from the board and by its address. | Refused both ways. Known gap: the server may not refuse (#522). |
| C3 | Back office, Setup tab: press Nudge; press Start trial. | One nudge is sent; Start trial is held until setup is complete. |
| C4 | Send an invite to an address that bounces, then press Send it again. | Needs Resend (Pass 5). Without it: a clear "can't send", no crash. |
| C5 | Start a process interview, open its link in a private window, answer five questions, add a file. | One question at a time; a map and a draft appear for us. English only. |
| C6 | On staging's data, list the prospects the retention job would delete today. | Only deals closed as lost more than 12 months ago. |

**D. The walk-through's fixes.** Go through `STAGING_QA.md` N1 to N10 and C1 to C11 again, on
staging, and mark each fixed or not. Two were never explained: the missing Your call badge on Library
and New client, and `GET …/skills` hanging.

**E. Safer writes**

| # | Do | Expect |
|---|---|---|
| E1 | Open a waiting card in two tabs. Change it in one, approve in the other. | The second is refused and asks you to reload. |
| E2 | Run a new agent to a write; open the change card. | An Evidence panel; the write waits for the approval the step asks for. |
| E3 | Give the verifier a write it should disagree with (a test document whose total is wrong). | It goes to the client's approver with the reason. |
| E4 | With the Bookkeeper on the Sandbox: let the bank feed send the same transaction twice, approve both. | One write in QuickBooks; the other is stopped. After P0.2 and Plaid's sandbox key. |
| E5 | Sign an answer with a note on the phone app. | Signed; changing the note afterwards is refused. Needs a phone build. |

**F. Purchasing**

| # | Do | Expect |
|---|---|---|
| F1 | Run the purchasing email test with a line that matches only through a vendor's catalog. | It matches; the catalog fills from the bill. |
| F2 | Reply to an RFQ from a colleague's address at the vendor. | Kept on the thread as unverified for a person; never taken as the quote. |
| F3 | Send a PO with one item line and one account line. | Both in QuickBooks' sandbox. Known gap: no screen shows or fixes an item's tie. |

**G. Reports and finding runs**

| # | Do | Expect |
|---|---|---|
| G1 | Search a vendor's name with ⌘K, in the back office and in the portal. | "N runs about …"; the portal lists only runs that client may see. |
| G2 | Open a vendor, a document and a transaction. | Each lists its runs, newest 20. |
| G3 | Open an agent's Report tab on both sides; click three figures; download the CSV. | Each figure opens exactly its runs; the CSV matches. The portal shows no cost. |
| G4 | Open `/ops/accounts` and one client's Report; open the portal's Account tab as an admin, then as a limited user. | Clients that need us come first; the limited user is refused. |
| G5 | Save a filtered runs list as a view; share it; open it as a colleague. | The chip reopens the filter; the colleague sees it; another client never does. |

**H. Costs**

| # | Do | Expect |
|---|---|---|
| H1 | Usage for the last 24 hours against Anthropic's console for staging's key. | Within a few percent. The gap was $72.58 against $117.89 before #580 and #591. |
| H2 | Dictate for a minute in the portal, then in the back office. | The client's usage shows it under Sloan; ours shows as our own cost. |
| H3 | Usage → Services for one client. | Email, texts, browser minutes and bank feeds appear. The unit prices are placeholders (D8). |

**I. Hardening and compliance**

| # | Do | Expect |
|---|---|---|
| I1 | Put a test client in HIPAA mode; ask the Claude connector for it. | Left out of the list; a call that names it is refused. |
| I2 | Connect Claude to staging again and read the approval page. | It names the Claude client and roughly where it is asking from. |
| I3 | Pause an agent, send it two events, resume. | The portal says two came in while it was paused. |
| I4 | Security → SOC 2: record an access review; download its CSV. | The review is kept; the criterion moves to in place. |
| I5 | Run the deletion drill on staging (`db:deletion-drill`). | It passes; the drill's client is gone; no other client's rows changed. |

**J. The desktop app**

| # | Do | Expect |
|---|---|---|
| J1 | As a client admin, pair a computer and set a folder; remove it. | Paired, then refused after removal. The key never shows in the portal. |
| J2 | Open the desktop app from the browser. | A page asks first; the audit row names the app. Needs a Mac or a PC build, which has never been run. |

**K. Accounting building blocks**

| # | Do | Expect |
|---|---|---|
| K1 | Areas tab: install each pack on a test client, then remove one. | One path for all; the vendors each pack sends data to are listed. |
| K2 | Books health on the Sandbox, after P0.2. | Nine checks ranked by dollars. Check the signs of two balances against QuickBooks by hand. |
| K3 | Bills to pay: enter a bill that matches its order, a duplicate, and one 5% over. | Matched, flagged, flagged. The weekly list waits for the client admin. Nothing is paid. |
| K4 | Approve a list holding a flagged bill, with a note. | Known: the flag doesn't stop it, and approved is final (decision D2). |
| K5 | Month-end close on the Sandbox (after #583): run the checklist, approve one accrual, sign off, then try to change the month. | The entry is written once, after approval; the signed month refuses changes. |
| K6 | Email a report file for a saved profile twice. | The first lands as rows; the second is refused as a duplicate. Known gap: the alerts have no screen. |
| K7 | Reconciliation on the Sandbox, as before the matching engine. | The same matches as last week, each naming the rule that made it. |

### Pass 4. The things that run by themselves (check the morning after)

| # | Runs | Check |
|---|---|---|
| T1 | Every hour at :37, the SOP revision check. | No missed revision reported in Sentry. |
| T2 | Every hour at :47, the backfill of what runs were about (1,000 runs per client per hour). | Old runs become searchable; it finishes. |
| T3 | Every hour, the lost prospects' purge. | Deleted only what C6 listed, each with an audit row. |
| T4 | Nightly at 08:23 UTC, the security checks. | Results for every agent; the issues it opened match B5. |
| T5 | Daily at 08:00, the suggestions pass (after #595). | One suggestion per request, stating the change asked. |
| T6 | A fortnightly schedule set in A2. | It fires on its week and skips the next. |
| T7 | The deploy after #537 created the three rate-limit namespaces. | Present in Cloudflare; the beacon is limited per site. |

### Pass 5. What needs a live key or a real device

Not blocking the clean-up. Each is the first real test of something built against a fake.

| # | Needs | Then check |
|---|---|---|
| L1 | Resend's key, the webhook endpoint `/api/hooks/resend` and `RESEND_WEBHOOK_SECRET` on staging. | C4; the welcome email (#570); the work statement's email (#590); urgent notices by email (#547). |
| L2 | The model key (already on staging). | One real pass each of the interview (#574), the verifier (#569), "Make up data" (#520) and the Builder's retry (#517). Then record the fixtures again so the tests stop using answers written by hand. |
| L3 | Intuit's sandbox keys. | `qbo/NOTES.md` checks 6 and 9, journal entries for the Close pack, Books health's balance signs. |
| L4 | Plaid's sandbox keys. | E4, and the Bookkeeper's own checks (`docs/open.md` §1b, K1 to K5). Bookkeeping stays off for clients until then. |
| L5 | A Mac, a PC and a phone build. | J2, E5. |
| L6 | A fluent reader for Spanish, French, Portuguese and the other languages. | Every string marked `// fluent review` in these PRs. |

### Pass 6. Clean up

| # | Do |
|---|---|
| U1 | Merge the docs PR (P1.5). Fold this page's results into `docs/open.md` and delete what is done. |
| U2 | Fix the automatic draft PR so it stops opening a second PR for a branch that has one. |
| U3 | Delete the merged and dead branches, after the owner confirms `adoring-hopper-cqa4k8` holds nothing wanted. |
| U4 | Fix the tests that fail under load (F7). Never skip them. |
| U5 | Put the two dates in a calendar: the evals key (22 December), the Q4 access review (31 December). |
| U6 | Close the Sentry issues that Pass 0 fixed. |

### Pass 7. Before production

Out of scope for this clean-up, but it is where the work ends up: M2 green, Pass 3 with no Stop
items open, the owner's decisions below answered, then the first `v*` release as
`docs/operations.md` describes it.

## 5. Decisions the PRs left for the owner

Each was built on the simplest answer, so nothing waits. Best answered in one sitting.

| # | Decision | Built as | From |
|---|---|---|---|
| D1 | Bills to pay and Vendor contracts' invoice review on the same client run each invoice twice. Which one wins? | Both run. | #585 |
| D2 | May a bill with a blocking flag be approved with a note? Can an approved list be reopened? | Yes with a note; approved is final. | #585 |
| D3 | Pattern-based accruals on by default? The default account's name? | Per the pack's settings; "Accrued Liabilities". | #583 |
| D4 | Which model verifies writes (about 1 to 2 cents a write), and when do existing agents get the verifier? | On for new agents only. | #569 |
| D5 | What the work statement counts as processed, posted and caught. | The PR's definitions. | #590 |
| D6 | Read each AI provider's terms page and confirm it; is the Gemini key on a billed project? | "Not yet confirmed", which opens issues nightly. | #576 |
| D7 | Adopt the three draft policies; who is the security officer. | Drafts; one owner for every criterion. | #571 |
| D8 | The real unit prices for email, texts, browser time, bank feeds and transcription. | Placeholders marked unverified. | #559, #580, #536 |
| D9 | Should a client's own Claude connection be held in HIPAA mode too? | Not held. | #526 |
| D10 | When to refuse an old phone signature (v1) that carries an answer or a note. | Accepted. | #542 |
| D11 | May a preferred vendor beat a lower price? | It wins ties only. | #529 |
| D12 | Deleting a learned note outright, or as a new version. | Deleted. | #587 |
| D13 | Should an invitation reveal that a phone number is already a contact? | It does. | #538 |
| D14 | Books health sees 90 days. Backfill further? Its thresholds (45, 30, 3 and 7 days, 10%). | 90 days; those thresholds. | #566 |
| D15 | One word for a step that uses no model: "Rules", "Code" or "Deterministic". | "Rules". | #508 |
| D16 | Still open from the walk-through: one way to start a client; Areas or Packs. | Unchanged. | `STAGING_QA.md` |

## 6. Results

Filled in as the passes run: the date, who ran it, each check's id with pass or fail, and the PR
that fixed each failure.
