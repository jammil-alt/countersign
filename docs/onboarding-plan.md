# Client intake and onboarding: from a lead to the first agent built (design, 2026-11-17)

The owner asked how a new client should come in: invited with no account yet, signing in,
telling us what they need (conversationally: chat, voice, or a call), connecting their tools, and
then us building their agents from that; whether to make them have an account so it all has
somewhere to land; and how it ties into the Sales and Build work (`docs/cases-plan.md`, on branch
`claude/ops-case-management-crm-459452-szb740`).

Then (owner, 2026-11-17): "We'll talk to them most of the time. We will know them, at least at the
beginning... So we should create a knowledge base about the client before we even start", built
in the CRM or on Reggie's side and kept growing. And: "Sloan talks to them up front... But there
are moments where they just need to get to the point: hey, why don't we get started? Here's a few
questions about a couple proposed agents. Let us know if there's a different process you want to
look at."

**Nothing here is built.** This is a design and a plan to agree. Like `docs/cases-plan.md`, it is
outside ARCHITECTURE's v1 scope; when it is picked up it is recorded as the owner's decision in
`docs/plan.md` §1.

## 0. In short

1. **We know them before they sign in.** Every prospect and client has a **client file** in the
   back office: what we've learned about the business, its people, its systems, its volumes, how
   its processes run, what hurts and what it wants, each fact with where we heard it. We and Reggie
   fill it from calls, notes, emails, documents they send and their website, from the first
   conversation on, and it keeps growing after they're live.
2. **Make the account at "yes", not before.** Before "yes" a prospect is a client file and a deal
   (operator only). At "yes" we make the client and invite its admin. The account is what gives
   their answers and connections somewhere safe to land (their own key, forced RLS, their
   documents, audit, Sloan), and connecting QuickBooks or Gmail needs it anyway (invariant 13).
3. **The invite arrives already written for them.** From the file, Reggie proposes one to three
   agents to start with and works out what we still need to know. The operator reviews it and
   sends it. The client doesn't start from a blank page: they **confirm what we think** and answer
   only what we don't know.
4. **Two ways through, one record.** **Get to the point**: a page with the proposed agents, what
   we already know about each (confirm or correct), the few questions still open, the Connect
   buttons, and "Different process in mind? Tell us". About ten minutes. Or **talk it through with
   Sloan**: the same content as a conversation (typing, voice, later a call). They can switch
   either way at any point, and the operator picks which they see first.
5. **Only what's needed to start.** The first pass asks only the questions each agent needs before
   its build can start. Everything else is asked later, a little at a time, by the build that needs
   it.
6. **It ends in a short scope the client signs**, which opens one build per agent (§1.108), its
   brief filled from the file and the answers. Confirmed facts about their business go into the
   client's knowledge base, where their agents can use them.

## 1. What we already have

Most of this is wiring together what exists.

| Piece | Where | What onboarding uses it for |
|---|---|---|
| Per-client knowledge base (`knowledge_entry`, versions, `knowledge.search`) | §1.21 | Where confirmed facts about the business go once the client exists, for their agents. |
| Reggie, the operator's agent, with cards (`client_create`, `agent_add`, Desk requests) | §1.101 | Filling the client file, proposing the agents and the invite, setting the client up. |
| New client with its admin invited, one transaction | §1.14 "New client" | Making the account at "yes". |
| WorkOS invitations; sign-in without a password | §1.14 "Inviting", plan.md §1 "Auth provider" | The invite and the first sign-in. |
| Invite a person from the directory | §1.14 | Handing a question to a colleague (their bookkeeper). |
| Tools offered when an agent needs them; the client signs in to each | §1.14, the Connections page | Connecting from the invite page. |
| Browser logins in the vault, entered by the client admin | §1.26 phase 3 | Sites with no API. The operator never sees them. |
| Sign-in account check, QuickBooks company switch | `main`, PRs #392, #393 | Catching the wrong account or company while they connect. |
| Forms: the field kinds, drafts, files, no-secrets rule | §1.121, `docs/forms-plan.md` | The Get-to-the-point page's questions; the discovery link. |
| "Talk it through" beside a form (F-5, planned) | `docs/forms-plan.md` §2.3 | Sloan's conversation: proposals into fields the person accepts. |
| Voice typing; ElevenLabs voice agents on Twilio | §1.109, §1.23 | Speaking answers; voice and phone later. Also the operator's voice notes after a call. |
| Sloan, the client's account agent | §1.47 | The conversation. |
| Builds and the template's client intake form | §1.108 | Where the answers go; which questions each agent needs. |
| Go-live stages and the client admin's sign-off | §1.36 | The end of onboarding. |

