# Staging walk-through (2026-11-22)

The owner went through every back-office sidebar section on staging. They only read and navigated,
plus one question to Reggie. Done, Step in, Switch on, Invite and the create and save buttons were not
clicked, so those paths are untested. Nothing crashed and the console showed no errors. The problems
are counts and statuses that disagree across screens, and flows that dead-end.

This page lists what was reported and how each item is handled. The decisions are in `docs/plan.md` §1.207; what is still open is in `docs/open.md`.

## Not working

| # | Reported | Stream |
|---|---|---|
| N1 | "Open item" on Home and Escalations goes to the client's Waiting on clients list, with nothing highlighted. | Home and Needs us |
| N2 | "Needs us 26": 24 of them wait on a client admin ("Only they can answer it") but sit under Needs us, all Urgent. Your call says 8, Reggie says 2. | Home and Needs us |
| N3 | Usage doesn't reconcile: model cost $36.42 but By vendor and By model total $0.71; Twelve Thirty-Four $35.50 over 10 runs of $0.00; Demo client $0.90 vs $0.68, tokens 333,232 vs 286,661; `claude-sonnet-4-5-20250929` 30 calls at $0.00. | Usage |
| N4 | Home shows 0 live runs today while Recent runs lists three for 21 Nov; the tile's link filters from midnight UTC. Home shows $0.00 spend after a Reggie conversation. | Home and Needs us; Usage |
| N5 | A test run's step 9 "would create the bill (test run, not written)", then step 10 fails attaching to that bill. | Test runs |
| N6 | AP bill clerk is "Idle · In trial", "In trial", "Running · Live" and "Live · v4 · Active" on four screens; Demo client has 3, 4 or "1 of 3 live" agents. | Agent status |
| N7 | Autopilot: the Off/Suggest/On control overlaps the step title; the description wraps one word per line. | Shell and layout |
| N8 | On Library and New client, the Your call (8) badge drops from the header, sidebar and tab title. | Shell and layout |
| N9 | The unfiltered Runs table cuts off the Cost column. | Runs and dates |
| N10 | "1 client items have waited", "1 live runs", "Paused by the client: Pause", "oldest 239 h", a Done run of 168 h, "Qbo", "Skills it uses: Loading…", unknown URLs say "Not built yet". | Several |

## Confusing or could be better

| # | Reported | Stream |
|---|---|---|
| C1 | The client picker looks like a filter but isn't: it follows the last client opened while Sales, Runs, Escalations and search show every client. | Flows |
| C2 | A to-do ("Record Susana Test's agreed price") opens a drawer with only Later and Done; the form is on the deal page, with no link. | Flows |
| C3 | New client, Sign up now, New deal and Invite each start a client a different way (page, drawer, inline form, wizard). | Owner decision |
| C4 | Too many words: Areas vs Packs (Purchasing vs Materials), owners, processes, agents, supervisor, lead, Reggie, Sloan, Kit. Sidebar Utilities opens a page titled Feedback, beside a Feedback button. | Owner decision; Utilities in Shell and layout |
| C5 | Library, Packs, Usage, Marketing, Security and Users sit below the fold with no scroll cue; the sidebar jumps to the top on each page. | Shell and layout |
| C6 | Your call tabs reload the page (counts flash to 0, scroll resets); stat tiles wrap 4+1 (4+2 on Sales and Build); filter chips clip Late and Done. | Shell and layout |
| C7 | 21 near-identical "Add X to the directory" items, one at a time; a "1 item is still waiting" reminder counts as an item. | Home and Needs us |
| C8 | Connectors "Recommended to this client" is the whole catalog of 30, includes the two connected, and speaks to the client ("your QuickBooks"). | Flows |
| C9 | Runs: 64 rows, no paging, 32 identical failed test runs with raw errors ("✖ Invalid UUID"). | Runs and dates |
| C10 | Dates appear as "21 Nov 08:00", "Nov 11, 4:40 PM" and "11/5/2026"; the time zone is free text. | Runs and dates |
| C11 | Reggie needs a click before you can type, and the click saves an empty "New conversation". | Flows |

