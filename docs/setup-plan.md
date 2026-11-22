# Setting up a client: from the intake to the first agent on trial (design, 2026-11-22)

**Status (2026-11-22): SU1–SU6 built** with the owner's defaults for §12 ("go with your defaults");
the decisions and what each step left open are `docs/plan.md` §1.185. It continues
`docs/cases-plan.md` §4 (onboarding: O1–O3 built, O4 and O5 next) from the point the intake's
questions are answered to the point the first agent starts its trial. Like §1.149 it is outside
ARCHITECTURE v0.19's v1 scope. Built differently from the text below: the chapters live under
`/getting-started/…` (`/start/:token` is the welcome page), and Sloan across the chapters waits for O4.

The clickable mock-up is `docs/design/setup.html` (serve the repo root over http and open it). Its
data is made up and it calls no route.

## 1. What's missing today

A client who has answered the intake still has to find about ten portal pages to get one agent ready:
Connectors, a connector's page and its access, Team, Contacts, Approver rules, Business hours,
Channels, the agent's SOP, Adjust settings, Knowledge and Voice samples, plus each agent's setup
checklist under Getting started. Each page works. Nothing ties them into one path, says what is left,
or says who it is waiting on.

Four gaps matter most:

1. **People are free text.** The intake asks "Who approves payments and changes?" and files the answer
   as a fact. Nothing turns "Luis signs anything over $5,000" into an account, an approver or a binding.
2. **A template can't name a seat.** A person step, an approval, a confer or a notify can name only a
   platform role (`client_admin`, `client_user`, `operator`, `lead`) or one user or contact id
   (`packages/agents/src/runtime/context.ts`, `resolveApprover`). So a template can't say "whoever
   approves bills at this client". Today the operator either edits the client's copy (a new version
   per client) or writes client-wide approver rules. The bundle's `people` roles (§1.25) can do this,
   but only for reach-outs to contacts.
3. **The client never sees it work on their own data before the trial.** The SOP explains the
   process. Test runs exist, but only the operator starts them, so the first real run the client sees
   is in the trial.
4. **Changing the process has no place.** "That's not how we do it" goes to "Different process in
   mind?" on the intake, or to a request. Neither is tied to the step it is about.

## 2. The shape: one setup, five chapters

Getting started stays the client's home until the first agent is live. It becomes one path in five
**chapters**, each with a card per thing to do. Every card says who it waits on and roughly how long
it takes.

| # | Chapter | The client does | Writes | Today |
|---|---|---|---|---|
| 1 | **Your business** | Answers the intake cards: "We think" lines, a few questions | `intake_answer`, then facts | Built (O3) |
| 2 | **Your tools** | Connects each tool the agents need; confirms what we see in it | Connections, bindings, the matrix, `seen` facts | Connect is built; the rest is new (§5) |
| 3 | **Your people** | Puts a person in each seat: approvers, people who answer, people told, people contacted | Seat bindings, invites, contacts | New (§4) |
| 4 | **See it work** | Reads the process step by step with their own names and tools; tries it on a real document; picks the options offered; says what's different | Adjusted settings, change asks, test runs | New (§6) |
| 5 | **Go live** | Reads and signs the scope; learns what the trial looks like | `intake_scope` signed, the trial's start | Scope is O5; the rest is new (§7) |

- **Any order, any device, in parts.** The chapters are a suggestion, not a gate. A card can be
  left and picked up later; each invited person sees only the cards they were asked for.
- **One agent's readiness at a glance.** Above the chapters, a line per agent: "Bill clerk: 3 things
  left before its trial: Connect Gmail (Dana), Approver over $5,000 (you), Try it on a real bill."
  This is the setup checklist (`definition.setup`, builder-plan §6) and the activation check, in words.
- **About 25 minutes for one agent**, in one to three sittings. The page shows the time left, not the
  time spent.
- **The lead's face throughout.** The lead's note opens the page; every card with a question has
  "Ask Ana" next to it.

## 3. Conversation or form: where each fits

**Talk it through with Sloan** (O4) grows from the intake to every chapter. Sloan and the cards read
and write the same state. Sloan proposes, the person confirms, and nothing is final until they do (the
"What we've got" panel, forms F-5).