What's missing: the client file, the invite composer, the Get-to-the-point page, Sloan's intake
conversation, the scope, the hand-off into builds and (from `docs/cases-plan.md`) the deal.

## 2. The client file

### 2.1 What it holds

One file per company, from the first conversation, kept for as long as they're a client.

| Section | Examples |
|---|---|
| The business | What they do, where, how big, seasons, what a good month looks like. |
| People | Who's who, who decides, who does the work today, who approves what, who we talk to. |
| Systems | QuickBooks Online (company name), Gmail for AP, a supplier portal, spreadsheets they live in. |
| Volumes | About 340 bills a month, 42 active vendors, 3 locations. |
| Processes | How a bill gets from the vendor to paid today, step by step, and who touches it. |
| Pains and wants | "Price creep from two lumber vendors nobody notices"; "would hand off chasing W-9s first". |
| Limits | What they never want an agent to do; compliance (HIPAA); who must sign anything over $5,000. |
| Our notes | Relationship, commercial and personal impressions: "price sensitive", "the CFO is the real buyer". |

Each **fact** has: its section, the text, where it came from (a call, our note, an email, a
document, their website, the discovery, the intake, a connected tool, a run), when, who added it,
how sure we are (`heard`, `seen` in a document or tool, `confirmed` by the client), and who may
see it:

- **`theirs`**: about their business. Shown to the client to confirm during onboarding; once
  confirmed it can go into their knowledge base.
- **`ours`**: our notes. Operator only, always. Never shown to the client, never in the client's
  knowledge base, never read by Sloan or their agents (invariant 11). New facts start `ours`
  unless they're plainly about the business; the operator can change it.

A fact is never edited in place: a correction is a new fact that replaces the old one, so we can
see how our picture changed.

### 2.2 How it fills

| From | How |
|---|---|
| A call or meeting | The operator dictates or types a quick debrief (voice typing, §1.109) or uploads a transcript. Reggie reads it and proposes the facts it found as one card ("File 12 facts from today's call"), each with its section, audience and quote; the operator ticks, edits or drops them. |
| Our own notes | Typed straight into the file, or "Reggie, note that Dana runs AP and hates spreadsheets". |
| Emails | Once inbound email lands (cases-plan W1), a prospect's or client's email can be filed the same way. |
| Documents they send | A sample invoice or price list is stored with the file; reading it (the documents capability) proposes facts like "bills arrive as PDFs from 3 vendors". Before "yes" these sit with the file (operator storage); at set-up they move to the client's documents. |
| Their website | Reggie reads the public site on request and proposes facts. The page is untrusted data (invariant 9). |
| The discovery and the intake | Answers become facts (`confirmed` when the client gave or confirmed them). |
| After go-live | Reggie files what the client tells their lead, what Sloan passes on, and what runs show ("bills up 40% since March"), as facts with their sources (invariant 10). The file keeps growing. |

### 2.3 Where it lives and who reads it

- **Operator only** (RLS on `app_is_operator()`, as Reggie's and the builds' tables; a file tied to
  a client only for operators serving it). A prospect has no client, so the file can't be a tenant
  table, and our notes must never be. // DECISION (proposed)
- It is the **company** that `docs/cases-plan.md`'s deal points at before set-up ("a client or,
  before set-up, a company"), so a lost deal keeps its file and a later deal reuses it.
- **Reggie reads it** with every conversation about that company, and uses it to propose agents,
  write the invite, draft messages and brief builds.
- **The Builder reads it** through the build's brief (the operator confirms what goes in), as data.
- **The client sees** only `theirs` facts, and only as proposals to confirm during onboarding, then
  in their knowledge base once confirmed. They never see the file itself, its sources or our notes.
- **A lost prospect's file** is kept for a period then deleted (owner's question below); it is
  personal data about people who never became clients.

## 3. The account question

| Option | For | Against |
|---|---|---|
| A. No account ever needed for intake: everything by link | Least friction | Can't connect tools without a client and a signed-in admin. Answers would sit outside a client's RLS and key. |
| B. Make the client at first contact | One place from the start | A client (key, Sloan, audit, compliance mode) for every lead. Our notes don't belong in a tenant anyway. |
| **C. Client file and deal before "yes", client at "yes" (recommended)** | Leads stay light and everything we learn is still kept; the client-facing work happens where tools can connect. Matches `docs/cases-plan.md`'s "Set up the account" stage. | Our knowledge and the client's account are two records, joined at set-up. |

