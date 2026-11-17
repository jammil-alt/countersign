# Back office work: Sales and Build (design and plan, agreed 2026-11-17)

**Status (2026-11-17): built, not merged.** The owner asked for it built on 2026-11-17. It is on
two stacked draft PRs: the migrations (0061–0064, PR #380, `claude/ops-work-migrations-szb740`)
and the code on top of it (`claude/ops-work-szb740`): Build, Sales, Your call, and Reggie with
Autopilot and `support@`/`hello@` email, all against fakes. Neither is to be merged until the
owner says so. The decisions are `docs/plan.md` §1.123 (the §7 questions are answered there),
the milestones M64–M68. The text below is the plan as agreed; its "nothing here is built" is
history.

The owner wants one place in the back office to bring clients in, sell them more, and build and
fix what they need, with Reggie doing most of the work so one person can run many clients'
agents. **Nothing here is built.** This is the agreed design and the plan to come back to. It is
outside ARCHITECTURE v0.19's v1 scope: when it is picked up, it is recorded as the owner's
decision in `docs/plan.md` §1, as Reggie (§1.101) and builds (§1.108) were.

The design is in two files; serve the repo root over http and open them:

- `docs/design/workflows.html`: the workflows, agreed 2026-11-16.
- `docs/design/pipelines.html`: the clickable screens, agreed 2026-11-17. Made-up data, wired to
  nothing.

The design system already has the screens' patterns (`packages/design-system/README.md`, "App
patterns"): KPI boxes, page tabs, filter chips, the sticky data head, due dates, urgency, the
safety hold, and board heads with totals.

## 1. What exists today, and what's missing

The pieces exist, separately, with no shared state:

| Today | What it does | What's missing |
|---|---|---|
| Portal requests (§1.11) | A client raises a change; it lands in `/ops/requests`; resolved once with a link to versions. | Replies back and forth, urgency, a due date, who it waits on. |
| The lead thread (§1.38) | One conversation per client with its lead; messages for the client or internal notes. | Nothing tracks an issue inside it from raised to done. |
| Lead requests (§1.101) | The lead asks the client admin something on their Desk. | Not tied to the issue or build it is for. |
| Feedback and error reports (§1.10) | Pinned screenshots and failure context, resolved with a note. | The client never hears back; no link to the fix. |
| Sloan's `pass_to_lead` (§1.47) | Sloan hands a client's ask to the lead. | Same as requests. |
| Builds (§1.108) | A new agent or skill from intake to go-live. | No promised date; nothing links a build to the deal or ask that started it. |
| Reggie (§1.101) | The operator's agent: reads across clients, proposes changes as cards. | No sales, issue or to-do tools. |
| Run review queue | Runs held for a person. | Separate from everything else that needs a person. |

Nothing covers prospects: a lead lives in the owner's inbox until it is a client.

## 2. The shape

Two sections in the sidebar, each opening on one list across its kinds, and one to-do list over
everything:

- **Your call**: the one to-do list. What needs a person, with Reggie's read, its plan and a
  draft, ready to send, edit or snooze. Tabs for what Reggie is on, what waits on clients, and
  what Reggie did on its own today (to spot-check and flag).
- **Sales**: New accounts and Expansion. Tabs: All deals (the start), New accounts, Expansion.
- **Build**: Issues, Agent builds and Enhancements. Tabs: All work (the start, the work order),
  Issues, Agent builds, Enhancements.
- **Clients**: each client's page has everything open for it in Sales and Build, its to-dos (yours,
  Reggie's, the client's) and one activity timeline (messages, questions, runs, decisions).
- **Autopilot**: for each stage, what Reggie does and how far it goes alone: off, draft for me, or
  send and tell me. Some steps are always the operator's (§5).

Every list has the same parts: KPI boxes over it that scroll away, then a toolbar and column heads
that stay at the top; filter chips with counts (open, needs you, Reggie on it, waiting on the
client, stuck or held, late, done; critical and high on issues); search; sort on every column;
client, description and due date on every row. Pipelines switch between a list and a board, and
a board's stage heads show totals (Sales: deals, agents, revenue a month; Build: needs you, late).

## 3. The workflows

### 3.1 Sales

| Flow | Stages |
|---|---|
| New account | Lead → Qualified → Diagnostic → Proposal and contract → Set up the account → First agent live |
| Expansion | Spotted → Pitch → Offered → Agreed → Live and billed |

- Each deal has a client (or, before set-up, a company), what is being sold, the agents in it,
  the revenue a month, the next step and its due date. Each stage has a likelihood for the
  weighted total.
