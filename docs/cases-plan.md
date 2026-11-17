# Cases and deals: design and plan (draft, 2026-11-16)

The owner wants a place in the back office to close deals and then work clients' tickets: one
way in for every conversation with a prospect or a client, kept on track, with agents doing
most of the work. Nothing here is built yet. This is outside ARCHITECTURE v0.19's v1 scope, so
once agreed it is recorded as the owner's decision in `docs/plan.md` §1, as Reggie (§1.101) and
builds (§1.108) were.

**Newer thinking supersedes sections 2–8 below.** The workflows the owner agreed on 2026-11-16
are `docs/design/workflows.html`: three buckets (bring them in, sell them more, build what they
need), five flows, and one to-do list across the back office built on activity, to-dos and
cards. The screens are the clickable prototype `docs/design/pipelines.html` (serve the repo
root over http and open both). This page is rewritten from them once the screens are agreed.

## 1. What exists today, and what's missing

Most of the ticket side already exists, in separate pieces with no shared state:

| Today | What it does | What's missing |
|---|---|---|
| Portal requests (§1.11) | A client raises a change; it lands in `/ops/requests`; resolved once with a link to versions. | Replies back and forth ("Not built" in §1.11), owner, priority, waiting on whom. |
| The lead thread (§1.38) | One conversation per client with its Mezonas lead; messages for the client or internal notes (`audience`). | It is one long stream: nothing tracks an issue inside it from raised to done. |
| Lead requests (§1.101) | The lead asks the client admin something on their Desk. | Not tied to the issue it is for. |
| Feedback and error reports (§1.10) | Pinned screenshots and failure context, resolved with a note. | The client never hears back; no link to the fix. |
| Sloan's `pass_to_lead` (§1.47) | Sloan hands a client's ask to the lead as a request. | Same as requests. |
| Builds (§1.108) | A new agent or skill from intake to go-live. | Nothing links a build to the ask or the deal that started it. |
| Reggie (§1.101) | The operator's agent: reads across clients, proposes changes as cards. | No case or deal tools. |

Nothing covers the deal side: a prospect lives in the owner's inbox (the site's "Get started" is
a `mailto:`) until they are a client.

## 2. The shape: two objects, one inbox

- **A deal** is a prospect, from first contact to a signed client: stage, value, the people,
  every email, call and note, the next step and its date. Winning it creates the client (Reggie's
  `client_create`) and opens the first builds from what was learned.
- **A case** is one thing a client needs from us, from raised to resolved: a question, a problem,
  a change, an idea. It has a conversation with the client, internal notes, an owner, a priority,
  who it is waiting on, and links to what fixed it (a run, an agent version, a build, a feedback
  item).