**Recommendation: C.** "Yes" is the operator's call per deal: a signed proposal, a paid
diagnostic, or "let's try it". Setting up makes the client, invites the admin, links the file to
the client, and moves its documents in. The agents on the invite can still be **proposals**: the
client confirms which to start with during onboarding.

## 4. The journey

| # | Deal stage (`cases-plan.md`) | The client | Us | Account? |
|---|---|---|---|---|
| 1 | Lead | Gets in touch, or we meet them | A client file and a deal | No |
| 2 | Qualified, Diagnostic | Talks to us (calls, emails); optionally answers a short **discovery link** | The file fills: facts from every call, note, document; Reggie suggests agents with why | No |
| 3 | Proposal and contract | Agrees to start | Price, the proposed agents | No |
| 4 | Set up the account | — | The client made, the file linked, the agents added in `bench`, the **invite composed** | Yes |
| 5 | (Build: requirements) | Gets the invite, signs in, **gets to the point** or **talks it through**, connects tools | Answers and confirmations arrive; anything new is filed | Yes |
| 6 | (Build: requirements) | Reads the short scope and signs it | Builds open, one per agent, briefs filled | Yes |
| 7 | (Build: bench → trial) | Sees progress; answers the odd question a build still has | §1.108's builds | Yes |
| 8 | First agent live | Signs off the first agent's trial (§1.36) | Deal won; Getting started becomes Home; the file keeps growing | Yes |

## 5. The invite

The operator (or Reggie, as a card) composes it on the client's page:

- **The proposed agents**, one to three, from the deal. For each, Reggie works out the **guide**:
  the fields the template's client intake form needs before a build can start (§1.108), plus a
  small fixed set of our own (who approves, anything an agent must never do), and fills each from
  the file where it can:
  - **known**: a `confirmed` fact. Shown as already done, not asked.
  - **to confirm**: a `heard` or `seen` fact. Shown as "We think: bills come to ap@acme.com", with
    Yes or Change.
  - **to ask**: nothing in the file. A plain question.
  Only `theirs` facts can appear; Reggie never puts our notes in front of the client.
- **The start**: Get to the point, or Talk it through with Sloan. The operator chooses per client
  ("we know them well, keep it short").
- **A note from the lead**, in their own words.
- **A preview**: exactly what the client will see, with the count ("2 agents, 4 to confirm, 3
  questions, 1 tool to connect, about 10 minutes"). The operator can drop or reword a question,
  add one, or move a field to "ask later".

Sending invites the admin (WorkOS) and sends our own welcome email with the lead's note and the
link. One sign-in, no password, and they land on **Getting started**.

## 6. Getting started: two ways through

Both read and write the same record (§9). Either can be left and picked up later, on any device.

### 6.1 Get to the point

One page:

> **Let's get started.** Jammil suggested two agents to start with. Confirm what we have, answer
> three questions, connect QuickBooks, and we'll take it from there.

- **A card per proposed agent**: what it would do for them, in one or two sentences from their own
  situation ("Checks every vendor bill against your agreed prices and tells you before you pay
  more"); "We think" lines to confirm or change; the questions (at most about five per agent, each
  with a hint); the Connect card for each tool it needs; and **Start with this** or **Not now**.
- **Different process in mind?** A box (typed or spoken): "Tell us about something else you'd
  rather start with." It goes to the lead as an ask and into the file; Sloan can pick it up.
- **Rather talk it through?** Opens Sloan at the same point, with what they've done so far.
- **Ask someone else**: hand one question or one agent's card to a colleague (invited from the
  directory); they see just that.
- **Done** once each chosen agent's questions are answered or marked "not sure" (which becomes an
  open item, not a blocker), and the scope (§8) is ready to read.

### 6.2 Talk it through with Sloan