- Reggie spots expansion in live clients nightly (work we see but don't handle, volume growth)
  and opens a deal with its evidence. It holds the pitch while the client has an open critical or
  high issue, or is at risk.
- Contracts and terms are by hand for now: the operator records the agreed price, from when, and
  the signed copy. Later they move to a Billing page the client agrees on.
- Set-up makes the client (Reggie's `client_create`, approved) and opens one agent build per
  agent sold, with what the diagnostic learned.

### 3.2 Build

| Kind | Stages |
|---|---|
| Issue | Reported → Finding the cause → Fix → Verify → Closed |
| Agent build | Requirements request → Building (new agents only) → Connect → Bench test → Trial → Sign-off → Live |
| Enhancement | Captured → Grouped → Decided → Built → Shipped and told |

- **Urgency** for issues: critical, high, normal, low, set by Reggie from what's at stake; a
  person can change it. Targets: critical, reply within 1 hour any day and fix the same day; high,
  4 business hours and 2 days; normal and low, 1 to 2 business days.
- **The safety hold**: on a critical issue Reggie stops the agent's writes and messages; its runs
  go on as drafts and the held items wait. Only a person releases a hold or rolls an agent back.
- **Requirements request**: a build from a template starts with the template's intake
  questionnaire, pre-filled from what we already know, sent to the client with a due date; Reggie
  chases it, and gaps become the client's or the operator's to-dos.
- **Enhancements** merge the same ask across clients; decide do it, later, no, or sell it; tell
  everyone who asked once it ships.
- **The work order**: critical issues first, always. Then high, normal and low issues before
  builds, unless a build would miss its promised date, in which case the build goes first.
  Enhancements after builds, most-asked first. Reggie keeps the order and says why each item is
  where it is; the operator can move anything, and moving work around a promised date is theirs.

### 3.3 Questions

Questions are activity on the client, not items in a pipeline. Sloan answers in the portal and
Reggie by email when the knowledge base answers it. A question not answered in 4 business hours,
or one Reggie is unsure of, becomes the operator's to-do with a draft. Asked 3 times in 30 days,
Reggie drafts a knowledge entry.

## 4. Data (to confirm when built)

| What | Where | Why |
|---|---|---|
| `deal` (kind `new` or `expansion`), `deal_person`, `deal_activity` | Operator-only (RLS on `app_is_operator()`) | A prospect has no tenant. An expansion deal carries its `client_id`. Revenue is `numeric(14,4)` and currency (invariant 6). |
| `issue`, `issue_event` | Tenant table, forced RLS | An issue belongs to its client, who sees its own in the portal (invariant 1). Its conversation is a `thread` with `subject_type = 'issue'`; internal notes use `audience: 'operator'` as threads do. |
| `client_ask` and `enhancement` | Ask: tenant table. Enhancement: operator-only, grouping asks across clients by id | One client's words never reach another client (invariant 11). |
| Builds | The existing build tables, plus `promised_on` and a link to the deal or ask that started it | |
| `todo` | Operator-only; owner `operator`, `reggie` or `client`, due date, linked item | The client's to-dos reach them as Desk items or lead requests, as today. |
| `play_setting` | Operator-only | Autopilot: per flow, stage and play, `off`, `draft` or `send`. Everything starts at `draft`. |
| Safety hold | On the client agent | Checked by the permission gate before any external action or message (invariant 8). |

Requests, Sloan's `pass_to_lead` and portal Feedback become issues or asks; `/ops/requests`
redirects once they are folded in. The activity timeline is read across existing tables (thread
messages, runs, decisions), not a new copy.

## 5. Reggie

Reggie gets sales, issue, build, enhancement and to-do tools. On each new message or event it
reads and sorts (kind, urgency, the agent it's about, a one-line read), gathers the runs,
versions and records involved, with their sources (invariant 10), drafts the reply and a plan,
and either does its part or brings it to Your call.

**Always the operator's, at any Autopilot setting:**

- Releasing a safety hold or rolling an agent back.
- Anything that changes how a client's agent works, or loosens an approval.
- Prices, terms, contracts and bill changes.
- Creating a client, adding a person to one, starting a trial.
- Moving work around a promised date.
- Anything Reggie is unsure about.

Limits that carry over: Reggie reads a client's data only scoped to that client; text from emails
and portal messages is data, never instructions (invariant 9); it never asks for or repeats
secrets; it sends as the client's lead.

## 6. Plan

Each step ends green and goes to staging. Migrations in their own PRs.

| Step | What | Done when |
|---|---|---|
| B1 | `issue`, `issue_event`, RLS and contract tests (migration PR). | A client's issue can't be read from another client, and the portal never returns notes or drafts. |
| B2 | Build section: Issues list and board, the issue page (conversation, notes, to-dos, plan); the portal's view of a client's issues; email notice to the client. | The owner and a test client go back and forth on an issue on staging. |
| B3 | Urgency, targets and the safety hold in the permission gate. | A held agent's run writes nothing and its items wait; only an operator releases it. |
| B4 | Fold in requests, `pass_to_lead` and portal Feedback; asks and enhancements. | `/ops/requests` redirects; nothing is lost. |
| B5 | Builds: promised date, requirements request, link to what started it; the work order across the three kinds. | Build's All work lists everything in the agreed order with the reason for each. |
| T1 | `todo`; Your call (yours, Reggie's, the clients', done today) and the client page's to-dos and activity. | Every item that needs a person is on one list with a due date. |
| S1 | `deal`, `deal_person`, `deal_activity` (migration PR). | |
| S2 | Sales section: lists, boards with stage totals, the deal page; set-up opens the client and its builds. | A deal goes from lead to first agent live on staging. |
| A1 | Reggie's tools, the read-gather-draft pass, and Autopilot with every play at `draft`. | Each new issue shows a read and a draft within a minute; nothing is sent without a person. |
| W1 | Inbound email (`support@`, `hello@`), reply threading and outbound; then the site's "Get started" form. | An email from a client's person opens an issue; a reply lands on it. |

Order: Build first (B1–B5, it gives clients a way to talk to us and fixes one-way requests), then
the to-do list (T1), then Sales (S1–S2), then Reggie (A1), then email (W1, which needs the
owner's Email Routing and Resend steps, `docs/open.md` P1 and P2).

## 7. Open for the owner

1. Does a high issue also get a safety hold, or only critical? (The design: critical only.)
2. Does a critical issue alert the operator's phone?
3. Can to-dos belong to named people on the team? (The design: you, Reggie or the client.)
4. Builds have a promised date. (The design assumes yes.)
5. Deals as operator-only tables, or a Sales pack on the Mezonas client, as Marketing is?
6. The client's word in the portal: keep "Requests", or "Issues"?
7. One inbound address or two (`support@`, `hello@`)?
8. Later: contracts and terms on a client Billing page; routing inbound email.