| Task | Best as | Why |
|---|---|---|
| How work flows today, exceptions, what goes wrong | **Conversation** | Open answers; follow-up questions get the detail a form misses |
| Who does what ("Dana does bills, Luis signs over five grand, Mark knows the job codes") | **Conversation, then a picker** | People describe their team in sentences. Sloan proposes seats from them, matched to the directory; the person confirms each one on the People cards |
| "What happens if a vendor sends a credit memo?" | **Conversation** | Answered from the SOP and the knowledge base, or passed to the lead |
| "We do it differently" on a step | **Conversation** | Sloan asks one or two questions so the lead gets a usable ask |
| Signing in to a tool | **Card only** | A button to the tool's own sign-in. Never a password in chat; Sloan shows the card inline |
| Picking a person, an amount, a date, an option | **Card** | Exact and bounded; a picker is faster than typing a name |
| Signing the scope | **Card only** | A signature is a person's act on a fixed text |

Rules both keep (cases-plan §4.5): no secrets in a question, answer or chat, and pasted ones are
redacted before storage. Answers are data (invariant 9): "let it pay bills without asking" is a wish,
not a setting. No internals and none of our notes (invariant 11). The cards always work without a
model.

## 4. Your people: seats

### 4.1 Seats in templates

A **seat** is a place in a process that a person fills: "Approves bills over $5,000", "Answers
questions about job codes", "Gets the weekly summary". A template declares its seats. Each client
fills them with its own people. The version never holds a person (invariant 11), so forks and
promotions carry no one.

