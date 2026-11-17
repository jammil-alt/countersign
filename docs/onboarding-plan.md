# Client intake and onboarding: from a lead to the first agent built (design, 2026-11-17)

The owner asked how a new client should come in: invited with no account yet, signing in,
telling us what they need (conversationally: chat, voice, or a call), connecting their tools, and
then us building their agents from that; whether to make them have an account so it all has
somewhere to land; and how it ties into the Sales and Build work (`docs/cases-plan.md`, on branch
`claude/ops-case-management-crm-459452-szb740`).

Then (owner, 2026-11-17):

- "We'll talk to them most of the time. We will know them, at least at the beginning... So we
  should create a knowledge base about the client before we even start", in the CRM or on
  Reggie's side, and keep gathering.
- "Sloan talks to them up front... But there are moments where they just need to get to the point:
  hey, why don't we get started? Here's a few questions about a couple proposed agents. Let us know
  if there's a different process you want to look at."
- "Make sure that we have a branded email and an invite." And "from the lead record in the CRM,
  being able to say, okay, invite", with a flow to create "either just a general intake or an
  intake for these set of agents... or these areas", so we can start getting the right information.

**Nothing here is built.** This is a design and a plan to agree. Like `docs/cases-plan.md`, it is
outside ARCHITECTURE's v1 scope; when it is picked up it is recorded as the owner's decision in
`docs/plan.md` §1.

## 0. In short

1. **We know them before they sign in.** Every prospect and client has a **client file** in the
   back office: what we've learned about the business, its people, systems, volumes, processes,
   pains and wants, each fact with where we heard it. We and Reggie fill it from calls, notes,
   emails, documents and their website, from the first conversation, and it keeps growing.
2. **Invite from the lead record.** One **Invite** button on the lead (the prospect's page, then
   the deal page once Sales is built). A short flow: who to invite; what the intake covers
   (**general**, chosen **areas**, chosen **agents**, or a mix); the questions, already filled from
   the file; the email. Sending makes the account, invites the person, opens the intake and sends
   the email, in one confirmed step.
3. **The account is made when we invite.** Before that a prospect is a client file and a deal
   (operator only). The invite is our "let's get started", and it needs the account: that's where
   their answers, documents and connections land safely (their own key, forced RLS, audit, Sloan),
   and connecting QuickBooks or Gmail needs it anyway (invariant 13).
