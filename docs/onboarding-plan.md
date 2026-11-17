# Client intake and onboarding: from a lead to the first agent built (design, 2026-11-17)

The owner asked how a new client should come in: invited with no account yet, signing in,
going through an onboarding **interview** (conversational: chat, voice, or a call), connecting
their tools, telling us what they need, their questions and their issues, and then us building
their agents from that. And whether to make them have an account so it all has somewhere to land,
and how it ties into the Sales and Build work (`docs/cases-plan.md`, on branch
`claude/ops-case-management-crm-459452-szb740`).

**Nothing here is built.** This is a design and a plan to agree. Like `docs/cases-plan.md`, it is
outside ARCHITECTURE's v1 scope; when it is picked up it is recorded as the owner's decision in
`docs/plan.md` §1.

## 0. In short

1. **Two conversations, not one.** A short **discovery** before they buy (no account: a link, 10
   to 15 minutes, about the business and what hurts), and the real **intake interview** after they
   say yes (in their portal, signed in, 30 to 60 minutes over as many sittings as they like,
   with their tools connected as it goes).
2. **Yes, make the account at "yes", and not before.** The account (the client) is what gives the
   interview somewhere safe to land: their own encryption key for connections, forced RLS, their
   documents, the audit log, their directory, Sloan. Connecting QuickBooks or Gmail needs it in any
   case: a connection belongs to a client and the client signs in to it themselves (invariant 13).
   Before "yes" a prospect is a deal, not a client, so we don't make a client for every lead.
