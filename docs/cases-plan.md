# Back office work: Sales, onboarding and Build (design and plan, agreed 2026-11-17)

**Status (2026-11-17): Build, Sales, Your call and Reggie are built; onboarding is in progress.**
The owner asked for the back office work built on 2026-11-17. It is on two stacked PRs, not merged
until the owner says so: the migrations (0060–0063, PR #380, `claude/ops-work-migrations-szb740`)
and the code on top of it (PR #383, `claude/ops-work-szb740`): Build, Sales, Your call, and Reggie
with Autopilot and `support@`/`hello@` email, all against fakes. The decisions are `docs/plan.md`
§1.124 (the §8 questions it answered are recorded there), the milestones M64–M68. Onboarding (§4)
is being built on top of it, in steps O1 to O6 (§7). The text below is the plan as agreed; its
"nothing here is built" is history for everything but onboarding.

The owner wants one place in the back office to bring clients in, sell them more, and build and
fix what they need, with Reggie doing most of the work so one person can run many clients'
agents. **Nothing here is built.** This is the agreed design and the plan to come back to. It is
outside ARCHITECTURE v0.19's v1 scope: when it is picked up, it is recorded as the owner's
decision in `docs/plan.md` §1, as Reggie (§1.101) and builds (§1.108) were.

Onboarding was designed separately the same day and folded in here (owner, 2026-11-17: "merge this
into that part... that'll go in almost at the same time, so we don't need to build a separate
process"). The owner's asks for it:

- A knowledge base about each client before we start: "We'll talk to them most of the time. We
  will know them, at least at the beginning", kept growing, in the CRM or on Reggie's side.
- Sloan talking to them up front, but a way to "get to the point: here's a few questions about a
  couple proposed agents. Let us know if there's a different process you want to look at."
- "A branded email and an invite", and from the lead record, "okay, invite", with a flow to create
  "a general intake or an intake for these set of agents... or these areas".
- "A way to not have to go through the full process. If there's somebody that's ready to sign up,
  we could just say, just send them this. It gets logged into the CRM... at the right step, but it
  doesn't force me to go step by step."

The design is in two files; serve the repo root over http and open them:

- `docs/design/workflows.html`: the workflows, agreed 2026-11-16.
- `docs/design/pipelines.html`: the clickable screens, agreed 2026-11-17. Made-up data, wired to
  nothing. It doesn't show onboarding yet (§4): the client file, Invite, Sign up now, the emails
  and Getting started are described here only.

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
| Builds (§1.108) | A new agent or skill from intake to go-live; a template's client intake form. | No promised date; nothing links a build to the deal or ask that started it; "filling the form for a client is next". |
| Reggie (§1.101) | The operator's agent: reads across clients, proposes changes as cards (`client_create`, `agent_add`). | No sales, issue, to-do or client-file tools. |
| Run review queue | Runs held for a person. | Separate from everything else that needs a person. |
| New client (§1.14) | Makes a client and invites its admin; WorkOS sends its own invitation. | No record of how the client came; an unbranded invitation; nothing for the client to do once signed in. |
| Notification emails (§1.37) | Mezonas' mail over Resend, a plain card in six languages. | No logo or brand. |
| Knowledge base (§1.21) | Per-client FAQs, policies and documents that agents search. | Only once a client exists, and everything in it is the client's to see. |

Nothing covers prospects: a lead lives in the owner's inbox until it is a client, and what we learn
about them lives in our heads.

## 2. The shape

Two sections in the sidebar, each opening on one list across its kinds, and one to-do list over
everything:

- **Your call**: the one to-do list. What needs a person, with Reggie's read, its plan and a
  draft, ready to send, edit or snooze. Tabs for what Reggie is on, what waits on clients, and
  what Reggie did on its own today (to spot-check and flag).
- **Sales**: New accounts and Expansion. Tabs: All deals (the start), New accounts, Expansion.
  **Sign up now** next to New (§4.3).
- **Build**: Issues, Agent builds and Enhancements. Tabs: All work (the start, the work order),
  Issues, Agent builds, Enhancements.
- **Clients**: each client's page has everything open for it in Sales and Build, its to-dos (yours,
  Reggie's, the client's), one activity timeline (messages, questions, runs, decisions) and its
  **client file** (§4.1). A prospect has the same page before there's a client: it is the lead
  record, with **Invite** on it (§4.2).
- **Autopilot**: for each stage, what Reggie does and how far it goes alone: off, draft for me, or
  send and tell me. Some steps are always the operator's (§6).

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

- Each deal has a client (or, before set-up, a company: its client file, §4.1), what is being sold,
  the agents in it, the revenue a month, the next step and its due date. Each stage has a
  likelihood for the weighted total.
- **Stages are a record, not a gate.** A deal can move forward past any stage; a skipped stage
  shows as skipped, with who and why ("signed up directly"). Something a later stage would want
  that isn't there (a price, the signed contract) becomes a to-do with a due date on Your call,
  never a block. Only the steps that are always the operator's (§6) need a confirm.
- **Every account is in Sales.** A client made anywhere else (the back office's New client, Reggie's
  `client_create`, Sign up now) gets a New account deal at **Set up the account**, the stages
  before it marked skipped, unless a deal for that company already exists, which moves there
  instead.
- Reggie spots expansion in live clients nightly (work we see but don't handle, volume growth)
  and opens a deal with its evidence. It holds the pitch while the client has an open critical or
  high issue, or is at risk.
- Contracts and terms are by hand for now: the operator records the agreed price, from when, and
  the signed copy. Later they move to a Billing page the client agrees on.
- **Set up the account is done by sending an invite** (§4.2) or by Sign up now (§4.3): either one
  makes the client, invites its people, adds the agents chosen on the bench, opens one agent build
  per agent at **Requirements request**, and opens the client's intake. An invite can go at any
  stage from Qualified: a general intake before the proposal moves the deal to Set up the account
  early, and the proposal follows from the answers.
- **First agent live** closes the deal won when the first of its agents signs off (§1.36).

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
- **Requirements request is the agent's part of the client's intake** (§4.5): its card, its
  questions (the template's client intake form, pre-filled from the client file), its tools to
  connect. The build shows that card's progress ("7 of 12 answered", what's missing, who has it).
  It closes when the card is done and the client has signed the scope (§4.7). There is one intake
  per client, not one questionnaire per build: a new client with three agents answers once. A
  build for an existing client adds its card to a new or open intake and sends "A few more
  questions" (§4.4). Reggie chases; gaps become the client's or the operator's to-dos.
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
Reggie drafts a knowledge entry. Questions asked during onboarding land here too.

## 4. Onboarding: from a lead to the first agent built

### 4.1 The client file

Every prospect and client has one, from the first conversation, kept for as long as they're a
client. It is the company a deal points at before set-up, so a lost deal keeps it and a later deal
reuses it.

| Section | Examples |
|---|---|
| The business | What they do, where, how big, seasons, what a good month looks like. |
| People | Who's who, who decides, who does the work today, who approves what. |
| Systems | QuickBooks Online (company name), Gmail for AP, a supplier portal, their spreadsheets. |
| Volumes | About 340 bills a month, 42 active vendors, 3 locations. |
| Processes | How a bill gets from the vendor to paid today, and who touches it. |
| Pains and wants | "Price creep from two lumber vendors nobody notices"; "would hand off chasing W-9s first". |
| Limits | What they never want an agent to do; compliance (HIPAA); who signs over $5,000. |
| Our notes | "Price sensitive", "the CFO is the real buyer". |

Each **fact** has its section, the text, where it came from (a call, our note, an email, a
document, their website, the intake, a connected tool, a run), when, who added it, how sure we are
(`heard`, `seen` in a document or tool, `confirmed` by the client) and who may see it: **`theirs`**
(about their business: shown to the client to confirm in the intake, then in their knowledge base)
or **`ours`** (our notes: operator only, always; never shown to the client, Sloan or their agents,
invariant 11). New facts start `ours` unless plainly about the business. A correction is a new fact
that replaces the old one; nothing is edited in place.

How it fills:

- **Calls**: the operator dictates or types a debrief (voice typing, §1.109) or uploads a
  transcript; Reggie proposes the facts it found as one card ("File 12 facts from today's call"),
  each with section, audience and quote, and the operator ticks, edits or drops them.
- **Our notes**: typed in, or "Reggie, note that Dana runs AP and hates spreadsheets".
- **Emails**, once inbound email lands (W1); **documents** they send (stored with the file, moved to
  the client's documents at set-up; reading one proposes facts); **their website**, read by Reggie
  on request as untrusted data (invariant 9).
- **The intake**: answers come back as `confirmed` facts.
- **After go-live**: what the client tells their lead, what Sloan passes on, what runs show, with
  sources (invariant 10).

Reggie reads the file in every conversation about the company. The Builder gets it through a
build's brief, which the operator confirms.

### 4.2 Invite: the flow on the lead record

**Invite** is on the lead record (the prospect's or the client's page, and the deal's). It opens a
short flow in a side panel. Reggie can open it pre-filled ("Invite Acme: general plus Purchasing,
Dana as admin"); only a person sends it.

1. **Who.** People from the file or deal, or a new name and email. One is the **admin**; others join
   as client users, with the whole intake or only some sections ("Mark: just the Bills
   questions"). §1.14's refusals apply first (an operator's address, someone in another client).
2. **What it covers.** Any mix of:

   | Kind | What it asks | Questions from |
   |---|---|---|
   | **General** | The business: what they do, team and roles, systems, volumes, how work flows, what hurts, what they'd hand off first, limits. | Ours, fixed, in core. |
   | **Areas** | Per chosen area (Purchasing, Bookkeeping, Marketing; Sales and Receivables when they have packs): how it works today, tools, volumes, who does it, what goes wrong. | Each pack's manifest declares its area's section as data; an area without a pack gets core's generic area questions. The platform never imports a pack. |
   | **Agents** | Per chosen template: what its build needs before it can start (tools to connect, answers, files). | The template's client intake form (§1.108). |

   Reggie suggests what to cover from the file, with why.
3. **The questions.** Merged so a shared one ("who approves") is asked once, and filled from the
   file: **known** (a `confirmed` fact: not asked), **to confirm** ("We think: bills come to
   ap@acme.com", Yes or Change), **to ask**. Only `theirs` facts appear. The operator can drop,
   reword, add or mark "ask later", sees the total ("6 to confirm, 8 questions, 1 tool, about 15
   minutes"), and picks how they start: **get to the point** or **talk it through with Sloan**.
4. **The email.** Reggie drafts a note from the lead from the file, in the operator's voice (§1.42
   voice samples, if any); the operator edits it and previews the email and welcome page as they'll
   be seen, in the person's language. Send now or at a time.
5. **Send.** One confirmation listing everything it does:

   > Makes **Acme** a client in Mezonas, with you serving it. Invites **Dana Ruiz** as its admin
   > and **Mark Lee** for the Bills questions. Adds **Vendor contracts and invoice review** (on the
   > bench, approvals on) and opens its build. Opens the intake (general, Purchasing, 1 agent).
   > Moves the deal to Set up the account. Emails Dana and Mark.

   The client, people, agents, builds and intake are one transaction (as §1.14's new client); the
   emails go after the commit. The file links to the client, its `theirs` facts are copied into
   the intake, and its documents move to the client's.

On an existing client the same button skips making the account: invite more people, or open an
intake for an expansion or a new area (the Expansion deal moves to Agreed or is opened there).

### 4.3 Sign up now: the quick path

For someone ready to start, without the steps:

- **Where**: Sign up now in Sales, on any lead record, or by asking Reggie ("sign up Dana Ruiz at
  Acme for purchasing"), which opens it filled in.
- **One small form**: company, person and email, and **what to start with**: a saved **start**
  ("Purchasing starter": the Purchasing area and the Vendor contracts agent; "Bookkeeper"; "General
  only"; "Just the account": no intake, the welcome email only). Optionally the agreed price.
- **Everything else defaults**: the start's own note with the lead's name, get to the point, the
  questions filled from the file if there is one, sent now. "Review first" opens the full Invite
  flow at step 3 instead.
- **One confirm**, the same words as Invite's.
- **In the CRM**: a client file if there isn't one; the company's open deal, or a new New account
  deal, at **Set up the account**, the stages before it marked skipped ("signed up directly"),
  with the start's agents and the price if given. On an existing client it is an Expansion deal at
  **Agreed**. What a later stage wants and wasn't given becomes a to-do on Your call ("Record Acme's
  agreed price", due in 7 days; "Attach Acme's signed contract"); "Just the account" adds "What are
  we starting with for Acme?". From there it moves like any deal.
- **Starts** are saved by the operator (name, what they cover, the note, how they start) and
  offered on Invite's step 2 too. A few come seeded: General only, one per area, one per template.

### 4.4 Branded email and pages

Everything the client sees before and during onboarding looks like Mezonas, in their language.

| Email | When | From |
|---|---|---|
| **The invite** | Invite or Sign up now | The lead |
| **A colleague asked** | Extra people, or "Ask someone else" in the intake | The lead, naming who asked |
| **Reminder** | Reggie drafts at 2 and 5 days without progress (Autopilot `draft`) | The lead |
| **A few more questions** | Cards added to an open intake (agents after a general intake, a new build) | The lead |
| **Your scope is ready** | The scope is drafted, to read and sign | Mezonas |
| **What happens next** | The scope is signed: what we're building, when they'll see it | The lead |

The invite carries the lead's note, what's in it in one line ("Two agents and a few questions
about how Acme handles bills; about 15 minutes"), one button (**Get started**), who it's from with
their photo, a line on what Mezonas is, "We'll never ask for a password by email", and when the
link expires. Nothing from the file beyond names, and no answers.

- **One branded layout** in core (`packages/core/src/email/`): the logo (a PNG hosted with the app;
  mail clients drop SVG), the design system's colours and type (Geist where the mail client shows
  web fonts), borders not shadows, a plain-text part, readable in light and dark mail clients, six
  languages. Notification emails (`renderNotification`) move onto it after.
- **From** `<Lead name> at Mezonas <hello@mezonas.com>`, **Reply-To** the lead's own address; once
  W1 lands, replies thread into the deal. Mezonas emails from `Mezonas <notify@…>` as today.
- **Sent** through the mailer (Resend) with an idempotency key, logged on the intake (sent,
  delivered, bounced). No open-tracking pixels: the welcome page tells us when the link is opened.
- **The welcome page**, `app.mezonas.com/start/<token>`: a signed link (HMAC over client, intake,
  person and expiry, as the form link, §1.121), seen without sign-in. The client's name, the lead's
  name, photo and note, what's in it and how long, a security line, then **Continue with Google**,
  **Microsoft** or **email** with the invited address filled in. After sign-in it must be the
  invited address, otherwise "This invite is for d•••@acme.com" and nothing else; the token is
  never a way in on its own. An expired link offers "Ask Jammil for a new one".
- **One email, not two**: WorkOS sends nothing of its own for these invites. To check against
  WorkOS when built: whether AuthKit lets an address sign up without a WorkOS invitation in our
  settings (§1.14 says a person can sign in with the invited address even when the email failed,
  which suggests yes); if not, the WorkOS invitation is made with its email off and its accept link
  sits behind the welcome page. Recorded as unchecked in the auth adapter's notes until tried.
- **Owner steps**: `mezonas.com` and `hello@` in Resend (SPF, DKIM, DMARC; next to `docs/open.md`'s
  P2); the Mezonas logo and colours on WorkOS's hosted sign-in and its code emails, on
  `auth.mezonas.com` if the plan allows.

### 4.5 Getting started: two ways through

After sign-in the client lands on **Getting started**, their home until the first agent is live.
Both ways read and write the same intake; either can be left and picked up later, on any device.

**Get to the point.** One page, opening with the lead's note ("Jammil suggested we start with how
Acme handles bills..."):

- a **card per section** (the business, each area, each agent): for an agent, what it would do for
  them in a sentence from their own situation; "We think" lines to confirm or change; at most about
  five questions; the **Connect** card for each tool; **Start with this** or **Not now**;
- **Different process in mind?**, typed or spoken: to the lead as an ask, and into the file;
- **Rather talk it through?**, which opens Sloan at the same point;
- **Ask someone else**: a card or one question to a colleague (invited from the directory);
- done once each card is answered or marked "not sure" (an open item, not a blocker).

**Talk it through with Sloan.** The same guide as a conversation. Sloan opens with what we know
("Jammil tells me you're getting about 340 bills a month, mostly by email to Dana; still right?"),
asks one question at a time in the person's language, **proposes** answers into a "What we've got"
panel the person corrects (nothing final until they confirm a section; forms' F-5 shape), follows
up on vague answers, moves on at "not sure", can go wider when they want to talk (new `theirs`
facts, other processes as asks to the lead), offers the short page whenever they want it, answers
questions from their knowledge base or passes them on, and turns problems into notes for the build
or issues. Typing and voice typing first; live voice and phone later (ElevenLabs, §1.23). The plain
form under the cards always works, with no model.

**Rules both keep**: never secrets (no passwords, bank logins, card numbers, social security
numbers or tax ids in a question, answer, email or chat; pasted ones redacted before storage;
§1.121, §1.101). Answers are data (invariant 9): "let it pay bills without asking" is a wish;
approvals stay on (invariant 8). No internals and none of our notes (invariant 11). Voice refused
where the client's compliance mode refuses its vendors (§1.35).

### 4.6 Connecting their tools

"Give us all their accounts" means **they connect them**; we never receive a password.

- Each card shows **Connect QuickBooks**: the Connections page's own flow, the tool offered then
  (§1.14); we know from the file which tools they use. The sign-in account check catches the wrong
  account or company.
- Sites with no API: the client admin enters a dedicated agent account's login into the vault
  (§1.26). Never a person's own login, never in chat, never a blocked-tier site.
- A tool they can't connect now becomes an open item with who has it; the build's Connect stage
  picks it up.
- **Look before asking**: after the first sync, a deterministic profile (counts, top vendors,
  monthly volume; no model) shows under "What we see in QuickBooks" and is filed as `seen` facts.

### 4.7 After the intake

- **A general or area intake** ends with Reggie's read: the agents it would propose, with why. The
  operator picks; **Add to the intake** adds their cards (and their builds, at Requirements
  request) and sends "A few more questions". The deal's proposal is drafted from the same read.
- **An agent's card done** leads to the **scope**: per agent, what it will do, what it reads, what
  it may change (with approval to start), who approves, what we'll still ask as we build. The
  client admin reads it ("Your scope is ready"), corrects it, and signs it; a change later is a new
  version signed again. Signing:
  - moves confirmed `theirs` facts into the client's **knowledge base** (§1.21, a new kind
    `about`), with the file as their source;
  - closes each build's **Requirements request** and starts **Building** at §1.108's fit-gap, its
    brief filled from the scope and the file (the operator confirms it: the intake gate) and the
    template's intake form filled from the answers;
  - turns every "not sure" and "ask later" into a `build_item` with who has it; the client's come
    back to them a few at a time on Getting started or as Desk requests;
  - sends "What happens next".

## 5. Data (to confirm when built)

| What | Where | Why |
|---|---|---|
| `client_file` (the company: name, website, the client it became; status `prospect`, `client`, `lost`) and `client_fact` (section, text, source and reference, sureness, audience, replaces, who, when; insert only) | Operator-only (RLS on `app_is_operator()`; tied to a client only for operators serving it) | The lead record; exists before the client and holds our notes. Documents before set-up in operator storage under the file. |
| `deal` (kind `new` or `expansion`), `deal_person`, `deal_activity` | Operator-only | A deal points at its client file; an expansion deal carries its `client_id`. Revenue is `numeric(14,4)` and currency (invariant 6). Skipped stages are `deal_activity` rows. |
| `start` (a saved quick start: name, what it covers, the note, how it starts) | Operator-only | Sign up now and Invite's presets. |
| `intake` (what it covers, the guide with each field's state, the people and their sections, the start mode, the lead's note, status `sent`, `open`, `scope_ready`, `signed`, `done`), `intake_answer` (insert only), `intake_scope` (versioned, signed) | Tenant tables, forced RLS | The client-facing part is the client's. Holds only `theirs` facts, copied in at sending. Sloan's conversation is a `thread` with `subject_type = 'intake'`. |
| `issue`, `issue_event` | Tenant table, forced RLS | An issue belongs to its client, who sees its own in the portal (invariant 1). Its conversation is a `thread` with `subject_type = 'issue'`; internal notes use `audience: 'operator'` as threads do. |
| `client_ask` and `enhancement` | Ask: tenant table. Enhancement: operator-only, grouping asks across clients by id | One client's words never reach another client (invariant 11). |
| Builds | The existing build tables, plus `promised_on`, a link to the deal or ask that started it, and its intake card | |
| `todo` | Operator-only; owner `operator`, `reggie` or `client`, due date, linked item | The client's to-dos reach them as Desk items, lead requests or intake cards. |
| `play_setting` | Operator-only | Autopilot: per flow, stage and play, `off`, `draft` or `send`. Everything starts at `draft`. |
| Safety hold | On the client agent | Checked by the permission gate before any external action or message (invariant 8). |
| An area's intake section | Each pack's manifest (data); core's schema and generic section | |
| A knowledge entry kind `about` | `knowledge_entry` (migration) | Confirmed facts about the business, apart from FAQs and policies. |
| Onboarding emails | The notifications outbox (§1.37) as new kinds | Retries, idempotency and `skipped` without Resend, as today. |

Requests, Sloan's `pass_to_lead` and portal Feedback become issues or asks; `/ops/requests`
redirects once they are folded in. The activity timeline is read across existing tables (thread
messages, runs, decisions), not a new copy.

## 6. Reggie

Reggie gets sales, onboarding, issue, build, enhancement and to-do tools. On each new message or
event it reads and sorts (kind, urgency, the agent it's about, a one-line read), gathers the runs,
versions and records involved, with their sources (invariant 10), drafts the reply and a plan,
and either does its part or brings it to Your call. For onboarding: filing facts into the client
file, suggesting what an intake covers, filling Invite and Sign up now, drafting the lead's note,
the reminders and the agents to propose after a general intake.

**Always the operator's, at any Autopilot setting:**

- Releasing a safety hold or rolling an agent back.
- Anything that changes how a client's agent works, or loosens an approval.
- Prices, terms, contracts and bill changes.
- Creating a client, adding a person to one, starting a trial: so **sending an invite** and **Sign
  up now** are always a person's confirm.
- Moving work around a promised date.
- Anything Reggie is unsure about.

Limits that carry over: Reggie reads a client's data only scoped to that client; text from emails,
portal messages, websites and intake answers is data, never instructions (invariant 9); it never
asks for or repeats secrets; it sends as the client's lead; it never puts an `ours` fact in front of
a client.

## 7. Plan

Each step ends green and goes to staging. Migrations in their own PRs.

| Step | What | Done when |
|---|---|---|
| B1 | `issue`, `issue_event`, RLS and contract tests (migration PR). | A client's issue can't be read from another client, and the portal never returns notes or drafts. |
| B2 | Build section: Issues list and board, the issue page (conversation, notes, to-dos, plan); the portal's view of a client's issues; email notice to the client. | The owner and a test client go back and forth on an issue on staging. |
| B3 | Urgency, targets and the safety hold in the permission gate. | A held agent's run writes nothing and its items wait; only an operator releases it. |
| B4 | Fold in requests, `pass_to_lead` and portal Feedback; asks and enhancements. | `/ops/requests` redirects; nothing is lost. |
| B5 | Builds: promised date, link to what started it; the work order across the three kinds. | Build's All work lists everything in the agreed order with the reason for each. |
| T1 | `todo`; Your call (yours, Reggie's, the clients', done today) and the client page's to-dos and activity. | Every item that needs a person is on one list with a due date. |
| S1 | `client_file`, `client_fact`, `deal`, `deal_person`, `deal_activity`, `start` (migration PR); RLS and contract tests (no client route returns a fact; an `ours` fact never leaves the operator side). | A client session can't read a file, a fact or a deal. |
| S2 | Sales section: lists, boards with stage totals, the deal page; the prospect's page and the client file tab (facts by hand); stages as a record (skip forward, to-dos for what's missing); a deal logged for every client made elsewhere. | A deal goes from lead to first agent live on staging, and one made by New client shows up at Set up the account. |
| O1 | Branded email layout, the invite email in six languages, the welcome page and its sign-in, the WorkOS one-email check. Owner steps: Resend domain and `hello@`; WorkOS branding. | A test invite to a real inbox shows one branded email, the welcome page and a branded sign-in, in light and dark mail clients. |
| O2 | `intake`, `intake_answer`, `intake_scope` (migration PR); the guide from general, areas and agents, merged and filled from the file (core). | A guide for general, Purchasing and one agent asks "who approves" once and skips what the file has confirmed. |
| O3 | **Invite** and **Sign up now** (with starts), opening builds at Requirements request; **Get to the point** (cards, "We think", Connect, "Different process in mind?", "Ask someone else"); the build's Requirements panel reading its card. | From a lead record on staging the owner invites a test admin, who answers the cards and connects the QuickBooks sandbox in about fifteen minutes; Sign up now does the same in one confirm and the deal lands at Set up the account. |
| O4 | **Talk it through**: Sloan's intake workflow (platform template v3), proposals into fields, going wider, switching both ways. Recorded fixtures; a nudge in an answer changes nothing. | A test client finishes the same intake by chat and voice typing; every field shows its source and their confirmation. |
| O5 | After the intake: proposed agents and Add to the intake; the scope and signing; facts into the knowledge base; builds into fit-gap with briefs; the tool profile; reminders and the remaining emails. | A general intake on staging leads to proposed agents, a signed scope and builds in fit-gap, with nothing asked twice. |
| A1 | Reggie's tools, the read-gather-draft pass (including filing facts from a debrief, document or website), and Autopilot with every play at `draft`. | Each new issue shows a read and a draft within a minute; a pasted call debrief becomes facts the owner ticks; nothing is sent without a person. |
| W1 | Inbound email (`support@`, `hello@`), reply threading and outbound; then the site's "Get started" form, opening a lead. | An email from a client's person opens an issue; a reply to an invite lands on its deal. |
| O6 | Live voice and phone for the intake (ElevenLabs, §1.23), with the compliance entry. | A spoken intake fills the same fields as a typed one. |

Order: Build first (B1–B5: it gives clients a way to talk to us and fixes one-way requests), then
the to-do list (T1), then Sales with the client file (S1–S2), then onboarding (O1–O5, which needs
the deals and the files; O1 can start any time, since it only needs the owner's Resend and WorkOS
steps), then Reggie (A1), then email (W1, which needs the owner's Email Routing and Resend steps,
`docs/open.md` P1 and P2), then voice (O6). Until A1, facts are typed into the file by hand.

## 8. Open for the owner

1. Does a high issue also get a safety hold, or only critical? (The design: critical only.)
2. Does a critical issue alert the operator's phone?
3. Can to-dos belong to named people on the team? (The design: you, Reggie or the client.)
4. Builds have a promised date. (The design assumes yes.)
5. Deals as operator-only tables, or a Sales pack on the Mezonas client, as Marketing is? (The
   onboarding design assumes operator-only: the client file holds our notes.)
6. The client's word in the portal: keep "Requests", or "Issues"?
7. One inbound address or two (`support@`, `hello@`)?
8. Later: contracts and terms on a client Billing page; routing inbound email.
9. Who sends the invite: from the lead by name (the design: `Jammil at Mezonas
   <hello@mezonas.com>`, replies to you), or from Mezonas?
10. Inviting before a proposal: a general intake makes the account early (the design). Fine, or
    keep a no-sign-in questionnaire for very early leads?
11. Areas without a pack yet (Sales, Receivables): offer them with generic questions (the design),
    or only areas with packs?
12. The default start when the operator doesn't choose: get to the point (the design) or Sloan?
13. Our notes: operator only, never shown to the client or their agents (the design)? Anything an
    agent should know becomes a `theirs` fact the client confirms, or a rule on the agent.
14. A lost prospect's file: kept 12 months after the deal is lost, then deleted (the design)? A lost
    lead we'd invited: retire its account at Lost (the design)?
15. The scope signature before we build (the design), or is the proposal enough?
16. Calls with you: recorded and transcribed into the file, or your own debriefs to start? (The
    design: debriefs first.)
17. Reminders: drafted for you to send (the design), or sent by Reggie and told to you?
18. Which starts to seed for Sign up now (the design: General only, one per area, one per
    template)?