## Fix status (2026-11-22)

Seven streams, each merged into this PR with its tests. None read staging: the staging tools wait
for the operator to approve a connect-claude link, so every cause below comes from the code.

| # | Cause | Fix |
|---|---|---|
| N1 | Approvals linked to the client's whole Waiting on clients list. | Each link opens its item (`?item=`), or the items one escalation covers (`?stuck=`), marked and scrolled to. |
| N2 | Every client approval over 24 h went into Needs us, one per run or item, so all were Urgent. Your call counts other things; Reggie counted operator inbox items. | Needs us holds a client's approval only when nobody there can act, once per client and reason. The rest stay in Waiting on clients, counted on Home. Reggie uses the same list. |
| N3 | The total came from rollups that add providers' fees; By model and By vendor came from call rows. Twelve Thirty-Four's $35.50 is texting registration fees. Sonnet 4.5 had no price, and dated ids never matched one. | One call-level source for every table, an "unrecorded" line for step spend without call rows, back office and fees as their own lines. Dated ids price as their model; older models have prices; unpriced calls say "No price". Past $0 rows stay $0. |
| N4 | The day started at midnight UTC; Home's spend left out Reggie and the Builder. | The browser's day, sent to the API. Spend reads the same source as Usage. |
| N5 | A write after a skipped write read the record from QuickBooks (bill "0") and failed, ending the run. | Dependent writes are proposed without reading; a dependent step that still fails is recorded as "would have done" and the run goes on. |
| N6 | Home and Overview read the stage; the Agents tab and agent page read the run switch and the published-version badge. Counts used different sets. | One wording and one counted set on every screen. |
| N7 | A three-column grid squeezed the text. | A wrapping row; the control sits beside or under the text. |
| N8 | Not reproduced. | A test checks the badge on every back-office route; a page loading part of itself no longer hides the frame. |
| N9 | Long unbroken titles and errors widened the columns. | Two-line clamp, column widths, Cost pinned at the right edge. |
| N10 | Each had its own cause. | Plurals, days for long waits, worked time with the wait beneath, pause reasons that repeat the action dropped, "QuickBooks Online", skill names from the agent route, "Page not found". |
| C1 | Opening a client's page picked it and kept it. | The picker is navigation only and shows the page's own client. |
| C2 | The deal link was only the title, in ink. | Each to-do has a button to where it is done. |
| C3, C4 | Owner decisions. | In `docs/open.md`. Utilities pages are titled "Utilities"; the pin-a-spot tool is "Report a problem". |
| C5 | — | The sidebar keeps its scroll and brings the current row into view. |
| C6 | The screen dropped its data while a tab loaded. | It keeps the last data while loading; tile rows balanced; chips wrap or scroll. |
| C7 | — | "Handle together" for three or more alike; reminders are not counted. |
| C8 | The section listed the whole catalog in the connectors' own words. | Only what fits, never a connected one, in the operator's words. |
| C9 | No paging; every failure its own row. | Pages of 50, repeated failures folded, validation errors in words. |
| C10 | Each screen formatted dates its own way. | One house format; the time zone is picked from a list. |
| C11 | Opening Reggie created a conversation. | Type at once; it is saved with the first message; empty ones aren't listed. |

## Good (keep)

- Plain-words search on Runs turned "failed runs for Demo client" into the right two filter chips.
- Run detail: step timeline, cost per step, inputs and outputs, the auditor export.
- Global search is fast and groups runs and records (long titles truncate before the invoice number).
- Reggie's answer was accurate and said what it couldn't see.
- The pin-a-spot feedback tool, Your call keyboard shortcuts, Autopilot's "Always yours" panel, the Security overview.
