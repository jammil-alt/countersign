# Staging walk-through (2026-11-22)

The owner went through every back-office sidebar section on staging. They only read and navigated,
plus one question to Reggie. Done, Step in, Switch on, Invite and the create and save buttons were not
clicked, so those paths are untested. Nothing crashed and the console showed no errors. The problems
are counts and statuses that disagree across screens, and flows that dead-end.

This page lists what was reported and how each item is handled. Fix status is filled in as the fixes land.

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

## Good (keep)

- Plain-words search on Runs turned "failed runs for Demo client" into the right two filter chips.
- Run detail: step timeline, cost per step, inputs and outputs, the auditor export.
- Global search is fast and groups runs and records (long titles truncate before the invoice number).
- Reggie's answer was accurate and said what it couldn't see.
- The pin-a-spot feedback tool, Your call keyboard shortcuts, Autopilot's "Always yours" panel, the Security overview.