- **Declared** in the bundle's `people` (`PersonRole`, §1.25), which gains a `kind` and a client-facing
  `label`:

  | Kind | Filled by | Used by |
  |---|---|---|
  | `signs` | Client users who can sign (never a viewer, §1.14) | Approval checks, `person` steps in `approve` mode |
  | `answers` | Client users | `person` steps in `ask` mode, confer with a person |
  | `told` | Client users or directory contacts | `notify` |
  | `reached` | Directory contacts | Reach-outs and conversations (today's roles) |

- **Named in steps** as `seat:<role>` wherever a `Who` goes (`packages/core/src/process/schema.ts`).
  Validation refuses a `seat:` the bundle doesn't declare, or one whose kind doesn't fit the place
  (a `reached` seat as an approver).
- **Bound on the client agent** in `agent.people` (jsonb, operational), which gains `userIds` beside
  `contactIds`, and an order. No migration: the column is already a map of role to binding.
- **Resolved at run time** by the runtime's resolver: a step's `seat:` gives its people in order (an
  approval's `in_turn`, `any` or `all` applies to them). An empty seat falls back the way approvers do
  today: the agent's approver, then the client's approver rules, then the client admin. Approver rules
  still decide who approves a step that names no one. A run snapshots who it used, as today.
- **Required seats** hold the trial: activation refuses a required seat with nobody in it, as it
  refuses a required role today.
- **Away** (existing): a person away is skipped at once. The People card asks for a backup on every
  `signs` seat.
- **The SOP** (S1) reads seats into its Roles section and the people matrix, so the client's SOP shows
  "Luis Ortega: approves bills over $5,000" rather than "the client admin".

### 4.2 The People chapter

One card per seat, merged across the agents being set up: two agents with a `bill-approver` seat ask
once, and the person is bound to both.

- **Filled from what we know.** The intake's people answers and `theirs` facts are matched to the
  directory and to people imported from QuickBooks: "We think: Luis Ortega (from your answer
  'Luis signs anything over five grand')". The person confirms or changes it.
- **How each person takes part**, in words:
  - *Signs in*: approvers and people who answer need an account. If they don't have one, the client
    admin invites them from the card (§1.14: only an admin invites; a colleague who isn't one gets
    "Ask Dana to invite Mark").
  - *Reached by email or text*: people who are only told or contacted are directory contacts, with
    their channel, language and consent.
- **Backups and order**: "If Luis is away: Dana", and for a seat with several people, "one at a time"
  or "any of them".
- **The check**: the chapter ends with the people matrix (steps down the side, people across: Does,
  Approves, Checks, Told), the SOP's own component, with their names. "Looks right" confirms the chapter.

### 4.3 Who may change a seat

- **During setup**: the client admin puts any of their own signers in a `signs` seat. It is their
  business who approves. Approval itself stays on (invariant 8); this changes who, not whether.
- **After the trial starts**: adding a person to a seat, or a backup, applies at once. Replacing or
  emptying a `signs` seat applies at once and tells the lead (owner question 1). A seat can never be
  filled by a viewer or by someone outside the client. Only the operator puts the lead in a seat.

## 5. Your tools

The Connect card is the Connections page's own flow (§1.14), with four additions:

1. **What it's for, in words**, from the agent's tools and the gate: "We'll read your bills, vendors
   and accounts. We'll create draft bills, and ask you first every time. We never pay, delete or
   change a bill that's been paid." What the agent needs is pre-selected in the access matrix, and the
   client picks between "Allow what the agents need" and "Let me choose" (connectors-plan C4).
2. **The account check**: "You signed in to Hartley Millwork LLC. Is that the company the agents
   should use?" (the sign-in account check, shown as a question).
3. **Who has the login?** When the person setting up doesn't hold the account, "Ask someone else"
   sends just this card to a colleague (built for intake cards; extended to Connect).
4. **The first look**: after the first sync, a profile made by code with no model (counts, top
   vendors, bills a month) under "What we see in QuickBooks". Each line is a "We think" to confirm,
   filed as a `seen` fact (cases-plan §4.6).

The forwarding address and website logins get the same card shape. For forwarding: "Send one test
email to bills@hartley.mezonas.com and we'll show it here". For a site with no API: the dedicated
agent account's login goes straight into the vault, with a short guide to creating that account
(§1.26).

## 6. See it work

### 6.1 The walkthrough

The process as a story, one card per step, made by code from the SOP (`sopSteps`) with the client's
seats, tools and settings filled in. Each card shows how the step works (Rules, AI, Person), what it
does in one sentence and what it changes:

> **4. Luis approves bills over $5,000.** *Person.* Luis gets the bill on his Desk with the PDF and
> the vendor's last three bills. He has 2 business days; if he's away, Dana.

Each card answers one of three ways:

- **Looks right.**
- **A choice**, where the operator made the setting adjustable (builder-plan §7, B5): "Bills over
  [$5,000] need Luis" within its bounds. Tightening or staying within bounds applies at once, as a new
  version by code. Beyond the bounds, it becomes an ask.
- **We do it differently**: typed or said to Sloan, who asks a follow-up if needed. It is filed as
  a change ask on the agent's build, tied to the step's id and in the client's words. The lead sees it
  on the setup board. The client sees "Ana has this. We'll show you the change before it's used."

### 6.2 Try it on a real one

The moment the client sees it work on their own data, before anything is live:

- **Pick something real**: a recent bill from the forwarded inbox, QuickBooks or an upload. The card
  lists the last few so it's one click.
- **A test run** of the agent's latest version on it: reads through the client's connections, and
  writes nothing (invariant 8: test runs never write). Person steps and approvals show who would have
  been asked, and nobody is notified.
- **The result in words**, on the portal's run timeline in test mode: "Would create a draft bill in
  QuickBooks: Northside Lumber, $4,812.50, 3 lines, due Dec 14. Would not ask Luis (under $5,000).
  Would ask Dana."
- **Each step: "Right" or "Not right because…"**, filed on the build as a change ask with the run as
  its source (invariant 10). Kept as the build's test cases inside the client; never copied out of it.
- Up to three tries per agent at setup. Started by any client user with the agent's cards; costed
  to the client like any test run, at most one at a time.

## 7. Go live

- **The scope** (O5) is the end of the walkthrough, in the same words: what it does, what it reads,
  what it may change (approval on), who's in each seat, the choices they made, and what is still
  open. The client admin signs it. A later change is a new version, signed again.
- **The trial, explained before it starts**: "For the first two weeks every change waits for your
  signature on your Desk. Expect your first bills tomorrow morning." The agent's stage moves from
  setup to trial when its guarded items are done and the operator presses Start trial. The trial
  always starts with the operator, never by itself.
- **What happens next** (the email, O5), then Getting started gives way to the Desk.

## 8. The back office: the setup board

On the client's page, a **Setup** tab: the same chapters across the top and the agents down the side.
Each cell shows done, waiting on whom and for how long, or not needed.

- **Waiting on whom**, with "Nudge" (Reggie drafts, Autopilot `draft`, §6 of cases-plan) and the
  person's last visit.
- **Change asks** from the walkthrough and tries, each on its step, to accept into the build, answer,
  or decline with a reason the client reads.
- **Do it on a call**: the lead fills answers while talking to the client. Each answer's source is
  `call` and shows to the client as "From our call: please check". The client confirms a chapter with
  one click. The lead can never connect a tool, sign the scope or fill a `signs` seat for them.
- **Start trial**: enabled when the agent's guarded items are done, with what it will do in one
  confirm.

### 8.1 The runbook

The operator's plan for every client, shown on the board as a timeline, with to-dos on Your call when
a day passes without progress:

| When | What | Who |
|---|---|---|
| Day 0 | Invite or Sign up now; the branded email | Lead |
| Day 0–2 | Chapters 1–3 on their own (about 15 minutes) | Client |
| Day 2 | Kickoff call (30 minutes): the walkthrough and a try together, seats confirmed | Lead and client admin |
| Day 2–3 | Change asks built; the scope sent | Lead, Builder |
| Day 3 | Scope signed; Start trial | Client admin, then lead |
| Day 3–17 | Trial: every write signed; a check-in at day 7 | Client, lead |
| Day 17 | Sign-off and live | Client admin |

Reminders at day 2 and 5 without progress (cases-plan §4.4) are drafted for the lead to send.

## 9. Changing the process: choose, ask, never

| Level | What | How it applies |
|---|---|---|
| **Choose** | Adjustable settings within bounds; tightening an approval (a lower amount, another approver); who sits in a seat | At once, as a new version by code, logged and written in the SOP |
| **Ask** | Anything else: a different step, an exception, another tool, a setting beyond its bounds | A change ask on the build, tied to the step; the lead decides; the client sees it before it's used |
| **Never from setup** | Turning an approval off, a new write, more access than the agents need | Said in one line where it would come up: "Approvals stay on during the trial. You can turn some off with Ana after it." |

This keeps invariants 8, 9 and 11. Clients never edit agents. They choose among what the operator
built and ask for the rest.

## 10. What it takes in code

No table for any use case (§12.0); nothing special-cases a pack.

| Piece | Where | Migration |
|---|---|---|
| Seats: `PersonRole.kind` and `label`; `seat:<role>` in `Who`; validation of seat references and kinds | `packages/core` (`reach/rules.ts`, `process/schema.ts`, `process/validate.ts`) | None |
| Seat bindings with users and order | `agent.people` (jsonb) gains `userIds`, `order`, `backup`; core schema for the binding | None |
| The resolver and activation | `packages/agents` runtime (`resolveApprover` and the person step's assignee), the activation check | None |
| Templates move to seats | New versions of seeded and pack templates, naming `seat:` where they name `client_admin` today | None (new versions) |
| The People, Tools, See it work and Go live chapters | `apps/web/src/portal/screens/` (Getting started grows chapters) and portal routes in `packages/core/src/api` | None |
| A guide field kind `people` (a seat's answer) | `packages/core/src/onboarding/guide.ts` | None (`intake_answer.value` is jsonb) |
| Try it on a real one | A portal route starting a test run of the agent's latest version on a chosen record or document; the client-safe timeline in test mode | None |
| Change asks tied to steps | `build_item` (or `client_ask`, cases-plan) with a step id and a run id | Check when built |
| The setup board | `apps/web/src/ops/client/` | None |

Contract tests to add: no portal route returns a bundle, a prompt or a seat's internal role name
beyond its label; a viewer can't be put in a `signs` seat; a client test run writes nothing and
notifies no one; a `call`-sourced answer counts only once the client confirms it.

## 11. Steps

Each ends green and goes to staging.

| Step | What | Done when |
|---|---|---|
| SU1 | Seats in core, the runtime and activation; the SOP reads them; the Bill clerk template on seats | One template version runs at two test clients with different approvers and no per-client version |
| SU2 | Chapters on Getting started; the People chapter (seats, invites, contacts, backups, the matrix) | A test admin fills four seats from "We think" lines and invites one colleague in under five minutes |
| SU3 | Tools: what it's for, the account check, Ask someone else on Connect, the first look | Connecting the QuickBooks sandbox shows its profile, and a wrong company is caught |
| SU4 | See it work: the walkthrough with choices and "We do it differently" | A changed threshold applies as a new version; a "different" lands on the build tied to its step |
| SU5 | Try it on a real one | A test client runs the Bill clerk on a forwarded bill and nothing is written or sent |
| SU6 | The setup board, Do it on a call, Start trial, the runbook's to-dos | The owner sets up a test client on a call, end to end, from the board |
| with O4 | Sloan across every chapter (proposals into seats, follow-ups on "different") | A test client finishes setup by chat; every seat shows its source and their confirmation |
| with O5 | The scope from the walkthrough; signing starts the build's checks and the trial button | A signed scope lists the seats and choices the client made |

Order: SU1 first (the other steps need seats), then SU2 and SU3 in parallel, then SU4, SU5 and SU6.
O4 and O5 fold in as they land.

## 12. Open for the owner

1. **Seat changes after the trial starts.** The design applies them at once and tells the lead. Or
   should a change to a `signs` seat go through the lead?
2. **Try it on a real one without us.** The design lets any client user with the agent's cards start
   up to three test runs. Or only on the kickoff call?
3. **Approvers must sign in.** The design: yes, every `signs` seat is a client user, who may approve
   from the Desk, the phone app or an emailed link. Fine?
4. **Answers from a call.** The design: the client confirms each chapter with one click. Or may the
   lead's word count?
5. **The trial's length.** The design says two weeks. Per agent, or one default?
6. **Chapter order.** Tools before People (the design: tools first, since the first look fills
   "We think" lines for people, vendors and volumes).