The same guide as a conversation. Sloan opens with what we already know ("Jammil tells me you're
getting about 340 bills a month, mostly by email to Dana; is that still right?") and then:

- one question at a time, in plain words, in the person's language (§1.27 `languageFor`), saying
  why when it helps;
- **proposes** answers into fields shown in a "What we've got" panel beside the chat, which the
  person can correct; nothing is final until they confirm a section (forms' F-5 shape);
- follows up where an answer is vague, and moves on at "not sure";
- is free to go wider than the guide when they want to talk about how they work: what it hears is
  proposed as new facts for the file (marked `theirs`, from the client), and other processes they
  mention become an ask to the lead ("They'd also like help with collections");
- offers the short page whenever they want it: "Want me to just show you the questions?";
- answers their questions from their knowledge base or passes them to the lead; problems they
  describe become notes for the build, or issues if they're about something already running.

Ways to talk, in the order we'd build them: typing and voice typing first; live voice in the
browser and phone calls later (ElevenLabs, §1.23, named in `packages/core/src/compliance`). The
plain form under the Get-to-the-point page always works, with no model.

### 6.3 Rules both keep

- **Never secrets.** No passwords, bank logins, card numbers, social security numbers or tax ids
  in a question, an answer or the chat; those go on the screens made for them (§1.121, §1.101).
  Pasted ones are redacted before storage.
- **Answers are data** (invariant 9). "Let it pay bills without asking" is recorded as a wish;
  approvals stay on (invariant 8) and only the operator loosens them, later.
- **No internals and none of our notes** (invariant 11).
- **HIPAA mode**: voice is refused where the client's mode refuses its vendors (§1.35); typing and
  the form still work.

## 7. Connecting their tools

"Give us all their accounts" means **they connect them**; we never receive a password.

- Each agent's card (or Sloan, when it gets there) shows **Connect QuickBooks**: the Connections
  page's own flow. The tool is offered then (§1.14) and the client signs in at the provider. We
  already know from the file which tools they use, so the right buttons are there from the start.
- The sign-in account check catches the wrong account or company, in plain words.
- Sites with no API: the client admin enters a dedicated agent account's login into the vault
  (§1.26). Never a person's own login, never in chat, never a blocked-tier site.
- A tool they can't connect now becomes an open item with who has it.
- **Look before asking**: after the first sync, a deterministic profile of what's there (counts,
  top vendors, monthly volume; no model) is shown under "What we see in QuickBooks" and filed as
  `seen` facts. Remaining "We think" lines it settles are shown as confirmed by the data.

## 8. The scope and the hand-off

When each chosen agent's questions are in, Sloan (or the page) writes a **short scope**: per agent,
what it will do, what it reads, what it may change (always with approval to start), who approves,
and what we'll still ask as we build. The client admin reads it, corrects it, and signs it. A later
change is a new version signed again.

Signing:

- moves confirmed `theirs` facts into the client's **knowledge base** (§1.21) as entries their
  agents can search, with the file as their source; and marks them `confirmed` in the file;
- opens one §1.108 **build** per agent, at fit-gap, its brief filled from the scope and the file
  (the operator confirms it, which is the intake gate), the template's intake form filled from the
  answers;
- turns every "not sure" and every field moved to "ask later" into a `build_item` with who has it.
  The client's come back to them on Getting started or as Desk requests, a few at a time; Reggie
  chases.

The agents added at set-up stay in `bench` until their builds reach client test; trial and sign-off
are §1.36's. Getting started stays their home until the first agent is live: what we're building,
what we're waiting on from them, when they'll see it.

## 9. How it ties into Sales and Build

`docs/cases-plan.md` has the pipeline this sits on. The client file sits under all of it.

| cases-plan | Onboarding |
|---|---|
| **Clients** page | The client file is a tab of it (and of a prospect's page before set-up), with the facts by section, our notes, sources and the timeline. |
| Sales, new account: **Lead → Diagnostic** | The file fills from every conversation; the optional discovery link adds to it; Reggie suggests agents from it. |
| Sales, new account: **Set up the account** | Makes the client, links the file, adds the agents, opens the **invite composer**. |
| Build, agent build: **Requirements request** | For a new client, replaced by the invite and Getting started: one pass for every proposed agent. Later questions are the build's own, asked a few at a time. |
| Sales, **Expansion** | Reggie spots it from the file and the runs; an agreed expansion sends the same kind of invite with one card. |
| **Your call** | "Call with Acme: 12 facts to file"; "Acme's invite ready to send"; "Acme asked about collections instead"; "Scope signed: 2 builds to start". |
| **Questions** and **Issues** | What they ask or report during onboarding lands there. |
| **Autopilot** | Filing facts from our own notes, drafting the invite and chasing start at `draft`. Sending the invite, making the client, adding people and anything about price stay a person's. |

The file comes first and is useful without the rest: it works for today's clients before any Sales
screen exists.

## 10. Data (to confirm when built)

| What | Where | Why |
|---|---|---|
| `client_file`: the company (name, website, the client it became, if any), status (`prospect`, `client`, `lost`) | Operator only (RLS on `app_is_operator()`; tied to a client only for operators serving it) | Exists before the client and holds our notes. The deal's "company". |
| `client_fact`: file, section, text, source kind and reference (message, transcript, document, run, record ids), sureness (`heard`, `seen`, `confirmed`), audience (`theirs`, `ours`), replaces (an earlier fact), who and when | Operator only, insert only | What we know and how we know it (invariant 10). |
| File documents before "yes" | Operator storage under the file; moved to the client's documents at set-up | A prospect has no client storage. |
| `intake`: the guide (agents, fields, each field's state: known, to confirm, to ask, ask later), the start (`point` or `talk`), the lead's note, status (`sent`, `open`, `scope_ready`, `signed`) | Tenant table, forced RLS | The client-facing part is the client's. Holds only `theirs` facts, copied in when the invite is sent. |
| `intake_answer`: field, value, source (`form`, `chat`, `voice`, `call`, `tool`), who gave or confirmed it | Tenant table, forced RLS, insert only | Each answer and confirmation; the latest counts. Filed back as facts on the operator side. |
| `intake_scope`: version, the text per agent, who signed, when | Tenant table, forced RLS, insert only | What we agreed to build. |
| Sloan's conversation | A `thread` with `subject_type = 'intake'` | Threads carry messages, voice and files. |
| A new knowledge entry kind, `about` | `knowledge_entry` (migration) | Confirmed facts about the business, apart from FAQs and policies. |

Migrations in their own PRs.

## 11. Plan

Each step ends green and goes to staging.

| Step | What | Done when |
|---|---|---|
| K1 | **The client file**: `client_file`, `client_fact` (migration PR); the file tab on the client page and a prospect's page; adding facts by hand; RLS and contract tests (no client route ever returns a fact, an `ours` fact never leaves the operator side). | The owner keeps a prospect's and a client's file on staging; a client session can't read either. |
| K2 | **Reggie files facts**: from a debrief or transcript, a document, a website, as one card; Reggie reads the file with every conversation about the company. | A pasted call debrief becomes facts the owner ticks; Reggie's next answer about that client uses them. |
| I1 | `intake`, `intake_answer`, `intake_scope` (migration PR); the guide from the templates' intake forms and the file (core), with known, to confirm and to ask. | A guide for two templates asks "who approves" once and skips what the file has confirmed. |
| I2 | **The invite composer** and **Get to the point**: the preview, the welcome email, the cards, "We think" lines, Connect, "Different process in mind?", "Ask someone else"; the plain form. | A test client admin goes from the invite to answered cards and a QuickBooks sandbox connection on staging in about ten minutes. |
| I3 | **Talk it through**: Sloan's intake workflow (platform template v3), proposals into fields, going wider into new facts, switching both ways. Recorded fixtures; a nudge in an answer changes nothing. | A test client finishes the same intake by chat and voice typing; every field shows its source and their confirmation. |
| I4 | **Scope and hand-off**: the scope, signing, facts into the knowledge base, builds opened at fit-gap with briefs, open items; the tool profile. | Signing on staging opens the builds and fills the client's knowledge base, and the operator sees nothing asked twice. |
| I5 | **Discovery link** before "yes" (after cases-plan S1, the deal), answers filed as facts. | A lead answers the discovery and the file shows it. |
| I6 | **Live voice and phone** (ElevenLabs, §1.23), with the compliance entry. | A spoken intake fills the same fields as a typed one. |

Order: K1 and K2 first: they need nothing else and pay off with today's clients. Then I1 to I4. I5
waits for deals; I6 last.

Size, roughly: K1 a few days, K2 about a week; I1 a few days; I2 and I3 a week or two each; I4 a
week; I5 a few days once deals exist; I6 one to two weeks.

## 12. Open for the owner

1. **When is "yes"?** The design: the operator decides per deal (signed proposal, paid diagnostic,
   or a trial start).
2. **The invite's default start**: Get to the point (the design) or Sloan, when the operator
   doesn't choose?
3. **Our notes**: is "operator only, never shown to the client or their agents" right for
   everything marked `ours`, including what we'd want an agent to know ("never email the owner
   directly")? (The design: anything an agent should know is `theirs` and confirmed with the client,
   or a rule the operator sets on the agent.)
4. **A lost prospect's file**: how long do we keep it? (The design: 12 months after the deal is
   lost, then deleted.)
5. **The scope signature**: does the client sign a scope before we build (the design), or is the
   proposal enough?
6. **Calls with you**: recorded and transcribed into the file (needs a recorder and the other
   side's consent), or your own debrief to start? (The design: debriefs first.)
7. **Phone interviews**: from a Mezonas number of our own, or none until the client has theirs?
8. **The interviewer**: Sloan (the design), or a separate onboarding name?