4. **Branded from the first email.** A Mezonas email from their lead, a branded welcome page before
   sign-in, branded sign-in, and the same look on every onboarding email after it (a colleague asked
   to help, reminders, the scope to sign, what's next). One email, not two: WorkOS doesn't send its
   own.
5. **They confirm what we think and answer only what we don't know**, two ways: **get to the
   point** (one page: cards, "We think" lines, a few questions, Connect buttons, "Different process
   in mind?") or **talk it through with Sloan**. They can switch at any time.
6. **It ends in a short scope the client signs**, which opens one build per agent (§1.108), its
   brief filled. A general or area intake ends instead in Reggie's proposed agents, which the
   operator adds to the same intake with one click and a "few more questions" email.

## 1. What we already have

| Piece | Where | What onboarding uses it for |
|---|---|---|
| Mezonas' own mail over Resend, with idempotency and `skipped` without a key | `apps/api/src/notify/mailer.ts`, §1.37 | Sending the onboarding emails. |
| Notification emails: a plain HTML card, six languages | `packages/core/src/notify/render.ts` | The starting point for the branded layout (it has no logo yet). |
| Signed links with no sign-in (`/f/<token>`, the texting sign-up link) | §1.121, §1.98 | The welcome page's link. |
| The design system: tokens, logos, icons, Geist | `packages/design-system` | The email, welcome page and Getting started. |
| WorkOS sign-in without a password; invitations through `AuthAdapter.invite` | §1.14, plan.md §1 "Auth provider" | Sign-in; the invite's membership. |
| New client with its admin invited, one transaction | §1.14 "New client" | What sending the invite does first. |
| Invite a person from the directory | §1.14 | Inviting colleagues to help. |
| Per-client knowledge base (`knowledge_entry`, `knowledge.search`) | §1.21 | Where confirmed facts go, for their agents. |
| Reggie with cards (`client_create`, `agent_add`, Desk requests) | §1.101 | Filling the file, proposing what to ask, drafting the invite. |
| Tools offered when an agent needs them; the client signs in to each | §1.14, the Connections page | Connecting from the intake. |
| Browser logins in the vault, entered by the client admin | §1.26 phase 3 | Sites with no API. |
| Sign-in account check, QuickBooks company switch | `main`, PRs #392, #393 | Catching the wrong account or company. |
| Forms: field kinds, drafts, files, the no-secrets rule; "talk it through" (F-5, planned) | §1.121, `docs/forms-plan.md` | The intake's questions; Sloan's conversation. |
| Voice typing; ElevenLabs voice agents on Twilio | §1.109, §1.23 | Speaking answers; the operator's debriefs; voice and phone later. |
| Sloan, the client's account agent | §1.47 | The conversation. |
| Builds and each template's client intake form | §1.108 | Agents' questions; where the answers go. |
| Packs, one per business area (Materials for purchasing, Bookkeeping, Marketing) | ARCHITECTURE §12.0 | Areas' questions. |
| Go-live stages and the client admin's sign-off | §1.36 | The end of onboarding. |

## 2. The client file

### 2.1 What it holds

One file per company, from the first conversation, kept for as long as they're a client.

| Section | Examples |
|---|---|
| The business | What they do, where, how big, seasons, what a good month looks like. |
| People | Who's who, who decides, who does the work today, who approves what. |
| Systems | QuickBooks Online (company name), Gmail for AP, a supplier portal, the spreadsheets they live in. |
| Volumes | About 340 bills a month, 42 active vendors, 3 locations. |
| Processes | How a bill gets from the vendor to paid today, step by step, and who touches it. |
| Pains and wants | "Price creep from two lumber vendors nobody notices"; "would hand off chasing W-9s first". |
| Limits | What they never want an agent to do; compliance (HIPAA); who must sign anything over $5,000. |
| Our notes | Relationship, commercial and personal impressions: "price sensitive", "the CFO is the real buyer". |

Each **fact** has its section, the text, where it came from (a call, our note, an email, a
document, their website, the intake, a connected tool, a run), when, who added it, how sure we are
(`heard`, `seen` in a document or tool, `confirmed` by the client), and who may see it:

- **`theirs`**: about their business. Shown to the client to confirm in the intake; once confirmed
  it can go into their knowledge base.
- **`ours`**: our notes. Operator only, always: never shown to the client, never in their knowledge
  base, never read by Sloan or their agents (invariant 11). New facts start `ours` unless they're
  plainly about the business; the operator can change it.

A fact is never edited in place: a correction is a new fact that replaces the old one.

### 2.2 How it fills

| From | How |
|---|---|
| A call or meeting | The operator dictates or types a debrief (voice typing, §1.109) or uploads a transcript. Reggie proposes the facts it found as one card ("File 12 facts from today's call"), each with section, audience and quote; the operator ticks, edits or drops them. |
| Our own notes | Typed into the file, or "Reggie, note that Dana runs AP and hates spreadsheets". |
| Emails | Once inbound email lands (cases-plan W1), an email can be filed the same way. |
| Documents they send | Stored with the file; reading one proposes facts ("bills arrive as PDFs from 3 vendors"). Before the account exists they sit in operator storage; at the invite they move to the client's documents. |
| Their website | Reggie reads the public site on request and proposes facts. The page is untrusted data (invariant 9). |
| The intake | Answers and confirmations come back as facts (`confirmed`, from the client). |
| After go-live | What the client tells their lead, what Sloan passes on, what runs show ("bills up 40% since March"), with sources (invariant 10). |

### 2.3 Where it lives and who reads it

- **Operator only** (RLS on `app_is_operator()`, as Reggie's and the builds' tables; a file tied to
  a client only for operators serving it). A prospect has no client, so the file can't be a tenant
  table, and our notes must never be one. // DECISION (proposed)
- It is the **lead record** until Sales is built: the prospect's page in the back office, with the
  file, its documents, its timeline and the Invite button. Once `docs/cases-plan.md`'s deals exist,
  a deal points at it ("a client or, before set-up, a company"), shows it as a tab, and carries the
  same Invite button. A lost deal keeps its file; a later deal reuses it.
- **Reggie reads it** with every conversation about that company. **The Builder** gets it through
  the build's brief, which the operator confirms, as data.
- **The client sees** only `theirs` facts, as "We think" lines in the intake and then in their
  knowledge base once confirmed. Never the file, its sources or our notes.
- **A lost prospect's file** is kept for a period, then deleted (owner's question).

## 3. The account question

| Option | For | Against |
|---|---|---|
| A. No account for intake: everything by link | Least friction | Can't connect tools without a client and a signed-in admin. Answers outside a client's RLS and key. |
| B. Make the client at first contact | One place from the start | A client (key, Sloan, audit, compliance mode) for every lead. Our notes don't belong in a tenant. |
| **C. Client file before, account when we invite (recommended)** | Leads stay light and everything we learn is kept; the client-facing work happens where tools can connect; the account is made by a deliberate step on a qualified lead. | A lead we invite and then lose leaves a client to retire (§1.35's offboarding, from the deal's Lost). |

**Recommendation: C.** Sending the invite is the moment, whatever stage the deal is at: before a
proposal for a general intake, after it for agents. The first draft also had a no-sign-in discovery
questionnaire for early leads; a general intake replaces it (owner's question below).

## 4. The journey

| # | Deal stage (`cases-plan.md`) | The client | Us | Account? |
|---|---|---|---|---|
| 1 | Lead | Gets in touch, or we meet them | A client file (the lead record) | No |
| 2 | Qualified, Diagnostic | Talks to us | The file fills from every call, note, email, document; Reggie suggests areas or agents | No |
| 3 | Any stage from Qualified | Gets **our invite email** | **Invite** on the lead record: who, what it covers, the questions, the email. Sending makes the account. | **Yes, from here** |
| 4 | | Opens the **welcome page**, signs in, lands on **Getting started**; gets to the point or talks it through; connects tools; asks colleagues | Answers arrive and are filed; Your call shows progress | Yes |
| 5 | Diagnostic → Proposal | (General or area intake) Gets proposed agents with "a few more questions" | Reggie proposes agents from the answers; the operator adds them to the intake | Yes |
| 6 | Proposal and contract | Agrees; reads the short scope and signs it | Builds open, one per agent, briefs filled | Yes |
| 7 | Set up → building | Sees progress; answers the odd question a build still has | §1.108's builds | Yes |
| 8 | First agent live | Signs off the first agent's trial (§1.36) | Deal won; Getting started becomes Home; the file keeps growing | Yes |

A referral who's already agreed goes straight to an agents intake at step 3.

## 5. Invite: the flow on the lead record

**Invite** opens a short flow in a side panel. Reggie can open it pre-filled ("Invite Acme:
general plus Purchasing, Dana as admin"), but only a person sends it.

### 5.1 Who

- The people from the file or deal, or a new name and email. One is the **admin** (the client admin
  of the account to be made); others join as client users. Each can be given the whole intake or
  only some sections ("Mark: just the Bills questions").
- The usual refusals apply before anything is made: an address that is an operator or already
  belongs to another client is refused (§1.14), in plain words.

### 5.2 What it covers

Any mix of three kinds, each adding sections to one intake:

| Kind | What it asks | Where its questions come from |
|---|---|---|
| **General** | The business: what they do, team and roles, systems, volumes, how work flows, what hurts, what they'd hand off first, limits. | Ours, fixed, in core. |
| **Areas** | For each chosen business area (Purchasing, Bookkeeping, Marketing; Sales and Receivables when they have packs): how it works today, its tools, volumes, who does it, what goes wrong. | Each pack declares its area's intake section as data in its manifest (core's schema, wired by apps/api; the platform never imports a pack). An area without a pack yet gets core's generic area questions. |
| **Agents** | For each chosen template: what it needs before its build can start (tools to connect, answers, files). | The template's client intake form (§1.108's fit-gap `setup`). |

Reggie suggests what to cover from the file, with why ("They talked about vendor price creep twice:
Purchasing, or the Vendor contracts agent"). Choosing agents adds them to the account in `bench`
when it's made (`agent_add`, approvals on).

### 5.3 The questions

The guide, built from the chosen kinds with shared questions merged ("who approves" once), and
filled from the file:

- **known**: a `confirmed` fact. Not asked.
- **to confirm**: a `heard` or `seen` fact: "We think: bills come to ap@acme.com", Yes or Change.
- **to ask**: nothing in the file.

Only `theirs` facts can appear. The operator can drop or reword a question, add one, mark one
"ask later", and see the total ("General and 1 agent: 6 to confirm, 8 questions, 1 tool, about 15
minutes"). And picks how they start: **get to the point** or **talk it through with Sloan**.

### 5.4 The email

Reggie drafts **a note from the lead** from the file, in the operator's voice (their voice samples,
§1.42, if any). The operator edits it. The panel previews the email and the welcome page exactly as
they'll be seen, in the person's language. Send now or at a time.

### 5.5 Send

One confirmation that says everything it will do:

> Makes **Acme** a client in Mezonas, with you serving it. Invites **Dana Ruiz** as its admin and
> **Mark Lee** for the Bills questions. Adds **Vendor contracts and invoice review** (on the bench,
> approvals on). Opens the intake (general, Purchasing, 1 agent). Emails Dana and Mark.

It runs as one transaction where it can (the client, the people, the agents, the intake; as §1.14's
new client), then the emails after the commit, so nobody is emailed about an invite that rolled
back. The file links to the client; its `theirs` facts are copied into the intake and its documents
move to the client's. The deal shows "Invited" with the intake's progress.

**On an existing client** the same button skips making the account: invite more people, or open
another intake (an expansion, a new area).

## 6. Branded email and pages

Everything the client sees before and during onboarding looks like Mezonas, in their language.

### 6.1 The emails

| Email | When | From |
|---|---|---|
| **The invite** | Sent from the lead record | The lead |
| **A colleague asked** | "Ask someone else" in the intake, or extra people on the invite | The lead, naming who asked |
| **Reminder** | Reggie drafts at 2 and 5 days without progress (Autopilot `draft`); the operator sends | The lead |
| **A few more questions** | Sections added to an open intake (agents after a general intake) | The lead |
| **Your scope is ready** | The scope is drafted, to read and sign | Mezonas |
| **What happens next** | The scope is signed: what we're building, when they'll see it | The lead |

The invite carries: the lead's note; what's in it in one line ("Two agents and a few questions
about how Acme handles bills; about 15 minutes"); one button, **Get started**; who it's from, with
their photo; a line on what Mezonas is; "We'll never ask for a password by email"; when the link
expires. Nothing from the file beyond the company's and people's names, and no answers.

How they're built:

- **One branded layout** in core (`packages/core/src/email/`): the Mezonas logo (a PNG hosted with
  the app; email clients drop SVG), the design system's colours and type (Geist where the client
  shows web fonts, a system font otherwise), borders not shadows, a plain-text part, readable in
  light and dark mail clients, all strings in the six languages. Notification emails
  (`renderNotification`) move onto it after.
- **From** `<Lead name> at Mezonas <hello@mezonas.com>`, **Reply-To** the lead's own address, so
  replies reach a person; once inbound email lands (cases-plan W1), replies thread into the deal.
  Mezonas emails (scope ready) from `Mezonas <notify@…>` as today. // DECISION (proposed)
- **Sent** through the mailer (Resend), each with an idempotency key, logged on the intake (sent,
  delivered or bounced). No open-tracking pixels: we know when the link is opened from the welcome
  page, and that's enough.

### 6.2 The welcome page

`app.mezonas.com/start/<token>`: a signed link (HMAC over client, intake, person and expiry, as the
form link, §1.121), no sign-in needed to see it.

- The client's name, the lead's name and photo and note, what's in the intake and how long it
  takes, a line on security, and **Continue with Google**, **Continue with Microsoft**, **Continue
  with email** (sign-in with the invited address filled in).
- After sign-in it must be the invited address; otherwise "This invite is for d•••@acme.com", and
  nothing else is shown. The token is never a way in on its own.
- An expired link offers "Ask Jammil for a new one", which tells the lead.
- Then straight to Getting started, with the person's sections.

### 6.3 Sign-in and one email

- **WorkOS sends nothing of its own for the invite.** Today `AuthAdapter.invite` has WorkOS send
  its invitation (§1.14). For onboarding the membership is written as now, and our email is the
  only one. To check against WorkOS: whether AuthKit lets an address sign up without a WorkOS
  invitation in our settings (§1.14 says a person can sign in with the invited address even when
  the email failed, which suggests yes); if not, create the WorkOS invitation with its email
  turned off and use its accept link behind our welcome page. Recorded in the auth adapter's notes
  as unchecked until tried. // DECISION (proposed)
- **WorkOS's hosted sign-in** gets the Mezonas logo and colours, on our own domain
  (`auth.mezonas.com`) if WorkOS allows it on our plan. Its sign-in code emails get the same
  branding in WorkOS's settings. These are owner steps in the WorkOS dashboard.
- **Sending domain**: `mezonas.com` verified in Resend (SPF, DKIM, DMARC), with `hello@` set up.
  An owner step, next to `docs/open.md`'s P2.

## 7. Getting started: two ways through

Both read and write the same intake. Either can be left and picked up later, on any device.

### 7.1 Get to the point

One page, opening with the lead's note:

> **Let's get started.** Jammil suggested we start with how Acme handles bills. Confirm what we
> have, answer a few questions, connect QuickBooks, and we'll take it from there.

- **A card per section** (the business, each area, each agent): for an agent, what it would do for
  them in a sentence from their own situation; "We think" lines to confirm or change; the questions
  (at most about five per card); the Connect card for each tool; and, for agents, **Start with
  this** or **Not now**.
- **Different process in mind?** A box, typed or spoken: it goes to the lead as an ask and into the
  file.
- **Rather talk it through?** Opens Sloan at the same point.
- **Ask someone else**: hand a card or one question to a colleague (invited from the directory; the
  "A colleague asked" email); they see just that.
- **Done** once each card is answered or marked "not sure" (an open item, not a blocker).

### 7.2 Talk it through with Sloan

The same guide as a conversation. Sloan opens with what we already know ("Jammil tells me you're
getting about 340 bills a month, mostly by email to Dana; is that still right?") and:

- asks one question at a time, in plain words, in the person's language (§1.27 `languageFor`);
- **proposes** answers into fields in a "What we've got" panel the person can correct; nothing is
  final until they confirm a section (forms' F-5 shape);
- follows up on vague answers, and moves on at "not sure";
- can go wider when they want to talk about how they work: what it hears is proposed as new facts
  (`theirs`, from the client); other processes they mention become an ask to the lead;
- offers the short page whenever they want it;
- answers questions from their knowledge base or passes them to the lead; problems become notes for
  the build, or issues if they're about something already running.

Typing and voice typing first; live voice and phone later (ElevenLabs, §1.23, named in
`packages/core/src/compliance`). The plain form under the cards always works, with no model.

### 7.3 Rules both keep

- **Never secrets.** No passwords, bank logins, card numbers, social security numbers or tax ids in
  a question, answer, email or chat (§1.121, §1.101). Pasted ones are redacted before storage.
- **Answers are data** (invariant 9). "Let it pay bills without asking" is recorded as a wish;
  approvals stay on (invariant 8) and only the operator loosens them, later.
- **No internals and none of our notes** (invariant 11).
- **HIPAA mode**: voice is refused where the client's mode refuses its vendors (§1.35).

## 8. Connecting their tools

"Give us all their accounts" means **they connect them**; we never receive a password.

- Each card shows **Connect QuickBooks** (the Connections page's own flow; the tool offered then,
  §1.14). We know from the file which tools they use, so the right buttons are there from the start.
- The sign-in account check catches the wrong account or company, in plain words.
- Sites with no API: the client admin enters a dedicated agent account's login into the vault
  (§1.26). Never a person's own login, never in chat, never a blocked-tier site.
- A tool they can't connect now becomes an open item with who has it.
- **Look before asking**: after the first sync, a deterministic profile (counts, top vendors,
  monthly volume; no model) shows under "What we see in QuickBooks" and is filed as `seen` facts.

## 9. After the intake

**A general or area intake** ends with Reggie's read for the operator: the agents it would propose,
with why, from the answers and the file. The operator picks, and **Add to the intake** adds their
cards and sends "A few more questions". No new invite, no new sign-in.

**An agents intake** ends in a **short scope**: per agent, what it will do, what it reads, what it
may change (with approval to start), who approves, and what we'll still ask as we build. The client
admin reads it ("Your scope is ready"), corrects it, and signs it. A change later is a new version
signed again. Signing:

- moves confirmed `theirs` facts into the client's **knowledge base** (§1.21), with the file as
  their source, and marks them `confirmed` in the file;
- opens one §1.108 **build** per agent at fit-gap, its brief filled from the scope and the file (the
  operator confirms it: the intake gate), the template's intake form filled from the answers;
- turns every "not sure" and "ask later" into a `build_item` with who has it; the client's come
  back to them a few at a time on Getting started or as Desk requests; Reggie chases;
- sends "What happens next".

The agents stay in `bench` until their builds reach client test; trial and sign-off are §1.36's.
Getting started stays their home until the first agent is live.

## 10. How it ties into Sales and Build

| cases-plan | Onboarding |
|---|---|
| **Clients** page | The client file is a tab of it, and the prospect's page before there's a client: the lead record. |
| Sales, new account: **Lead → Diagnostic** | The file fills from every conversation; Reggie suggests what to cover. **Invite** is on the lead record at any stage from Qualified. |
| Sales, new account: **Set up the account** | Done by sending the invite: the account, the people, the agents chosen. For a general intake it comes earlier than the cases plan placed it. |
| Build, agent build: **Requirements request** | For a new client, replaced by the intake: one for every agent and area. Later questions are the build's own. |
| Sales, **Expansion** | The same Invite on an existing client, with the new agent's or area's cards. |
| **Your call** | "File 12 facts from today's call"; "Acme hasn't opened the invite in 2 days: reminder drafted"; "Acme's general intake is done: 2 agents proposed"; "Scope signed: 2 builds to start". |
| **Questions** and **Issues** | What they ask or report during onboarding lands there. |
| **Autopilot** | Filing facts from our notes, drafting the invite, reminders and the agents to propose start at `draft`. Sending an invite (it makes a client and adds people), pricing and signing stay a person's. |

The file and the Invite flow come first and work without the Sales screens: the prospect's page is
the lead record until deals exist.

## 11. Data (to confirm when built)

| What | Where | Why |
|---|---|---|
| `client_file`: the company (name, website, the client it became), status (`prospect`, `invited`, `client`, `lost`) | Operator only (RLS on `app_is_operator()`; tied to a client only for operators serving it) | The lead record; holds our notes. |
| `client_fact`: file, section, text, source kind and reference, sureness (`heard`, `seen`, `confirmed`), audience (`theirs`, `ours`), replaces, who, when | Operator only, insert only | What we know and how (invariant 10). |
| File documents before the invite | Operator storage under the file; moved to the client's documents when the account is made | A prospect has no client storage. |
| `intake`: what it covers (`general`, areas, agents), the guide (sections, fields, each field's state: known, to confirm, to ask, ask later), the people and their sections, the start (`point` or `talk`), the lead's note, status (`sent`, `open`, `scope_ready`, `signed`, `done`) | Tenant table, forced RLS | The client-facing part. Holds only `theirs` facts, copied in at sending. |
| `intake_answer`: field, value, source (`form`, `chat`, `voice`, `call`, `tool`), who gave or confirmed it | Tenant table, forced RLS, insert only | Each answer; the latest counts. Filed back as facts. |
| `intake_scope`: version, the text per agent, who signed, when | Tenant table, forced RLS, insert only | What we agreed to build. |
| Onboarding emails | The notifications outbox (§1.37) as new kinds, or a log on the intake | Retries, idempotency and `skipped` without Resend, as today. |
| Sloan's conversation | A `thread` with `subject_type = 'intake'` | Threads carry messages, voice and files. |
| An area's intake section | In each pack's manifest (data); core's schema and generic area section | Packs keep their own questions; the platform never imports a pack. |
| A knowledge entry kind `about` | `knowledge_entry` (migration) | Confirmed facts about the business, apart from FAQs and policies. |

Migrations in their own PRs.

## 12. Plan

Each step ends green and goes to staging.

| Step | What | Done when |
|---|---|---|
| K1 | **The client file**: `client_file`, `client_fact` (migration PR); the prospect's page (the lead record) and the file tab on the client page; adding facts by hand; RLS and contract tests (no client route returns a fact; an `ours` fact never leaves the operator side). | The owner keeps a prospect's and a client's file on staging; a client session can't read either. |
| K2 | **Reggie files facts**: from a debrief or transcript, a document, a website, as one card; Reggie reads the file in every conversation about the company. | A pasted call debrief becomes facts the owner ticks; Reggie's next answer about that company uses them. |
| E1 | **Branded email and welcome page**: the email layout in core with the logo, the invite email in six languages, `/start/<token>` and its sign-in, the WorkOS one-email check. Owner steps: `mezonas.com` and `hello@` in Resend; WorkOS branding and domain. | A test invite to a real inbox shows one branded email, the welcome page and a branded sign-in, in light and dark mail clients. |
| I1 | `intake`, `intake_answer`, `intake_scope` (migration PR); the guide from general, areas (pack manifests and core's generic section) and agents (templates' intake forms), merged and filled from the file (core). | A guide for general, Purchasing and one agent asks "who approves" once and skips what the file has confirmed. |
| I2 | **Invite** on the lead record (who, what it covers, the questions, the email, send) and **Get to the point** (cards, "We think", Connect, "Different process in mind?", "Ask someone else"); the colleague email. | From a prospect's page on staging, the owner invites a test admin, who answers the cards and connects the QuickBooks sandbox in about fifteen minutes. |
| I3 | **Talk it through**: Sloan's intake workflow (platform template v3), proposals into fields, going wider into new facts, switching both ways. Recorded fixtures; a nudge in an answer changes nothing. | A test client finishes the same intake by chat and voice typing; every field shows its source and their confirmation. |
| I4 | **After the intake**: Reggie's proposed agents and Add to the intake; the scope and signing; facts into the knowledge base; builds opened with briefs and open items; the tool profile; reminders and the remaining emails. | A general intake on staging leads to proposed agents, a few more questions, a signed scope and open builds, with nothing asked twice. |
| I5 | **Live voice and phone** (ElevenLabs, §1.23), with the compliance entry. | A spoken intake fills the same fields as a typed one. |

Order: K1 and K2 first (they pay off with today's clients), then E1 (it also improves every
notification email), then I1 to I4, then I5. The Invite button moves onto the deal page when
cases-plan's S2 lands; nothing else waits for Sales.

Size, roughly: K1 a few days, K2 about a week; E1 a few days of code plus the owner's setup; I1 a
few days; I2 one to two weeks; I3 one to two weeks; I4 about a week; I5 one to two weeks.

## 13. Open for the owner

1. **Who sends the invite email**: from the lead by name (`Jammil at Mezonas <hello@mezonas.com>`,
   replies to you), as designed, or from Mezonas?
2. **Inviting before a proposal**: is a general intake (which makes the account) fine for a
   qualified lead, as designed? The first draft's no-sign-in discovery questionnaire was dropped
   for it; bring it back for very early leads?
3. **Areas without a pack yet** (Sales, Receivables): offer them with generic questions, as
   designed, or only areas we have packs for?
4. **The default start** when the operator doesn't choose: get to the point (the design) or Sloan?
5. **Our notes**: operator only, never shown to the client or their agents, as designed? Anything an
   agent should know becomes a `theirs` fact the client confirms, or a rule set on the agent.
6. **A lost prospect's file**: how long do we keep it? (The design: 12 months after the deal is
   lost, then deleted.) And a lost lead we'd invited: retire its account at Lost (the design)?
7. **The scope signature** before we build (the design), or is the proposal enough?
8. **Calls with you**: recorded and transcribed into the file, or your own debriefs to start? (The
   design: debriefs first.)
9. **Reminders**: drafted for you to send (the design), or sent by Reggie and told to you?