3. **One interview for everything sold.** The questions come from the client intake forms of the
   templates in the deal (§1.108's fit-gap `setup`), plus a fixed section about the business,
   merged so nothing is asked twice. Not one questionnaire per agent.
4. **Any way they like to answer, one record.** Typing, voice typing, talking live in the browser,
   a phone call, a call with their Mezonas lead, or just the plain form. Every path fills the same
   structured answers, each with where it came from, and the client confirms what we heard.
5. **Look before asking.** Once a tool is connected, its first sync answers what it can ("we see
   about 340 bills a month from 42 vendors; is that about right?"), so the interview gets shorter
   as it goes.
6. **The interview ends in a scope the client signs**, and that scope opens the builds: one
   §1.108 build per agent sold, its brief and intake form filled, every gap an open item with who
   has it. Their questions are answered on the spot or become asks; their issues become issues.

## 1. What we already have

Most of this is wiring together what exists.

| Piece | Where | What onboarding uses it for |
|---|---|---|
| New client with its admin invited, one transaction | §1.14 "New client", `POST /api/ops/clients` | Making the account at "yes". |
| WorkOS invitations; sign-in without a password (Magic Auth, Google) | §1.14 "Inviting", plan.md §1 "Auth provider" | The invite email and the first sign-in. |
| Invite a person from the directory | §1.14 "Invite from the directory" | The admin handing a section to a colleague (their bookkeeper for bills). |
| Tools offered when an agent needs them; client signs in to each | §1.14 "New client, no offer"; the Connections page | Connecting in the middle of the interview. |
| Browser logins in the vault, entered by the client admin | §1.26 phase 3 | Sites with no API. The operator never sees them. |
| Sign-in account check, QuickBooks company switch | `main`, PRs #392 and #393 | Catching the wrong account or company while they connect. |
| Forms: "Request info", a link with no sign-in, drafts, files | §1.121, `docs/forms-plan.md` | The discovery link's page; the plain-form fallback of the interview. |
| "Talk it through" beside a form (F-5, planned) | `docs/forms-plan.md` §2.3 | The interview's conversation: proposals into fields the person accepts. |
| Voice typing | §1.109 | Speaking answers. |
| ElevenLabs voice agents on Twilio | §1.23 | Live voice and phone interviews (later steps). |
| Sloan, the client's account agent | §1.47 | The interviewer: the face they keep after onboarding. |
| Reggie, the operator's agent, with `client_create`, `agent_add`, Desk requests | §1.101 | Setting the client up, chasing, turning answers into builds. |
| Builds: intake → fit-gap → draft → POC → client test → QA → live | §1.108 | Where the interview's output goes. |
| Template's client intake form (tools, answers, files, with hints) | §1.108 "Client intake form" | The interview's questions. "Filling the form for a client is next": this is that. |
| Knowledge base search | Sloan's `knowledge.search` | Answering their questions during the interview. |
| Go-live stages and the client admin's sign-off | §1.36 | The end of onboarding. |

What's missing: a record of the intake inside the client, the interview itself, the portal's
"Getting started", the hand-off into builds, and (from `docs/cases-plan.md`) the deal it starts from.

## 2. The account question

| Option | For | Against |
|---|---|---|
| A. No account ever needed for intake: everything by link | Least friction | Can't connect tools without a client and a signed-in admin. Answers would sit outside a client's RLS and key. Two places for the same facts. |
| B. Make the client at first contact | One place from the start | A client (with its key, Sloan, audit, compliance mode) for every lead, most of whom never buy. Retiring them is offboarding (§1.35). Muddies "a client is someone we serve". |
| **C. Deal before "yes", client at "yes" (recommended)** | Leads stay light (an operator-only deal); the deep work happens where it's safe and where tools can connect. Matches `docs/cases-plan.md` §3.1: "Set up the account" is a stage of the deal. | Two steps for the prospect: a link, then a sign-in. Kept small by carrying everything from the first into the second. |

**Recommendation: C.** "Yes" can be a signed proposal or, for a paid or trial start, the owner's
word; either way the operator (or Reggie's `client_create` card) makes the client and invites the
admin, and the discovery answers move in with it. The invite is the start of onboarding, not a
separate step before it.

One sign-in, no password: the invite opens WorkOS with "Continue with Google", "Continue with
Microsoft" or an emailed code, and lands on **Getting started** with Sloan's first message already
there.

## 3. The journey

| # | Deal stage (`cases-plan.md` §3.1) | What the client does | What we see | Account? |
|---|---|---|---|---|
| 1 | Lead | Fills "Get started" on the site, or emails, or we meet them | A deal: company, person, what they said | No |
| 2 | Qualified | Gets an email from their lead with a **discovery link** | Reggie's read of the lead; the link's status | No |
| 3 | Diagnostic | Answers the discovery (10–15 min): chat, voice, or a call with the lead instead | Answers on the deal; a suggested set of agents (templates) with why | No |
| 4 | Proposal and contract | Reads and signs the proposal (by hand for now) | Agreed price, agents sold | No |
| 5 | Set up the account | Gets the invite, signs in, lands on Getting started | The client made, the admin invited, the agents added in `bench`, the intake opened with the discovery answers in it | **Yes, from here** |
| 6 | (Build: requirements) | **The intake interview**: connects tools as it goes, hands sections to colleagues, asks questions | The intake filling up, what's left and on whom, on the client page and in Your call | Yes |
| 7 | (Build: requirements) | Reads the scope ("what we're building for you") and signs it | Scope signed; builds open, one per agent, briefs filled | Yes |
| 8 | (Build: bench test → trial) | Watches progress on Getting started; answers the few questions the build still has | The §1.108 builds | Yes |
| 9 | First agent live | Signs off the first agent's trial (§1.36) | Deal closed won; Getting started becomes Home | Yes |

The discovery (3) is optional: a referral who already said yes goes straight to 5, and the intake
just asks the business section too.

## 4. The interview

### 4.1 What it asks (the guide)

The interview follows a **guide**: a list of sections and fields, built when the intake opens:

1. **About the business** (fixed, ours): what you do, who's on the team and who does what, the
   tools you use, volumes, what a good month looks like, what keeps going wrong, what you'd hand
   off first, anything you never want an agent to do.
2. **One section per kind of work sold**, from each template's client intake form (§1.108): the
   tools to connect, the answers (a tolerance, the AP address, who approves what), the files
   (vendor contracts, a price list). Fields the templates share (who approves, the accounting tool)
   are asked once and used by each.
3. **People and approvals**: who signs what, who should get a login, who the agents may contact.
   These go in as drafts the client admin approves, as Sloan's `add_signer` does (§1.47).
4. **Your questions and anything else**: open.

Each field has a kind (as forms: text, number, money, date, choice, yes or no, files, a table, or
**a tool to connect**), whether it's required to start the build, and a hint for the interviewer.
The operator can add and remove fields on the intake before or during it; the client sees the
guide's sections as a checklist.

### 4.2 How it talks

The interviewer is **Sloan**, in the client's portal, on Getting started. // DECISION (proposed):
Sloan, not a new agent: it is the face the client keeps afterwards, already sees only what the
portal shows, and already drafts people changes for the admin's approval.

- One question at a time, in plain words, in the person's language (§1.27 `languageFor`).
  It explains why it's asking when that helps ("so the agent knows when a price change is worth
  telling you about").
- It **proposes** answers into fields; the person sees them fill in a panel beside the chat
  ("What we've got") and can correct any of them. Nothing is final until they confirm the section.
  This is forms' F-5 shape: talk on one side, the structured record on the other.
- It follows up where an answer is vague ("most bills come by email" → "To one address, or to
  several people?") and moves on when the person says "not sure": that becomes an open question,
  not a dead end.
- It can be left at any point and picked up later, by the same person or a colleague, on any device.
- **"Ask someone else"**: the admin hands a section to a colleague (invited from the directory as a
  client user); they sign in to just that section. Their answers carry their name.
- **Questions** they ask are answered from the knowledge base when it can; otherwise "I'll ask
  your lead", and it becomes an ask for the operator (cases-plan §3.3).
- **Problems** they describe ("our last bookkeeper miscoded everything") are kept as notes for the
  build, and, if they're about something we already run for them, an issue.

### 4.3 The ways to answer

| Way | How | Step |
|---|---|---|
| Plain form | The guide as a form: every section, every field. Works with no model at all. | I2 |
| Chat | Typing, or voice typing (§1.109) | I3 |
| Live voice in the browser | Talk to Sloan out loud; the transcript appears and fields fill as it goes. ElevenLabs on Mezonas' account (§1.23), named in `packages/core/src/compliance` | I6 |
| Phone call | "Call me at 3 pm": Sloan calls from Mezonas' number, or they call in. The transcript fills the same fields, marked "from the call: please check" | I6 |
| Call with their lead | A person-to-person call with the owner. Its notes or transcript are uploaded to the intake; Reggie proposes the answers, which the client confirms | I4 |

Every answer keeps **where it came from** (form, chat, voice, call, the lead, a document, a
connected tool) and **who confirmed it**. An answer from a call, the lead or a tool is a proposal
until the client confirms it.

### 4.4 Rules it keeps

- **Never secrets.** It never asks for, repeats or writes down passwords, bank logins, card
  numbers, social security numbers or tax ids; for those it sends the person to the screen made for
  them (Connections, the vault, Settings). As forms refuse them (§1.121) and Reggie never asks
  (§1.101). If someone pastes one, it is redacted before storage, as reply text is.
- **Answers are data** (invariant 9). They become the build's brief, which the operator confirms
  and the Builder reads as data, never as instructions. "Let the agent pay bills without asking"
  is recorded as a wish; approvals are still on by default (invariant 8) and only the operator
  loosens them, later, deliberately.
- **No internals** (invariant 11): Sloan never shows bundles, prompts, cost or other clients.
- **HIPAA mode**: voice typing and live voice are refused where the client's mode refuses their
  vendors (§1.35); the form and typed chat still work.

## 5. Connecting their tools

"Give us all their accounts" means **they connect them**; we never receive a password.

- When the interview reaches a tool, it shows a **Connect QuickBooks** card inline. That is the
  Connections page's own flow: the tool is offered then (§1.14), the person signs in at the
  provider, and the connection belongs to the client with their key.
- The sign-in account check catches the wrong account or company, and Sloan says so in plain words.
- Sites with no API: the client admin enters a dedicated agent account's login into the vault
  (§1.26); never a person's own login, never in chat, and never for blocked-tier sites.
- A tool the person can't connect now (needs their IT, or the accountant owns it) becomes an open
  item on the intake with who has it, and the lead can send a Desk request for it later.
- **Look before asking**: after the first sync, a deterministic **profile** of what's there
  (counts, top vendors, monthly volume, the date range; no model) is shown on Getting started under
  "What we see in QuickBooks". Sloan reads it like any portal screen (it can't reach connector
  tools: §1.47's guard stays) and uses it to confirm rather than ask.

## 6. From answers to builds

When the required fields are in, Sloan writes a **scope** in plain words: for each agent, what it
will do, what it reads, what it may change (with approval), who approves, and what is still open.
The client admin reads it, corrects it with Sloan, and **signs it**. It is versioned: a later
change is a new version signed again.

Signing opens the builds (Reggie proposes, the operator confirms, as every Reggie change):

- One §1.108 build per agent sold, for this client, starting at **fit-gap**: its brief (goal,
  start, data in, data out) is filled from the scope and confirmed by the operator, which is the
  intake phase's gate.
- The template's client intake form on each build is **filled** from the answers (the "next" in
  §1.108's "Client intake form" row).
- Every open question becomes a `build_item` with who has it (the client, you, the Builder).
  Items the client has come back to them on Getting started, and as Desk requests when they're
  away; Reggie chases.
- The agents added at set-up stay in `bench` until their builds reach client test; the trial and
  the sign-off are §1.36's. The first agent's sign-off closes the deal.

Getting started stays the client's home until the first agent is live: what we have, what we're
waiting on from them, what we're building and when they'll see it.

## 7. How it ties into Sales and Build

`docs/cases-plan.md` (the back office's Sales, Build and Your call) already has the pipeline this
sits on. The intake is the bridge between its two halves:

| cases-plan | Onboarding |
|---|---|
| Sales, new account: **Diagnostic** | The discovery link and its answers, on the deal. Reggie suggests the agents to sell from them. |
| Sales, new account: **Set up the account** | Makes the client, invites the admin, adds the agents sold, **opens the intake** with the discovery answers. |
| Build, agent build: **Requirements request** | Replaced, for a new client, by the intake interview: one interview for every agent in the deal instead of one questionnaire per template. For a single added agent later it is the same interview with only that agent's section. |
| Sales, **Expansion** | An agreed expansion opens a short intake in the existing client: the new agent's section only, plus anything changed. |
| **Your call** | "Acme's intake: 70%, waiting on their bookkeeper for Bills since Friday"; "Scope ready to send"; "Call notes to turn into answers". |
| **Clients** page | The intake's progress, its open items and its activity in the client's timeline. |
| **Questions** (§3.3) and **Issues** | The interview's questions and problems land there, not in a separate list. |
| **Autopilot** | Reggie's plays for onboarding (send the discovery link, chase a stalled intake, draft the scope) start at `draft`. Making the client, adding people and signing the scope are always a person's (§5 there). |

Without the Sales section built yet, the intake still works: the operator makes the client by hand
(or with Reggie), adds the agents and opens the intake. Only the discovery link needs the deal.

## 8. Data (to confirm when built)

| What | Where | Why |
|---|---|---|
| `intake`: the guide (sections and fields, with each field's source template), status (`open`, `scope_ready`, `signed`, `closed`), the deal it came from, the agents it's for | Tenant table, forced RLS | It is the client's. One per onboarding or expansion. |
| `intake_answer`: field, value, source (`form`, `chat`, `voice`, `call`, `lead`, `document`, `tool`), who gave it, who confirmed it, sources (message, transcript or record ids) | Tenant table, forced RLS, insert only | A changed answer is a new row; the latest confirmed one counts. History stays (as invariant 3's spirit). |
| `intake_scope`: version, the text per agent, who signed, when | Tenant table, forced RLS, insert only | What we agreed to build. |
| The conversation | A `thread` with `subject_type = 'intake'` | Threads already carry messages, voice and files; internal notes use `audience: 'operator'`. |
| Discovery answers before "yes" | On the deal (`docs/cases-plan.md` §4, operator only) | A prospect has no client. Copied into the intake at set-up; the deal keeps a pointer. |
| The tool profile | Read live from the connection's synced records | Nothing new to store. |

Migrations in their own PR, as always.

## 9. Plan

Each step ends green and goes to staging.

| Step | What | Done when |
|---|---|---|
| I1 | `intake`, `intake_answer`, `intake_scope` with RLS and contract tests (migration PR). The guide built from the business section and the templates' intake forms, shared fields merged (core). | A client's intake can't be read from another client; a guide for two templates asks "who approves" once. |
| I2 | Portal **Getting started**: the checklist, the plain form, Connect cards inline, "Ask someone else". The back office's intake on the client page. Opening an intake from the client page. | A test client admin fills the whole intake by form on staging and connects the QuickBooks sandbox from it. |
| I3 | **The interview**: Sloan's intake workflow (platform template v3), proposals into fields, confirm by section, knowledge answers, questions and problems routed. Recorded fixtures; a nudge inside an answer changes nothing. | A test client goes through the intake by chat and voice typing; every field it filled shows its source and their confirmation. |
| I4 | **Scope and hand-off**: Sloan drafts the scope; the admin signs; Reggie's `builds_open` card opens one build per agent at fit-gap with the brief and intake form filled and the open items. The lead's call notes turned into proposed answers. The tool profile. | Signing a scope on staging opens the builds, and the operator sees no question asked twice. |
| I5 | **Discovery link** (after cases-plan S1, the deal): the forms page with a short guide and the chat, no sign-in; answers on the deal; carried at set-up. | A lead answers the discovery, the deal shows it, and the intake opens with it. |
| I6 | **Live voice** in the browser and **phone interviews** (ElevenLabs, §1.23), with the compliance entry. | A spoken intake fills the same fields as a typed one. |

Order: I1 to I4 first: they need only what exists today and give every new client a way in. I5
waits for the deals table. I6 last: it is the most expensive and the form, chat and voice typing
cover the same ground.

Size, roughly: I1 a few days; I2 and I3 a week or two each; I4 a week; I5 a few days once deals
exist; I6 one to two weeks.

## 10. Open for the owner

1. **When is "yes"?** A signed proposal only, or also a paid diagnostic or a free trial start? (The
   design: the operator decides per deal; the client is made then.)
2. **The interviewer**: Sloan (the design), or a separate onboarding name?
3. **The scope signature**: does the client sign the scope before we build (the design), or is the
   proposal enough?
4. **Discovery by link**, or always a call with you first? (The design: offer both; the link is
   optional.)
5. **Phone interviews from which number?** A Mezonas number of our own (the design), or none until
   the client has theirs.
6. **Calls with you**: do you want them recorded and transcribed into the intake (needs a recorder
   and consent), or is uploading your own notes enough to start?
7. **Getting started's length**: one sitting of about 45 minutes is the target. Is that right for
   your clients, or should the first pass be shorter, with the rest asked by each build?