- **One inbox** in the back office takes everything coming in (email, portal, Sloan, Feedback,
  error reports, the site's form) and lands it on the right deal or case, or on a short "Sort
  this" list when it can't tell.

Agents do the first pass on each. People decide and send (approval on by default, invariant 8's
spirit for our own words to clients).

## 3. Cases

### 3.1 Data

A case belongs to its client, so it is a **tenant table** with forced RLS (invariant 1): the
client sees its own cases in the portal, and no other client's ever.

`client_case` (named so to avoid the SQL keyword):

| Column | |
|---|---|
| `tenant_id`, `id`, `number` | `number` per client, shown as `#42`. |
| `title`, `kind` | `question`, `problem`, `change`, `idea`, `setup`, `billing`. |
| `status` | `new`, `open`, `waiting_on_client`, `resolved`, `closed`. `waiting_on_us` is `new` or `open`. |
| `priority` | `low`, `normal`, `high`, `urgent`. |
| `owner_id` | An operator who serves the client; null: the client's lead. |
| `raised_by`, `source` | A client member or contact; `portal`, `sloan`, `email`, `feedback`, `error_report`, `operator`, `agent`. |
| `agent_id` | The service it is about, if any (the portal's service list, as requests). |
| `thread_id` | Its conversation: a `thread` with `subject_type = 'case'` (no change to `thread`). |
| `due_at`, `first_reply_at`, `resolved_at` | For "waiting on us longer than a day". |
| `links` | Run, agent version, build, feedback and inbox ids, checked to be this client's. |

`client_case_event`, append-only: status, owner, priority and link changes, who and when.

Messages reuse threads as they are: `audience: 'client'` is the conversation, `audience:
'operator'` is an internal note the portal never returns (threads already enforce this, §1.38).

### 3.2 What happens to today's pieces

- **Requests become cases.** A new portal request creates a case (`kind: change` or `idea`);
  existing open `change_request` items are copied into cases once. The client's Requests page
  becomes the list of its cases, with the conversation, so "replies back and forth" is built.
  The resolve-with-links rule (§1.11) stays: a `change` case resolves with versions or a note.
- **Sloan's `pass_to_lead`** creates a case instead of a request, with Sloan's thread as a source.
- **Feedback and error reports from a portal** get "Open a case" (or "Add to case #42"); the
  client is told on the case, not on the feedback item. Back-office feedback stays as it is.
- **Lead requests** gain an optional case: the Desk answer is posted to the case.
- **The lead thread** stays for the general relationship; "Make this a case" on a message moves
  the ask into a case and links back.

### 3.3 Back office

- `/ops/cases`: one queue across the clients the operator serves. Views: Mine, Waiting on us
  (oldest first), Waiting on the client, Urgent, by client, resolved. Signal (gold) with a word
  for waiting on you; the row shows the client, title, owner, age and the agent's one-line read.
- The case page: the conversation and internal notes in one stream (notes marked), the agent's
  draft reply ready to edit and send, the facts (status, owner, priority, service), the links,
  and the history. Actions: reply, note, set waiting, resolve, open a build, "Revise with the
  Builder" (as requests have), ask the client admin on their Desk.
- The client page gets a Cases tab; Home's "Needs us" counts cases waiting on us.

### 3.4 Portal

- Requests becomes the client's cases: open and resolved, each with its conversation. A client
  member sees the cases they raised, the client admin sees all (as requests today).
- Replies notify the client by email with a link (no case text in the email body beyond the
  title, so the portal stays the record); later the phone app.
- Never returned: internal notes, owner names other than the lead, the agent's draft, costs,
  bundles (invariant 11; the contract tests' forbidden-field check covers the new routes).

## 4. Deals

### 4.1 Data

A prospect is not a client: it has no tenant, no portal and no directory. So deals are
**operator-only tables**, as builds and Reggie's are (RLS on `app_is_operator()`; a client
session never reads them).

| Table | |
|---|---|
| `deal` | Company name, website, stage, value (`numeric(14,4)` + currency, invariant 6), monthly or one-off, owner, source, next step and its date, expected close, lost reason, `client_id` once won. |
| `deal_person` | Name, email, phone, title, notes; consent to email recorded as `contact` does. |
| `deal_activity` | Append-only: note, email in, email out, call, meeting, stage change, file. Email bodies are stored (we are a party to them), and reach models only as data (invariant 9). |

Stages: `lead`, `talking`, `diagnostic`, `proposal`, `won`, `lost`. The diagnostic is the site's
offer ("Back-office diagnostic").

### 4.2 Back office

- `/ops/deals`: the board by stage, and a list by next-step date ("Overdue" first). The pipeline's
  total and weighted value at the top, in decimal.
- The deal page: the timeline of activity, the people, the next step, emails sent from here.
- **Won**: one card makes the client (Reggie's `client_create`, the admin invited), copies the
  people the owner picks into the client's directory, and opens builds from the diagnostic. The
  deal stays as the record of how it was sold; its notes never reach the client.

## 5. Ways in

| Way in | Lands on |
|---|---|
| Email to `support@` | A case in the client whose member or contact sent it; else "Sort this". |
| Email to `hello@` | An existing deal by sender's address or domain; else a new deal at `lead`. |
| Replies to our emails | The case or deal they answer (a `+tag` in our reply-to address, as forwarding uses). |
| Portal, Sloan, Feedback, error reports | A case (§3.2). |
| The site's "Get started" | A small form posting to a public route that makes a deal at `lead`, rate-limited, replacing the `mailto:`. |
| WhatsApp, texts, calls | Later: the conversations of §10.12 already capture them per client. |

Inbound email uses the Worker's `email()` handler that forwarding uses (§6.5). It needs Email
Routing for the addresses (an owner step, as P1 in `docs/open.md`). Outbound uses Resend (P2).

## 6. Agents doing most of it

One agent for the operator, as Reggie is: **Reggie gets case and deal tools**, and a background
pass reads each new message before a person does.

On each new message on a case or deal (an event, as `thread.message_posted`):

1. **Read and sort**: kind, priority, the service it is about, a one-line summary. Saved on the
   case as the agent's read; a person can change any of it.
2. **Gather**: the runs, errors, Desk items, agent versions and knowledge entries it is about,
   attached as links with their sources (invariant 10).
3. **Draft**: a reply in the client's language, and an internal note of what it found and what
   it would do: answer, ask for something, open a build, revise with the Builder, resolve.
4. **Wait for a person**: the draft shows on the case page. Send, edit then send, or discard.
   Nothing reaches a client or a prospect without a person's send.

For deals the same pass drafts follow-ups, flags deals with no next step or an overdue one, and
summarises a call or meeting from notes.

**Later, only when the owner chooses**: send without a person for named kinds (a "we've got it,
here's the case" acknowledgement first), the way the operator loosens a step today. Measured on
the queue: how many cases were resolved with the agent's draft unchanged.

Limits that carry over: the agent reads a client's data only inside that client (it runs scoped
to the case's client, never across); text from emails and portal messages is data, never
instructions; it never asks for or repeats secrets; every draft records its model and cost (back
office only).

## 7. Plan

Each step ends green and goes to staging. Migrations in their own PRs.

| Step | What | Done when |
|---|---|---|
| C1 | `client_case`, `client_case_event`, RLS, contract tests (migration PR). | A test client's case can't be read from another client or the portal's forbidden fields. |
| C2 | Back-office queue and case page; reply, note, status, owner, links; portal list and conversation; email notice to the client. | The owner and a test client go back and forth on a case on staging. |
| C3 | Fold in requests (new and existing), Sloan's `pass_to_lead`, Feedback's "Open a case", lead requests' case. | `/ops/requests` redirects to the cases queue; nothing is lost. |
| D1 | `deal`, `deal_person`, `deal_activity` (migration PR). | |
| D2 | Deals board, list and page; won → client through Reggie's card. | A deal moves from lead to won and the client exists with its admin invited. |
| W1 | Inbound `support@` and `hello@`, reply threading, "Sort this"; outbound from the case or deal. | An email from a client's person opens a case; a reply lands on it. |
| A1 | The background read, gather and draft on cases; Reggie's case tools. | Each new case shows a read and a draft within a minute; sending is a person's. |
| A2 | The same for deals; stale-deal flags. | |
| W2 | The site's form. | "Get started" makes a deal. |

Order: C1–C3 first (they fix today's one-way requests and give clients a way to talk to us),
then D1–D2, then email (W1, which needs the owner's Email Routing and Resend steps), then the
agents (A1–A2), then the site form.

## 8. Open for the owner

1. **Deals as operator-only tables, or as a Sales pack on the Mezonas client** (as Marketing is,
   `docs/marketing-plan.md`)? The pack would let our own agents work deals with the platform's
   runtime, and later sell the pipeline to clients; it is more work and puts prospects in a
   client's tables. This plan assumes operator-only tables.
2. **The client's word**: keep "Requests" in the portal, or call them "Cases"? This plan keeps
   "Requests" for clients and says "cases" in the back office.
3. **Addresses**: `support@mezonas.com` and `hello@mezonas.com`, or one address for both?
4. **Response targets**: a first reply within one business day for all clients, or per client?
5. **What the agent may send on its own first**, if anything, once drafts are trusted.
