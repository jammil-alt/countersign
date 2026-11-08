# Mezonas — Architecture v0.15

> **Name and design (2026-11-03, owner):** the product is **Mezonas** (mezonas.com; `countersign` is the
> code name), built with the Mezonas design system in `packages/design-system`, which replaces Groundwork.
> Domains: `app.mezonas.com` (production), `staging.mezonas.com`.

> **v0.15 (2026-11-07, owner):** **Data is organised by business area, and purchasing comes
> first.** Agents are many; the data they share belongs to a few business areas (purchasing, sales,
> receivables), each a pack with its own tables and tools, used by every agent given those tools.
> The platform's own tables stay fixed and the client's tools stay the system of record. The
> **Purchasing area** joins v1: the Materials pack (a master list of what the company buys, each
> vendor's names for it, cross-vendor matching, prices and alerts, Pia and her reports) is ported
> from its M8 branches onto the platform as it is now. The **Sales area** (CRM-fed), **area grants**
> and **client extras** are written down as designed for, not built. Changed: §1, §12 (12.0 new),
> §18 (M34), §20; CLAUDE.md (Materials no longer built separately); `docs/plan.md` §1.63, M34, §8.

> **v0.14 (2026-11-06, owner):** **WhatsApp conversations are kept, and their attachments filed
> where the client turns it on.** Parity with Respaldo's capture of documents sent by WhatsApp, by
> pattern only (no code, key or Meta app is shared). Messages that reach a client's WhatsApp number
> are archived as today; nobody replies to them on this path. Each chat is a **conversation**
> (direct now through Twilio; groups later through Meta) with its own **capture** setting: keep the
> messages, and download attachments (off, documents, or all), with a size limit and an optional
> agent to start on new documents. Attachments are off by default. A downloaded file becomes one
> document through the documents capability, so reading and linking apply as for an upload; with
> downloads off we keep only that an attachment existed. The client admin and the operator may both
> change the setting, and every change is logged. Changed: §5.5 (0031), §6.12 (new), §14, §15, §18
> (M33), §20; `docs/plan.md` §1.55, M33, §8.

> **Message translation (P-7, 2026-11-08, owner):** **A client can keep its work in one working
> language.** Texts, WhatsApp messages, email replies and its team's thread messages that arrive in
> another language get a translation stored beside the untouched original; text a person of the
> client writes to a contact can be translated into that contact's language before it is signed, and
> the signer sees both. It is off until the client turns it on, runs on a cheap model, counts as the
> client's usage under a daily limit, and follows HIPAA mode. Changed: §1, §5.7 (new), §10.13 (new), §18
> (M40), §20; `docs/plan.md` §1.69, M40, §8.

> **Conversations (P-4, 2026-11-07, owner):** **An agent can hold a bounded back-and-forth with a
> person** to settle one thing: clarify a purchase request with whoever sent it, work out with the
> owner where to buy an item, clear up a vendor's quote. A conversation is a step, `comms.converse`
> (§10.12), on reach out's channels (WhatsApp, text, email) and the portal's threads, with a typed
> goal, limits on messages, time and cost, and a hand-over to a person when a limit is hit. Model-written
> messages are allowed inside it, under the same consent, hours, approvals and autonomy as reach out.
> Changed: §1, §10.12 (new), §11.2, §18 (M37); `docs/plan.md` §1.66, M37.

> **v0.13 (2026-11-06, owner):** **The agent oversees its own runs, and each step runs on the model
> it needs.** A workflow stays the operator's fixed plan; the client agent that owns it now watches its
> runs. Clean steps (rules, forks, actions, automations, `tool` skills) run as code with no model.
> Skills come in a third mode, **`task`**: a typed job (input in, output out) on the skill's own
> default model, the same whichever agent runs it, so reading an invoice runs on a fast, cheap model.
> **`agent`** skills depend on the agent: they run on its model with its instructions and memory, for
> analysis and drafting in its voice. A step can override either's model. When a step fails, or a checkpoint step (one whose output feeds a write)
> finishes, the agent reviews it on the model the operator picks for oversight and decides one thing:
> continue, retry, retry with a corrected input, ask a person, or stop. It never changes its plan, its
> approvals or its permissions during a run, and a corrected write is decided again by the gate. A fix
> that should last comes to the operator as a proposal. We keep our own executor rather than a graph
> library such as LangGraph: workflows are versioned data merged by step id and run durably by
> Cloudflare Workflows (§10.11). Changed: §1, §2, §5.6 (new), §9.1, §9.2, §10.1, §10.11 (new), §14,
> §18 (M30–M32), §20; CLAUDE.md invariant 9 (one sentence); `docs/plan.md` §1.53–§1.54, M30–M32,
> §7, §8.

> **v0.12 (2026-11-06, owner's prototype):** **The service as the client lives it, and the back office
> that runs it.** The owner's 21-screen prototype adds, for clients: **Sloan**, the account agent on
> every client (the supervisor's client face, free); a named **Mezonas lead** per client, with a
> thread to talk to and "lead checks" in workflows; **threads** with `/commands`; **the Weekly Table**,
> a Monday digest with the lead's note; **notifications** by email and text (counts and a link, never
> record content); **the Desk** with quick answers, "Not now", editing a drafted change before
> signing, signing part of a batch and a 60-second undo; client **pause, pause all and Run now**;
> **go-live stages** (test bench, trial, client sign-off, live); **permissions per record type**;
> people with categories, tags, notes and per-channel autonomy; a **viewer** who can't sign;
> search and plain-words queries; agent KPIs. For the back office: the **command center**, the
> **agent lab** with a **test bench** and **skill tests**, **automations** (reusable step chains),
> the **Builder as a conversation**, **six trigger kinds**, **run controls** (retry from the failed
> step, cancel, replay as a test, model calls), and the **connectors catalog**. QuickBooks gains
> **accounts receivable** and **create bill**. Gmail stays send-only; "write in your voice" learns
> from **voice samples** the client gives us. The owner redoes the UI from the prototype separately,
> so v0.12 is built **API first**. Changed: §1, §4, §5.5 (new), §6.1, §6.2, §6.4, §6.11 (new), §9.6,
> §9.7, §9.8–§9.10 (new), §10.1, §10.7–§10.10 (new), §11, §11.1–§11.7 (new), §13, §13.1 (new),
> §14, §15, §16, §17, §18 (M13–M29), §19, §20; CLAUDE.md invariants 8 and 11 (one sentence each);
> `docs/plan.md` §1.36–§1.52, M13–M29, §7, §8.

> **v0.11 (2026-11-05, owner):** **A directory per client and a supervisor agent.** Each client has
> one **directory** of the people and organizations its agents work with (employees, contractors,
> customers, vendors, partners), filled by hand, by CSV, from connected tools, or from agents'
> suggestions that the client admin accepts; every agent of that client reads it. A **supervisor** (a
> platform template forked into each client) watches the client's runs, connections, website logins,
> codes and waiting approvals, reads the client's agents' state and can ask them questions without
> writing anything, and reports: to the client admin in plain steps, to the operator with the
> details. It changes nothing itself. Changed: §1, §9.7, §11, §16; `docs/plan.md` §1.27, §1.28.
>
> **v0.10 (2026-11-05, owner):** **Access: a vault per client, grants per agent, a separate code
> service, and browser logins.** Agents may sign in to a client's websites on their own, through a
> **dedicated agent account** whose login the client admin enters into the client's **vault**; the
> operator never sees it and agents never hold it (our code signs in, not the model). Every way into a
> client's tools (OAuth connections, API keys, browser logins) is a vault item encrypted with **that
> client's own key**; every agent reaches only the items bound to it, within **grant** limits set per
> agent. Second factors (codes by text or email, authenticator secrets) live in a **separate code
> service**, its own Worker with its own key and storage, which hands a code once to a login in progress.
> Sites are allowed by the operator with a **risk tier**; banks, payments, email accounts and identity
> providers are never signed in to by an agent. Changed: §1, §3, §6.9 and §6.10 (new), §16, §17, §18
> (M12), §20; CLAUDE.md invariant 8 and a new invariant 13.
>
> **v0.9 (2026-11-04, owner):** **Pia and the millwork shop are built separately**, outside this plan
> (the Materials pack, M8, stays in its own branches and is not merged here). The MVP is the platform
> with its tools: **Gmail moves into the MVP** (start Google's app verification now and measure how long
> it takes), and **QuickBooks Online** ships its reads plus the planned writes (attach a document,
> itemize lines with the total unchanged, update memo, update purchase cost), each behind approval.
> **Approver rules** decide who approves each change (`docs/plan.md` §1.17), and **billing** comes into
> v1: a monthly price per agent with included credits, then usage beyond them, worked out by Mezonas
> and invoiced through Stripe (§1.32 of the plan). **Languages:** the portal and agents' client-facing text in six languages (§1); translating
> messages comes next. **Texts and calls:** Twilio (SMS, voice, numbers, WhatsApp), then WhatsApp via Meta, and ElevenLabs connectors
> (§1). Changed: §1 (MVP and v1 scope), §6.2,
> §9.5, §20.
>
> **v0.8 (2026-11-03, owner):** **approvals are on by default and set step by step.** Every step that
> changes a client's tool waits for a person unless that step is explicitly set to run without approval,
> which is only possible where the client's connection allows it. A **MVP** is defined (§1): Pia live
> for the millwork shop on its own QuickBooks; everything else follows. Slack stays out until later.
> Changed: §1, §6.1, §6.2, §6.5 (new), §9.1, §9.5, §9.6, §10.1, §10.2, §10.5, §16, §18, §20.
>
> **v0.7 (2026-11-03, owner's v1 screens, `docs/design/`):** workflows are **structured step lists**
> (numbered steps, drag to reorder, forks with ordered paths that join again), not free-form graphs, and
> the builder is a sortable list rather than a node canvas. Each connection has a **permission matrix**
> per client (read / create / update / delete: auto, approval or off, plus scope); writes are automatic
> only where it says so. **Connections live in the client portal:** the operator builds connectors and
> chooses which ones a client is offered; the client signs in to each of its own tools there. Changed:
> §1, §2, §4, §5.1, §6.1, §9.1, §9.3, §9.4, §9.5, §10, §12.2, §14, §15, §16, §18–20.
>
> **v0.6 (2026-11-03, owner):** **templates and client agents.** Agents are effectively built per client.
> What the operator reuses is a **template**; putting it into a client **forks** it into that client's own
> agent, which is then customized (different data, different flows) and has its own version history. A
> client agent remembers the template version it is based on, so template improvements reach each client
> as a reviewable **update** (a three-way merge), and a client's improvement can be **promoted** back into
> the template. One version = the whole agent (definition + workflows + settings). Replaces v0.5's
> deployments. Changed: §1, §4, §5.3, §9.1, §9.3, §9.5–9.7, §10.1, §10.3–10.5, §12.1, §12.2, §13–15,
> §18–20.
>
> **v0.5 (2026-11-03, owner):** a **managed-agents service suite**, not each client's own agent layer.
> The operator (the owner and their team) builds a **catalogue** of agents, skills and workflows once, in
> a **back office** that reaches into every client, and **deploys** them to clients with per-client
> settings and connections. Clients get a **portal** with self-service around reports, runs, approvals,
> connections and requests; they never edit agents. "Advisor" becomes **operator**. Changed: §1, §3, §4,
> §5.3, §9.2, §9.3, §9.5, §9.6, §9.7, §10.1, §10.3–10.5, §11, §12.1, §12.2, §13–16, §18–20.
>
> **v0.4 (2026-11-03, owner):** a **managed service**, not self-serve. Advisors (our team) build, review and
> publish every agent, skill and workflow; clients connect their tools, approve what agents want to do,
> answer requests, see their agents' work read-only, and ask for changes. Connectors for v1:
> **QuickBooks Online and Gmail**, plus upload. Changed: §1, §4, §6.4 (new), §7, §9.2, §9.6, §10.5, §11,
> §12.2, §14, §15, §16, §17, §18, §20.
>
> **v0.3 (2026-11-03, owner):** the product is the **agent platform**. A business connects its tools in
> one place; people create agents from scratch, give them skills, and lay out their work as a
> drag-and-drop workflow; agents run that work, ask people when they must, and update the connected
> tools. Material cost management is no longer the product: it is the **first agent**, shipped as the
> Materials pack (§12) and built from the same parts any customer uses. The visual workflow editor and
> gated write-back to connected tools move into v1.
>
> **v0.2 (2026-11-03, owner):** the stack matches Plenary Labs: Vite + React + Hono on Cloudflare Workers,
> Cloudflare Workflows, Neon through Hyperdrive, R2, WorkOS.

> **For Claude Code:** this is the source of truth for the v1 build. Read it fully, then follow the
> implementation plan in `docs/plan.md`, which follows the **Build plan** (§18) in order. Where this doc
> says "decision", follow it. Where it says "open", choose the simplest option and leave a `// DECISION:`
> comment. Do not add features outside §1's v1 scope.

Product design (screens, use case narrative) lives in the companion design doc, built on the Groundwork
design system. This file covers how to build it.

---

## 1. What we are building

A **managed-agents service suite for back-office work.** The operator (the owner and their team) runs
agents for many client businesses from one back office. Agents are built **per client**, but not from
scratch each time: the operator keeps **templates** of proven agents and puts them into a client by
**forking** one into that client's own agent, then customizing it for the client's data and flows.
Clients connect their systems, approve what agents want to do, and see the work in a portal.

Two surfaces, one platform:

- **The back office** (operator): every client in one place. Build and version templates and skills;
  fork templates into clients and customize each client's agents in the drag-and-drop workflow builder; test them
  against the client's own data; publish, pause and roll back per client; see which clients run which
  template version and how far each has been customized; offer template updates to clients and merge
  them; promote a good client change back into its template; watch runs and failures across clients; work
  clients' requests; see usage and model cost per client and per agent.
- **The client portal** (each client): self-service around the service they receive: what their agents
  did (reports and outcomes), runs as a plain-language timeline, the inbox (approve writes, answer
  requests, review matches), connections (connect or reconnect QuickBooks and Gmail), requests to the
  operator, and their users. No agent building, no prompts, no workflow builder, no model costs.

How the parts fit:

1. **Connections.** The operator builds the connectors (QuickBooks Online and Gmail, plus upload) and
   chooses which ones each client is offered; the client signs in to each of its own tools from the
   portal's Connections page. A connection brings data in and exposes **tools**: actions agents can take
   against that system, reads and writes, within the permissions set for it.
2. **Skills.** Reusable capabilities ("extract an invoice", "find the receipt for a transaction", "match
   line items to the catalog", "write a weekly summary"): instructions plus the tools they need, typed
   input and output, settings. Built in (platform and packs) or written by the operator; shared by every
   agent, or written for one client.
3. **Templates.** A reusable agent: identity, instructions, skills and settings, permissions, budgets, and
   its workflows (step lists in the builder). Created from scratch or by the Builder. Versioned as a whole.
4. **Client agents.** Forking a template into a client creates that client's agent at the template's
   current version. The operator customizes it (settings, instructions, skills, workflows, steps) for
   that client, binds the client's connections, test-runs it on the client's data, publishes and
   activates it. Every change is a new version of **that client's** agent. Client agents can also be
   built from scratch for one client.
5. **Lineage and updates.** Each client-agent version records the template version it is based on. When
   the template moves on, the back office shows which clients are behind and what the update changes;
   applying it is a three-way merge (template base → new template, against the client's customizations),
   reviewed, test-run and published per client. A client change worth keeping for everyone can be
   promoted into a new template draft. A client agent can be detached from its template.
6. **Runs.** Agents do the work and update the client's tools; every run is logged step by step with cost
   (operator-only); every write to a client's system follows that connection's permissions: automatic,
   approved by a person, or off.
7. **Requests.** A client asks for a change or a new service from the portal; it lands in the operator's
   queue.

### Concepts

| Concept | What it is | Defined in |
|---|---|---|
| Operator | The owner and their team; one back office across all clients | §4 |
| Client | A business served by the operator (a tenant); its data is isolated | §4 |
| Connection | One client's link to an external system (credentials, sync state) | §6 |
| Tool | One atomic action with typed input/output and a side-effect level (`none`, `internal`, `external`) | §6.1, §9.4 |
| Skill | A reusable capability: instructions + tools + input/output schema + settings | §9.2 |
| Agent bundle | One agent version: definition + workflows + settings, versioned as a whole | §9.1 |
| Template | An operator agent kept for reuse; not run for clients directly | §9.3 |
| Client agent | A client's own agent, usually forked from a template, customized and versioned per client | §9.3 |
| Workflow | A structured list of steps (with forks) inside an agent bundle, edited in the builder | §10 |
| Run | One execution of a client agent's workflow, with every step, tool call and cost | §10.3 |
| Inbox | Where people approve, review and answer what agents ask | §11 |
| Request | A client's ask to the operator (change or new service) | §11 |
| Pack | A bundle of domain tools, skills, tables, reports and templates (e.g. Materials) | §12 |
| Stage | Where a client agent is on its way live: test bench, trial, client sign-off, live (v0.12) | §10.9 |
| Desk | The client's inbox: signs, questions, messages, what's in progress and done (v0.12) | §11.1 |
| Thread | A conversation: with the lead, with Sloan, about an agent or a run; carries `/commands` (v0.12) | §11.2 |
| Lead | The operator user each client sees by name as "your Mezonas lead" (v0.12) | §11.2 |
| Sloan | The account agent on every client: the supervisor's client face (v0.12) | §9.8 |
| Automation | A reusable, versioned chain of steps used as one workflow step (v0.12) | §10.7 |
| Test case | A saved example with its expected answer, for a skill or a template (v0.12) | §9.10 |
| Weekly Table | The Monday digest per client: stats, the lead's note, decisions, next week (v0.12) | §11.4 |

### First client and first agent

First client: a ~$2M millwork shop. First template: **Pia, the Materials agent** (Materials pack, §12).
She pulls purchases, finds the supporting invoice, extracts line items, matches each line to a shared
item catalog (e.g. "BB PLY 3/4 4X8" from vendor A and "Baltic Birch 18mm 48x96" from vendor B are the
same item), records unit prices, and alerts when prices change. Pia is a template built entirely from
platform parts; the millwork shop gets its own fork of her, customized to its vendors, categories and
approvals. **Nothing in the platform core is material-specific;** a check enforces that platform packages
never import a pack (§3).

### First use case (built after the platform foundation)

The platform is the product; this is the first thing it will be used for (`docs/plan.md` §3 sets the
build order: foundation, cloud, then surfaces, tools and agents). **Goal:** Pia running for the millwork shop on its own QuickBooks. A new bill or purchase arrives; Pia
finds the invoice (attached in QuickBooks, uploaded, or forwarded by email), reads it, matches the lines
to the shop's item catalog, records prices and raises alerts, and proposes the QuickBooks update
(itemized lines and the invoice attached). The shop approves it in the portal and QuickBooks is updated.
The shop sees the run and Price watch in the portal; the operator runs it all from the back office and
can change Pia's workflow, publish a new version and roll it back.

In the MVP:
- Sign-in (WorkOS), one operator, clients (the millwork shop and the sandbox), back office and portal
  shells, inbox and approvals, the portal's Connections page
- Connectors: **QuickBooks Online** (sync, read tools, and the writes in v0.9: attach, itemize lines,
  update memo, update purchase cost), **Gmail** (moved into the MVP in v0.9), and **upload, with email
  forwarding** (§6.5); documents capability
- Templates and client agents: create, fork, edit, versions, publish, rollback, bindings, activation
  (lineage is recorded from the start so updates can come later without a migration)
- Workflow engine and the step-list builder with forks, person steps and **per-step approvals**; test
  runs; back-office run view and portal run timeline
- Approver rules and Stripe billing (v0.9). Pia and the Materials pack are built separately (v0.9).

After the MVP, in this order unless the owner reorders: template updates and promotion (three-way merge
and merge view); Gmail connector; the Builder (drafting agents and skills from a description);
operator-written skills; requests from clients; usage and cost views beyond per-run cost; notification
emails and CSV export; threads and `/skill` commands; agents asking other agents. Later still: Slack,
Google Drive and the other connectors in the design, and the header command bar.

### v1 scope (the full target)

In:
- Tenancy for many clients, one operator; roles `operator`, `client_admin`, `client_user`; operator-led
  onboarding (create client, invite users, offer connectors); a **sandbox client** with fixture data
  for building and demos
- Connector framework (manifest: auth, synced entities, tools). Connectors: **QuickBooks Online**
  (sandbox + production; read sync plus write tools), **Gmail** (find invoices and receipts in a
  mailbox; drafts and labels as write tools), and **upload with email forwarding** (PDF/image
  documents, CSV, forwarded emails). Added by the owner, 2026-11-04: **webhooks** (in and out; works
  with Zapier, Make and n8n; a published Zapier app later) and **Zoho CRM** (OAuth; read and write
  tools; sync later) (§6.6, §6.7); and **Podio** (OAuth; workspaces, apps, items, comments, tasks) (§6.8)
- Documents capability: store originals, extract with Claude, validate, link to records
- **Skills** (operator): built-in plus operator-written (no code), shared or for one client; versioned
- **Templates** (operator): from scratch or the Builder; workflows in the **drag-and-drop builder**;
  immutable versions, release notes, publish, rollback
- **Client agents** (operator): fork from a template or build from scratch; customize in the same editor
  and builder; bind connections; test-run on the client's data; publish, activate, pause, roll back;
  **diff against the template**; **template updates** by three-way merge with conflict resolution;
  **promote** a client change into a template draft; detach
- Workflow engine executing client agents' workflows; triggers by event, schedule, manual and command
- **Write-back:** external tools act on client systems with **approval on by default, set per step**,
  within each connection's permission matrix, with an audit record and the before state for every write
- **Back office:** clients overview and health, client detail, template lineage ("used by", versions
  behind, customizations), runs and failures across clients, request queue, operator inbox, usage and
  model cost per client and agent
- **Client portal:** overview of their services and outcomes, reports (pack reports + activity, CSV
  export), run timeline, inbox, connections, requests, users and notification settings
- **Approver rules** (v0.9): per client, set by the operator, tightened by the client admin; they name
  who approves each change (`docs/plan.md` §1.17)
- **Billing** (v0.9; reworked 2026-11-05, `docs/plan.md` §1.32): Mezonas works out each client's bill.
  Each agent has a monthly price that includes credits: the client agent's own price, else its
  template's, else the default. Prices are prorated by the days the agent was active, the credits
  are pooled, and extra credits are billed at a credit price, all from `usage_daily`. A monthly
  statement is kept per client. Stripe only holds the customer and the invoice: it sends the
  invoice, takes payment and tells us the outcome
- **The Purchasing area** (v0.15, §12.0): the Materials pack, ported from its M8 branches: the master
  list of what the company buys (`catalog_item`), each vendor's names for it (`item_alias`), every
  invoice line matched to it (`item_match`, deterministic first, model second, person last),
  prices in a standard unit (`price_observation`), alerts, the Pia template, and the Price watch and
  Catalog reports. Enabled per client. Millwork categories as built; embeddings off (§20)
- **Texts and calls** (v0.9): **Twilio** (SMS, voice, phone numbers and WhatsApp first), then
  **WhatsApp through Meta's Cloud API** (the client's own number and account), and **ElevenLabs** (voice
  agents for live calls) as connectors whose tools agents use, drawing on the client's knowledge;
  sending a text or placing a call is an external action behind approval (`docs/plan.md` §1.19)
  - **US texting registration** (A2P 10DLC, P-8): US texts go out only once the client's brand and
    one campaign are registered. The client admin gives the business's details in the portal (the
    EIN write-only, in the client's vault); the operator reviews them, sees Twilio's fees and
    submits; Mezonas registers the secondary customer profile, trust product, brand, Messaging
    Service and campaign by Twilio's API in the client's subaccount, follows their status on the
    cron, and sends through the Messaging Service once the campaign is verified. The campaign is the
    company's own non-marketing texts (team, vendors, customer care); Twilio's fees are the
    client's usage, in credits (`docs/plan.md` §1.70)
- **Reach out** (v0.9): agents know the people they work with and contact them by email, text,
  WhatsApp or call, in their language, under conditions, through channels each agent is given (a
  mailbox of its own, Mezonas' sending service or a person's Gmail; the client's numbers). Sending
  email from Gmail comes into v1, behind approval (`docs/plan.md` §1.25). A reach-out can carry the
  client's PDFs and images (email, MMS, one on WhatsApp), and a reply's PDFs and images become
  documents whose ids the step hands on (`docs/plan.md` §1.65)
- **Languages** (v0.9): the portal and agents' client-facing text in English, Spanish, French,
  Portuguese (Brazil), Italian and German, per client with a per-user choice; the back office stays in
  English. Messages are translated as below (§10.13)
- **Access** (v0.10): a **vault** per client (every connection, API key and browser login, encrypted
  with the client's own key, secrets write-only); **grants** that narrow what each agent may do with
  each connection bound to it; a separate **code service** for second factors; **browser connections**
  that sign in to sites the operator allows, by risk tier, as a dedicated agent account; optional
  **human release** of any vault item with a one-time code to a named person (§6.9, §6.10,
  `docs/plan.md` §1.26)
- **Directory** (v0.11): one per client: people (contacts, with title, relationship and organization)
  and organizations (vendors, customers, partners, the client itself); edited by the client admin and
  the operator, imported by CSV or from connected tools, suggested by agents and accepted by the
  client admin; read by every agent of the client through `directory.*` tools (`docs/plan.md` §1.27)
- **Built for HIPAA, SOC 2 and PCI DSS** (owner, 2026-11-05): an append-only audit log of every
  request, sign-in and refusal, with an access review; 30-minute idle and 12-hour session limits;
  security headers; a per-client **HIPAA mode** that sends the client's data only to vendors with a
  signed BAA; card numbers never stored; retiring a client and purging its data. Certification,
  BAAs and policies come later (`docs/plan.md` §1.35)
- **Supervisor** (v0.11): a platform template forked into each client that watches runs, connections,
  logins, codes and waiting approvals, reads its fellow agents' state and asks them questions without
  writing, and reports to the client admin (plain steps) and the operator (details); it changes
  nothing itself (`docs/plan.md` §1.28)

Added in v0.12 (owner's prototype, 2026-11-06; `docs/plan.md` §1.36–§1.52, milestones M13–M29). Built
**API first**: routes, data and tests; the owner redoes the screens from the prototype, so new UI is
only what a test or an existing screen needs.
- **Go-live stages** per client agent: test bench, trial on client data (every write signed, about 14
  days or 25 runs, whichever is later), client sign-off, live; the operator may skip a stage with a
  logged reason (§10.9). **Client controls:** the client admin pauses and resumes an agent or all of
  them with a reason, and starts a workflow the operator opened to it with **Run now** and a short form
- **Notifications** by email (Mezonas' own sending, through the `resend` code path) and by text where
  the person allows it: items waiting, the Weekly Table, "please reconnect", credits; counts and a link
  only (§11.3). **The Table** (the portal's home) and **the Weekly Table** (a Monday 7:00 digest in the
  client's time zone with the lead's note, decisions and next week; a PDF on request) (§11.4)
- **Threads** with participants' read state, `/commands` and sources on messages; **the lead**, a named
  operator user per client, with a client↔lead thread and **lead checks** (person steps assigned to the
  lead) (§11.2)
- **The Desk** (§11.1): questions with quick answers; "Not now" until a time; editing a drafted change
  before signing (the agent's and the person's versions both kept); signing part of a batch; undo for
  60 seconds after signing, before the write runs; why each item needs a signature. **Sign-off and
  viewers:** a client user may be a viewer who sees everything and signs nothing (§4)
- **Run controls** (§10.10): retry from the failed step reusing what was already signed, cancel, replay
  as a test run, group failures by error, saved views, and every model call of a run (operator only)
- **QuickBooks:** accounts receivable (Invoice, Customer and Payment sync; `qbo.aging_report`;
  `qbo.invoice.add_note`, which only changes the private note) and `qbo.bill.create`, behind approval;
  delete stays off (§6.2)
- **People:** categories (employee, contractor, vendor, customer), tags (e.g. cardholder), "what agents
  should know" notes (data in tool results, never instructions), autonomy per person and channel (on its
  own, your sign, off), import of vendors and customers from QuickBooks; **voice samples** in the
  knowledge base for writing in the client's voice (§6.4, `docs/plan.md` §1.42)
- **Permissions per record type** (§6.1): the matrix gains connector-defined entities (Bills, Items,
  Vendors, Invoices, Customers…) × read, create, update, delete, plus scopes such as "notes only";
  matrices saved before v0.12 apply to every entity. The **connectors catalog** in the back office
  (status, errors in 24 hours, default access for new clients, who is waiting to connect)
- **Automations** (§10.7): reusable, versioned step chains used as one `use_automation` step
- **Test bench and skill tests** (§9.10): saved examples with expected answers per skill and template;
  runs on drafts report pass rate, precision and cost; publishing a skill can require its tests to pass.
  The **agent lab**: template status, versions behind, promote, test bench
- **Sloan** (§9.8): the account agent, the supervisor's client face, on every client, free. It chats,
  sees its client's agents, runs and receipts as the portal shows them, pauses and resumes agents,
  drafts account changes for the client admin to sign, and passes requests to the lead. It never
  loosens a rule and never sees the vault
- **Triggers, six kinds** (§10.8): schedule (with holidays skipped), event, webhook (filters, dedupe key,
  rate limit), manual (with a form, for the operator or the client), message (the agent's email
  address, its text number, a `/command` in a thread, a request Sloan passes) and handoff from another
  agent of the same client, with sources. Who may start one comes from People
- **The command center** (§13.1): escalations by how long a client has been blocked, low-confidence
  readings, client health, model spend today, a live feed. **Search** (⌘K) across agents, runs, records,
  people and documents, and plain-words questions over runs, turned by the model into a typed filter,
  never SQL (§11.6)
- **Agent KPIs and the client view** (§9.9): a template declares a few KPIs computed from runs and step
  outputs, and the panels the client's agent page shows; they travel with every fork
- **Credits:** when a client's credits run out, either keep working and tell the client admin, or
  pause its agents until they decide (§11.5). **Exports:** the client's data export and the
  accountant's export (built tonight outside these milestones), and the client's own audit export
  (§11.7)
- **The Builder as a conversation** (§9.6): multi-turn, each change an undoable entry, `/skill`,
  `/automation` and `/trigger`, "closest template, N% alike", drafting a new skill with tests from
  examples, "Save as automation"
- **New connectors**, in order: Google Drive (file PDFs to a folder), Outlook (send only, like Gmail),
  Ramp, HubSpot; then bank and card feeds through an aggregator once the owner picks the vendor; Slack
  last (§6.11)
- **Platform fixes** found by the API end-to-end test (#102): running an agent live on a past event
  (§10.9), events dispatched right after commit (§8), background document reading counted as the
  client's usage (§13), a portal records list (§14), and "sync now" that always starts or queues a
  sync (§6.2)
- **Run oversight and a model per step** (v0.13, §10.11): `task` skills run on their own default model,
  the same in any agent; `agent` skills run on the agent's model with its instructions and memory; a
  skill step may override the model; the client agent reviews failed steps and checkpoint steps on its
  oversight model and continues, retries, retries with a corrected input, asks a person or stops,
  within limits, never changing its plan, approvals or permissions; a fix that should last is a
  proposal to the operator
- **Conversations** (P-4, §10.12): the `comms.converse` step talks with one person on one channel
  until a typed goal is met and confirmed, within limits; each message is sent like a reach-out's,
  and a limit hands the conversation to a person
- **Message translation** (P-7, owner 2026-11-08, §10.13): a client may set a working language. Texts,
  WhatsApp messages, email replies and its team's thread messages in another language then get a
  translation stored beside the original, which never changes; a person's message to a contact can
  be translated into the contact's language before it is signed, and what is signed is what is sent.
  Off by default, a cheap model, a daily limit per client, the client's usage, HIPAA mode respected.
  Documents, invoices and calls are never translated

Out (designed for, not built):
- Client self-serve building;
  showing workflows or instructions to clients; other operators on the platform (one operator in v1);
  automatic template updates (every update is reviewed per client)
- Reading a client's mailbox through Google (restricted Gmail scopes and CASA): reading stays with
  forwarding, and voice comes from samples the client gives us (owner, 2026-11-06)
- Card on file and automatic charges: billing stays Stripe invoices paid by link (owner, 2026-11-06)
- Signing by replying to a text or email: a notification links to the Desk, and signing needs a
  signed-in session (owner, 2026-11-06)
- Model-written messages from any agent but Sloan, except inside a conversation step (§10.12, bounded
  by its goal, limits, approvals and the person's autonomy);
  live push (the app polls)
- Slack and bank or card feeds until the owner decides (§6.11); Gmail push notifications (v1 polls);
  sending email without a person's approval; code steps in workflows; A/B versions; custom collections
  and fields UI; nesting automations inside automations
- An agent changing its own workflow, approvals or permissions while it runs: oversight decides within
  the plan, and lasting fixes are proposals the operator applies (v0.13, §10.11)
- Other packs (Expenses, Bookkeeping, FP&A); they plug in the same way as Materials; use cases such as
  collections (Cole), invoice intake (Iris) and card receipts (Remy) are built from these parts
  separately (v0.9)
- The **Sales area** (CRM-fed deals, activities, account owners), **area grants** (read and write
  per area and entity, per agent) and **client extras** (`schema_extension`, `custom_record`): designed
  in §12.0, not built (v0.15)

---

## 2. Stack (decisions)

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript everywhere | One language for app, agents, workflows |
| App | React + Vite single-page app, served as static assets by the API Worker | Same shape as Plenary Labs |
| API | Hono on Cloudflare Workers; one Zod route contract shared by API and client | |
| UI | The Mezonas design system (`packages/design-system`: tokens, component CSS, logos, icons, Geist fonts) with Tailwind mapped to its tokens | Plain CSS from the owner; light and dark themes; brand book in its README |
| Workflow builder | A nested sortable list (`@dnd-kit/core` + `@dnd-kit/sortable`) | Structured steps and forks (owner's design); no node canvas |
| DB | Postgres 16 with `pgvector`, `pg_trgm` | Neon, reached from Workers through Hyperdrive; local via Docker |
| ORM / migrations | Drizzle | Platform schema in `packages/db`, pack schemas in their packs, one migration sequence |
| Durable jobs / workflows | Cloudflare Workflows | `step.do` with retries, `step.waitForEvent`, `step.sleep`; Worker cron for schedules |
| LLM | Anthropic API via `@anthropic-ai/sdk`, and OpenAI's Responses API for `openai:` model ids (owner, 2026-11-04), tool use + structured outputs | Models below |
| Object storage | Cloudflare R2 (Worker binding; S3 API for signed URLs) | Original documents, never mutated |
| Auth | WorkOS (AuthKit), sealed session cookie; behind `packages/auth` | Same as Plenary Labs |
| Validation | Zod for every definition, tool input/output, API body | Shared with the builder through `packages/core` |
| Email (optional) | Resend | Behind an interface; SMS later |
| Tests | Vitest (`@cloudflare/vitest-pool-workers` for Worker and Workflow tests); Playwright e2e | |

Models (configurable per agent version, per skill and per skill step, §10.11; defaults):
- `claude-sonnet-5-5` — extraction, agent reasoning, Builder
- `claude-haiku-5-5` — high-volume classification and adjudication (e.g. item matching)
- `claude-opus-5-5` — optional for the Builder on complex requests
- `openai:gpt-5.5` — OpenAI, for any agent or skill the operator sets to it (the `openai:` prefix routes the call)

---

## 3. Repository layout

pnpm monorepo.

```
/apps
  /api                 Hono Worker: /api routes, auth, static assets, Workflow classes, cron;
                       registers connectors and packs
  /web                 React + Vite app: back office (incl. the workflow builder) and client portal, typed API client
  /mfa                 The code service (v0.10, §6.9): a separate Worker with its own key and Durable Object
                       storage; receives second-factor codes by text and email and hands each one once to a
                       login in progress; reached by apps/api only through a service binding; imports core only
/packages              the platform: never imports a pack
  /core                Domain types and Zod schemas (AgentBundle, AgentDefinition, SkillDefinition,
                       Workflow, ToolSpec, ConnectorManifest, PackManifest), workflow validation,
                       bundle diff and three-way merge (shared with the merge view), route contract,
                       units, money
  /db                  Drizzle platform schema, migrations (platform + packs), seed, withTenant()
  /llm                 model client (Anthropic, OpenAI), cost tracking, record/replay
  /auth                Tenant + role helpers, WorkOS and dev adapters
  /senses              Event outbox
  /connectors          Connector framework + qbo/ + upload/; object storage
  /documents           Document store, extraction, validation, linking
  /threads             Threads + messages, command parsing
  /agents              Tool, skill and agent registries; versioning; runtime; Builder
  /workflows           Workflow executor (against a StepRunner interface), trigger router
/packs
  /materials           Materials pack: catalog, matching, pricing and alert rules; its tools,
                       skills, tables, API routes and seeded agent + workflows
/fixtures
  /invoices            Sample millwork invoices (PDF/PNG) + expected extraction JSON
  /qbo                 Sample QBO API payloads
  /matching            Labeled line pairs for the matcher
  /llm                 Recorded model responses
/docs
```

Dependency rules (enforced by `scripts/check-deps.mjs`):
- Platform packages depend downward only: `workflows → agents → (documents, threads) → connectors → db → core`;
  `llm`, `senses` and `auth` sit just above `core`/`db`.
- **Platform packages never import `packs/*`.** A pack may import `core`, `db`, `llm`, `senses`,
  `documents` and `connectors`; never `agents` or `workflows`. A pack contributes tools and skills as
  data and handlers typed by `core`; the runtime finds them through the registries.
- `apps/api` is the only place that wires packages and packs together. `apps/web` imports only `core`.
- Agent reasoning never reaches the database directly; it goes through tools (§9.4).

---

## 4. Tenancy and auth

One operator, many clients. Each client is a tenant; the operator's staff reach into every client they
serve from the back office.

**The client's team runs its agents day to day; the operator oversees and can step into anything, but is
never the default step** (owner, 2026-11-08; `docs/plan.md` §1.68). Approvals, questions, hand-overs and
conversations go to the client's team by default. The operator is the step only where they chose it: a
client whose approvals are set to us (the Sandbox), or a person step assigned to the lead. Oversight stays
ours: failed runs, budget hits, proposals and platform health.

| Role | Who | Can |
|---|---|---|
| `operator` | The owner and their team | Everything in the back office: create clients, invite users, offer connectors and set their permissions and configuration, enable packs; build, test, **publish** and roll back templates, skills and client agents; fork, customize, update, promote, activate and pause client agents; work requests; see runs, usage and cost across their clients; approve on a client's behalf when delegated; step into any open item or live conversation of a client they serve, with a reason (P-6) |
| `client_admin` | The client's owner or manager | Portal: connect and disconnect tools (OAuth); approve external actions and reviews (default approver); answer requests; reports, runs and services; raise requests; invite client users; notification settings |
| `client_user` | Client staff | Portal: inbox items assigned to them, reports, runs; raise requests. A client user with **sign-off off** (`membership.can_sign = false`, v0.12) is a **viewer**: sees the Table, runs, reports and the Weekly Table, signs nothing |

- **Sign-off and viewers (v0.12):** `membership.can_sign` (default true; always true for `client_admin`).
  A viewer is never an approver: approver rules can't name one (422 `not_a_signer`), items routed to
  the role `client_user` skip them, nothing is assigned to them, and resolving answers 403
  `cannot_sign`. Viewers don't start Run now. What a signer may sign is still the approver rules
  (`docs/plan.md` §1.20); "Bills under $2,000" is a rule pair the client admin (or a change Sloan
  drafts) adds. // DECISION: a flag on the membership, not a fourth role, so the route contract and
  every role check stay as they are.
- **The lead (v0.12):** `tenant.settings.lead = {userId}`, an operator who serves the client, set by
  the operator. The portal shows the lead by name (the one operator person a client sees named; others
  stay "Mezonas"). Lead checks are person steps with `assignee: 'lead'` (§10.1), assigned to that user.

- Tables: `tenant(id, name, timezone, settings jsonb, workos_organization_id, created_at)` (a client),
  `app_user`, `membership(tenant_id, user_id, role)`. An operator's memberships list the clients they
  serve (the owner is a member of all); client users belong to exactly one client.
- **RLS:** every tenant table has `tenant_id uuid not null` and a policy
  `tenant_id = any(current_setting('app.tenant_ids', true)::uuid[])`, set per transaction. A client
  request sets one id; an operator request in the back office sets the ids of the clients they serve,
  so cross-client views are still enforced by the database. Queries also filter by tenant.
- Client setting `approvals.external_actions`: `client_admin` (default) or `operator` (delegated);
  overridable per client agent. Every approval records who approved.
- Templates and shared skills (§5.3) belong to the operator: their rows have `tenant_id` null and are
  readable only in operator sessions (`app.operator = on`) through the policy
  `tenant_id = any(app.tenant_ids) or (tenant_id is null and current_setting('app.operator', true) = 'on')`.
  Client agents and client-only skills carry their client's `tenant_id` like any client data, but their
  definitions are still never returned through portal routes (§14).

---

## 5. Data model

All timestamps `timestamptz`, all money `numeric(14,4)` + `currency char(3)`, all ids `uuid` (v7 unless
stated). Three groups: platform, shared business records, pack tables.

### 5.1 Connections and raw data

```
connection(id, tenant_id, connector /*'qbo'|'gmail'|'upload'*/, status, external_account_id
           /*QBO realmId, Gmail address*/, credentials_encrypted jsonb, config jsonb /*e.g. Gmail query*/,
           last_sync_at, sync_cursor jsonb /*QBO CDC time, Gmail historyId*/, connected_by, created_at)

-- connection also has: permissions jsonb  /*{ read, create, update, delete: 'auto'|'approval'|'off', scope }*/
-- tenant.settings.connectors_offered: connector ids the operator offers this client
connection_change(id, tenant_id, connection_id, actor_id, change jsonb, created_at)   -- append-only

raw_record(id, tenant_id, connection_id, connector, entity_type, external_id,
           external_version /*QBO SyncToken*/, payload jsonb, synced_at, is_deleted bool)
  unique(connection_id, entity_type, external_id, external_version)

external_action(id, tenant_id, connection_id, tool, run_id null, step_run_id null, agent_version_id null,
                input jsonb, idempotency_key, status /*proposed|approved|rejected|executing|done|failed*/,
                inbox_item_id null, approved_by null, approved_at, result jsonb, error jsonb,
                before jsonb null, created_at, executed_at)
  unique(tenant_id, idempotency_key)
```
Raw records are append-only; normalized tables are rebuildable from raw. Every write to an external
system is an `external_action` row: proposed by an agent, approved by a person, executed once
(idempotency key), with the result and, where the system allows, the record's state before the change.

### 5.2 Shared business records

Records more than one pack will use. Connectors map into them; packs read them.

```
vendor(id, tenant_id, name, normalized_name, aliases text[], external_refs jsonb, ext jsonb)

transaction(id, tenant_id, kind /*purchase|bill|vendor_credit*/, vendor_id, txn_date, total, currency,
            purchaser_ref text, payment_type, memo, source_raw_record_id, external_id,
            status /*needs_doc|doc_requested|doc_found|extracted|processed*/, ext jsonb)

transaction_line(id, tenant_id, transaction_id, line_no, detail_type /*account|item*/,
                 account_ref, item_ref, description, qty, unit_price, amount)

document(id, tenant_id, transaction_id null, source /*connector|upload|email|request*/, storage_key,
         mime_type, sha256, page_count, status /*stored|extracting|extracted|failed|needs_review*/,
         received_at)

doc_extraction(id, tenant_id, document_id, model, agent_version_id null, header jsonb, subtotal,
               freight, surcharges jsonb, tax, total, lines_sum, totals_match bool, confidence,
               created_at)

doc_line(id, tenant_id, extraction_id, line_no, vendor_sku, raw_description, qty, uom_raw,
         unit_price, ext_price, discount, page, bbox jsonb null)

alert(id, tenant_id, pack null, kind, subject_type, subject_id, severity, title, body,
      evidence jsonb /*record ids*/, dollar_impact, status /*open|accepted|dismissed*/,
      raised_by_run_id, created_at)
```

### 5.3 Platform

```
tenant_pack(tenant_id, pack, version, enabled_at)        -- packs switched on for a client

-- Skills: tenant_id null = shared by every agent; set = written for one client
skill(id, tenant_id null, slug, name, live_version_id null, status, created_at)
skill_version(id, tenant_id null, skill_id, version int, definition jsonb /*SkillDefinition*/,
              definition_hash, status /*draft|live|retired*/, change_note, author_id,
              parent_version_id null, created_at)
  unique(skill_id, version)          -- immutable except status (trigger)

-- Agents: templates (tenant_id null) and client agents (tenant_id set)
agent(id, tenant_id null, kind /*template|client*/, slug, name, role,
      template_id null,              -- client agents: the template they were forked from
      linked bool default true,      -- false = detached: no further template updates
      live_version_id null, status /*active|disabled*/, created_at,
      -- client agents only (operational, not part of the versioned bundle):
      service_name, service_description,                  -- what the client sees in the portal
      bindings jsonb /*connector → connection_id*/,
      approver /*null = client setting | client_admin | operator*/,
      run_status /*draft|testing|active|paused|retired*/)
  unique(tenant_id, slug)            -- templates: unique among templates; client agents: per client

agent_version(id, tenant_id null, agent_id, version int,
              bundle jsonb /*AgentBundle: definition + workflows + settings*/, bundle_hash,
              status /*draft|live|retired*/, change_note, release_note null /*templates*/,
              author_type /*operator|builder|pack|merge|promote*/, author_id,
              parent_version_id null,           -- the version it was edited from (same agent)
              based_on_template_version_id null, -- client versions: the template version they reconcile with
              merged_from_version_ids uuid[] null, -- update merges and promotions: the other inputs
              created_at)
  unique(agent_id, version)          -- immutable except status (trigger)

agent_change(id, tenant_id null, agent_id, actor_id, change jsonb, created_at)
                                     -- append-only log of operational changes (bindings, approver, run_status)

run(id, tenant_id, agent_id, agent_version_id, workflow_slug, config jsonb /*bindings + approver snapshot*/,
    mode /*live|test*/, trigger jsonb, status, started_at, finished_at, cost_usd numeric(10,4), error jsonb)
step_run(id, tenant_id, run_id, node_id, node_type, skill_ref null, agent_version_id null, input jsonb,
         output jsonb, summary text null /*plain-language line for the client timeline*/, status,
         attempts, cost_usd, tokens_in, tokens_out, started_at, finished_at)
tool_call(id, tenant_id, step_run_id, tool, input jsonb, output jsonb, status, duration_ms,
          external_action_id null)

event(id, tenant_id, type, subject_type, subject_id, payload jsonb, created_at, dispatched_at null)

thread(id, tenant_id, subject_type, subject_id, title, status, step_budget int, steps_used int)
message(id, tenant_id, thread_id, sender_type /*agent|user|system*/, sender_id, agent_version_id null,
        kind /*text|command|result*/, command text null, body jsonb, sources jsonb,
        audience /*client|operator*/, created_at)

inbox_item(id, tenant_id, kind /*approval|review|request|extraction_review|external_action|change_request*/,
           pack null, agent_id null, subject_type, subject_id, run_id null, assignee_user_id null,
           assignee_role, title, payload jsonb, status /*open|resolved|expired*/, resolution jsonb, due_at,
           created_at, resolved_at)

memory_note(id, tenant_id, agent_id, scope, note, source_message_id null, created_at)
                                     -- per client agent; never shared across clients or with templates

usage_daily(tenant_id, day, agent_id, runs, steps, documents, external_actions, tokens_in, tokens_out,
            cost_usd)                -- rollup for the back office and future billing

schema_extension(id, tenant_id, target, json_schema jsonb, version, created_at)  -- UI later
custom_record(id, tenant_id, collection, data jsonb, created_at, updated_at)       -- v1 unused
```

Built-in tools and skills live in code (connectors, platform, packs) and are versioned with them;
operator-written skills are rows. Extensibility rule: `vendor`, `transaction` and pack tables that hold
client-facing records get `ext jsonb default '{}'`, validated against the latest `schema_extension`.

### 5.4 Pack tables

Each pack owns its tables (Drizzle schema inside the pack, migrations in the one shared sequence,
same tenancy and RLS rules). Materials: §12.

### 5.5 v0.12 additions (owner's prototype, 2026-11-06)

Every change is additive, so the previous Worker keeps working while a migration applies before its
deploy. Tenant tables have `tenant_id`, forced RLS on `app.tenant_ids` and no DELETE grant unless
stated. Operator tables (no client) use the `browser_site` pattern: forced RLS `app_is_operator()`.
Migration numbers are reserved in `docs/plan.md` §8; Wave 1's (0018–0025) are written together in
one PR (`claude/w1-migrations`) so their Drizzle snapshots chain, and Wave 2's (0026–0029, run
oversight's from §5.6 included) in another (`claude/w2-migrations`). v0.14's 0031 (WhatsApp
capture, §6.12) is its own PR (`claude/whatsapp-capture-migration`).

```
-- 0018 platform fixes (§8, §13, plan §1.43)
doc_extraction + tokens_in int not null default 0, + tokens_out int not null default 0,
               + cost_usd numeric(14,4) not null default 0     /*set at insert; the row stays immutable*/
usage_platform_daily(tenant_id, day, documents, tokens_in, tokens_out, cost_usd)   pk(tenant_id, day)
  -- the client's usage that no agent made (background reading of uploads and forwarded mail);
  -- recomputed by the rollup like usage_daily, counted into credits

-- 0019 go-live stages and client controls (§10.9, §11.5)
agent  + stage text null /*bench|trial|signoff|live; null for templates*/
       + stage_state jsonb not null default '{}'
             /*{trial?: {startedAt, minDays, minRuns, setBy}, signoff?: {inboxItemId, askedAt},
                skipped?: [{stage, reason, by, at}]}*/
       + pause jsonb null /*{side: client|operator|system, by, reason, at, until?, all?: bool}*/
  -- backfill: 'live' for client agents whose run_status is active, paused or retired (test copies
  -- excluded); 'bench' for other client agents

-- 0020 notifications and the Weekly Table (§11.3, §11.4)
notification(id, tenant_id, user_id null, contact_id null, channel /*email|sms*/,
             kind /*items_waiting|weekly_table|reconnect|credits|lead_message|signoff*/,
             dedupe_key text, link text, counts jsonb, status /*queued|sent|failed|skipped*/,
             reason text null, provider_id text null, created_at, sent_at null)
  unique(tenant_id, channel, dedupe_key)       -- status, reason, provider_id and sent_at change
weekly_table(id, tenant_id, week_start date, status /*draft|sent*/, stats jsonb,
             note text null, note_by uuid null, decisions jsonb /*[{id, title, body, options[], sources[],
             reply?: {by, at, messageId}}]*/, next_week text null, setup jsonb, sent_at null,
             created_at, updated_at)
  unique(tenant_id, week_start)

-- 0021 threads and the lead (§11.2)
thread + created_by uuid null references app_user
thread_read(tenant_id, thread_id, user_id, last_read_at)   pk(thread_id, user_id); runtime may update
unique index thread_lead_key on thread(tenant_id) where subject_type = 'lead'
  -- subject types: 'lead' (subject_id = the tenant id), 'account' (a Sloan conversation; created_by =
  -- the person), 'agent' (subject_id = the client agent), 'run', 'contact' (as today)

-- 0022 the Desk, sign-off and viewers (§11.1, §4)
inbox_item + deliver_after timestamptz null  /*approved, inside the undo window; the run is told after*/
           + batch_key text null              /*`<run id>:<step id>`: items one step proposed together*/
           + snoozed_until timestamptz null, + snoozed_by uuid null
external_action + edited_input jsonb null, + edited_by uuid null, + edited_at timestamptz null
                                               /*`input` stays the agent's version*/
membership + can_sign boolean not null default true

-- 0023 run controls (§10.10)
run + retry_of uuid null /*the run this one retries*/, + resume_from text null /*the step id*/
model_call(id, tenant_id, run_id, step_run_id, agent_version_id null, provider, model,
           tokens_in, tokens_out, cost_usd numeric(14,4), duration_ms, stop_reason,
           body_key text /*R2: tenants/<id>/model-calls/<id>.json*/, created_at)   -- insert only
saved_view(id, user_id, surface /*ops_runs|portal_runs*/, name, filters jsonb, created_at,
           updated_at)                         -- operator table; a user's own rows

-- 0024 QuickBooks accounts receivable (§6.2)
receivable(id, tenant_id, connection_id, connector, external_id, doc_number, customer_external_id,
           customer_name, organization_id null, txn_date, due_date null, total, balance, currency,
           status /*open|paid|void|deleted*/, private_note text null, source_raw_record_id,
           ext jsonb, created_at, updated_at)
  unique(connection_id, external_id)

-- 0025 people and voice samples (§6.4, plan §1.42)
contact + autonomy jsonb not null default '{}'   /*{email|sms|whatsapp|voice: auto|approval|off}*/
knowledge_entry kind check + 'voice_sample'
knowledge_entry_version + meta jsonb not null default '{}'   /*voice samples: {personUserId, channel}*/

-- 0026 per-entity permissions and the connectors catalog (§6.1)
connector_setting(connector text pk, status /*live|beta|in_review|building*/,
                  default_permissions jsonb null, note text, updated_by, updated_at)  -- operator table
  -- connection.permissions and agent_grant.limits gain an `entities` key: jsonb, no column change

-- 0027 automations (§10.7)
automation(id, tenant_id null, slug, name, description, live_version_id null, status, created_at)
  unique(tenant_id, slug) nulls not distinct
automation_version(id, tenant_id null, automation_id, version int, definition jsonb /*Automation*/,
                   definition_hash, status /*draft|live|retired*/, change_note, author_id,
                   parent_version_id null, created_at)
  unique(automation_id, version)     -- immutable except status (trigger), like skill_version

-- 0028 test bench (§9.10)
test_case(id, tenant_id null, target_kind /*skill|template*/, target_id, name, input jsonb,
          fixtures jsonb, expected jsonb, matcher jsonb, required bool, source /*manual|builder|run*/,
          source_ref text null, created_by, created_at, archived_at null)
test_suite_run(id, tenant_id null, target_kind, target_id, version_id, status /*running|done|failed*/,
               total, passed, failed, metrics jsonb /*{passRate, precision?, costPerCase}*/, cost_usd,
               started_by, created_at, finished_at null)
test_case_result(id, tenant_id null, suite_run_id, test_case_id, status /*pass|fail|error*/,
                 got jsonb, diff jsonb, cost_usd, run_id null, created_at)          -- insert only
skill + require_tests boolean not null default false

-- 0030 the Builder as a conversation (§9.6)
builder_session(id, tenant_id null, kind /*agent|skill*/, agent_id null, skill_id null,
                base_version_id null, bundle jsonb /*the working draft*/, status /*open|saved|closed*/,
                created_by, created_at, updated_at)
builder_turn(id, tenant_id null, session_id, seq int, role /*operator|builder*/, text,
             command text null, changes jsonb /*[{id, label, before, after}]*/, undone_at null,
             saved_version_id null, cost_usd, created_at,
             bundle jsonb null /*the working draft after the turn*/,
             meta jsonb /*questions, gaps, notes, errors, the parsed command, the model*/)
  unique(session_id, seq)            -- immutable except undone_at (trigger); nothing deleted

-- 0031 (v0.14) WhatsApp passive capture (§6.12, plan §1.55)
conversation(id, tenant_id, connection_id, channel /*whatsapp; sms allowed, not made yet*/,
             kind /*direct|group*/, contact_id null /*direct*/, external_id null /*group: the
             provider's group id*/, title text, capture jsonb not null
             /*{archive: bool, attachments: off|documents|all, maxBytes: int, agentId?: uuid}*/,
             created_at, updated_at)
  unique(connection_id, channel, contact_id) where kind = 'direct'
  unique(connection_id, channel, external_id) where kind = 'group'
  check: direct ⇒ contact_id set and external_id null; group ⇒ external_id set
  -- runtime selects, inserts and updates (capture, title, updated_at); no DELETE
conversation_change(id, tenant_id, conversation_id, actor_id null /*null: the system*/,
                    side /*client|operator|system*/, change jsonb /*{setting: 'capture', before,
                    after, reason?}*/, created_at)
  -- insert and select only, immutable (trigger), like contact_change
document source check + 'message'   /*a file sent in a message; meta names the message*/
  -- the client's default capture is `tenant.settings.messaging.capture` (jsonb, no column)
```

Tables with `tenant_id null` here (`automation`, `test_case`, `test_suite_run`, `test_case_result`,
`builder_*`) follow the templates' policy (§4): null rows only in operator sessions; a client's rows
in its own scope. A test case made from a client's records carries that client's id and never runs
or shows outside it (invariant 1).

### 5.6 v0.13 additions

```sql
-- 0029 run oversight (§10.11)
oversight_decision(id, tenant_id, run_id, step_run_id, node_id, seq int /*1.. per node*/,
                   cause /*failed|checkpoint*/, action /*continue|retry|retry_with|ask|stop*/,
                   input_before jsonb null, input_after jsonb null /*retry_with only*/,
                   note text /*the agent's diagnosis; operator only*/,
                   proposal jsonb null /*{summary, change}*/, inbox_item_id null,
                   sources jsonb /*record ids it relied on*/, model text, cost_usd numeric(14,4),
                   tokens_in int, tokens_out int, agent_version_id, created_at)
```

A tenant table with forced RLS; `cs_runtime` may insert and select, never update or delete (like
`audit_event`). Read by the back office's run view and the agent lab; no portal route returns it.
`step_run` keeps one row per step: a retried step increments `attempts`.

### 5.7 P-7 additions

```sql
-- 0034 message translation (§10.13)
message_translation(id, tenant_id, raw_record_id null, message_id null, reach_out_id null
                      /*exactly one: the original*/, field text /*'text', or a payload path*/,
                    direction /*in|out*/, source_language /*one of the six, or unknown*/,
                    target_language, detected_by /*rule|model|none*/,
                    status /*translated|skipped|capped|refused|failed*/, reason text null,
                    text text null /*the translation; only when translated*/, original_chars int,
                    truncated bool, model text null, tokens_in int, tokens_out int,
                    cost_usd numeric(14,4), agent_version_id null, run_id null, step_run_id null,
                    requested_by null /*app_user, for a person's own text*/, created_at)
contact.translation jsonb default '{}'   -- {incoming?, outgoing?}: the person's switch
usage_platform_daily.translations int default 0
```

A tenant table with forced RLS, composite tenant keys to its original, the agent version, run and
step; `cs_runtime` may insert and select, never update or delete (a trigger, like `doc_extraction`).
One `translated` row per original, field and target language. The portal reads the text and the
languages, never the model or the cost.

---

## 6. Connections and tools

### 6.1 Connector framework

```ts
const ConnectorManifest = z.object({
  id: z.string(),                         // 'qbo'
  name: z.string(), description: z.string(), icon: z.string(),
  auth: z.enum(['oauth2', 'api_key', 'none']),
  entities: z.array(z.string()),          // what sync brings in: ['Purchase', 'Bill', ...]
  tools: z.array(ToolSpec),               // reads and writes this connector offers agents
});

interface Connector {
  manifest: ConnectorManifest;
  authorize?(tenantId): Promise<{ redirectUrl: string }>;
  handleCallback?(params): Promise<Connection>;
  sync?(connection, opts: { since?: Date; full?: boolean }): AsyncIterable<RawRecordInput>;
  fetchAttachments?(connection, entityType, externalId): Promise<AttachmentRef[]>;
  downloadAttachment?(connection, ref): Promise<{ stream: ReadableStream; mime: string; filename: string }>;
  verifyWebhook?(headers, body): boolean;
  tools: Record<string, ToolHandler>;     // handlers for manifest.tools, given the connection
}
```

**Who does what.** The operator builds connectors (code: manifest, sync, tools) and, per client,
chooses which are **offered**, sets each connection's permission matrix and configuration (e.g. the Gmail
query), and watches sync health. The **client** signs in to its own tools in the portal's Connections
page (OAuth with the provider, so the operator never sees or holds the client's passwords), and can
reconnect, disconnect and see what each connection lets agents do. The operator cannot connect a tool
on a client's behalf; a connector that needs reconnecting shows up in both the portal and the back
office. Upload is built in and always on. An operator may send a reminder that opens the portal's
Connections page at the right connector.

**Permissions per connection** (owner's design, Connections screen). Each tool declares a `verb`
(`read`, `create`, `update`, `delete`). Each client connection stores a matrix: for each verb `auto`,
`approval` or `off`, plus a scope the connector understands (e.g. "AP folder only", "bills, purchases,
vendors, items, attachments"). For writes, the matrix is a **ceiling**: `approval` means every write
waits for a person; `auto` means a step **may** be set to run without approval (each step still
defaults to approval, §9.5); `off` means agents can't do it at all. Defaults when a tool is connected:
read `auto`, create and update `approval`, delete `off` (v1 has no delete tools). The operator sets the
matrix; the client admin sees it in the portal and can tighten it, never loosen it; every change is a
`connection_change` row.

**Permissions per record type (v0.12).** A connector manifest declares the record types it touches
(`permissionEntities: [{id: 'bill', label, verbs: [read, create, update], scopes?: [{id: 'notes_only',
label, verb: 'update', tools: ['qbo.invoice.add_note']}]}]`) and each of its tools names one
(`ToolSpec.entity`). The matrix keeps its verb levels and gains `entities: {[entity]: {read?, create?,
update?, delete?, scope?: {[verb]: scopeId}}}`. The level for a call is the stricter of the verb's level
and the entity's (a missing entity entry, or a matrix saved before v0.12, is the verb's level, so old
matrices mean "all entities" with no data migration). A scope narrows a verb on an entity to the
scope's tools; any other tool for that entity and verb is `off`. Grants gain the same `entities` key.
The effective level is the strictest of: the connection's verb, the connection's entity, the grant's
verb, the grant's entity, the step's approval, the agent's mode and stage (§10.9), and, for a message
to a person, that person's autonomy for the channel (`docs/plan.md` §1.42). Delete stays off for every
entity. The client admin tightens per entity; only the operator loosens. A tool without an entity (or
a connector without `permissionEntities`) is governed by the verb alone, as before.

**Connectors catalog (v0.12).** The operator's view of every registered connector: its status
(`live`, `beta`, `in_review`, `building`, in `connector_setting`, set by the operator), clients
connected, tools, errors in the last 24 hours (failed tool calls and connections in `error`), the
**default access for new clients** (a matrix with entities, applied when a client's connection is
first made; else the manifest's, else the platform's defaults), and **waiting to connect** (clients
where it is offered, or an agent needs it, with no connection yet).

Connectors produce raw records, files and tool results. Normalization happens in `packages/core` mappers
per connector (`mapQboPurchase(raw) → TransactionInput`). The Connections screen lists every connector,
its status for the tenant, and the tools it gives agents. Tool ids are `<connector>.<entity>.<verb>`
(`qbo.purchase.query`, `qbo.attachable.upload`).

### 6.2 QuickBooks Online

- OAuth 2.0 authorization code flow, scope `com.intuit.quickbooks.accounting`. Store `realmId`, access +
  refresh tokens encrypted (AES-256-GCM, key from env). Refresh on 401 or before expiry and persist the
  new refresh token every time.
- Environments: sandbox vs production base URL from env. Develop against a sandbox company.
- Entities synced: `Purchase`, `Bill`, `VendorCredit`, `Vendor`, `Item`, `Attachable`. Optionally
  `PurchaseOrder`.
- Initial sync: query each entity with paging (`STARTPOSITION`/`MAXRESULTS`), ordered by
  `MetaData.LastUpdatedTime`.
- Incremental: Change Data Capture (`cdc?entities=...&changedSince=...`) every 15 min, plus webhooks as a
  trigger to run CDC early. Cursor in `connection.sync_cursor`.
- Webhooks: verify the HMAC-SHA256 signature with the app's verifier token; start a `qbo-sync` Workflow
  instance for the realm, never process inline.
- Lines: map `AccountBasedExpenseLineDetail` and `ItemBasedExpenseLineDetail` to `transaction_line.detail_type`.
- Attachables: query attachables referencing the transaction; download via the download endpoint. Store
  bytes in R2, dedupe by sha256.
- **Tools, read** (`none`): `qbo.purchase.query`, `qbo.bill.query`, `qbo.vendor.query`, `qbo.item.query`,
  `qbo.attachable.list`.
- **Tools, write** (`external`; approval per step, §9.5). MVP, as in the design's run screen:
  `qbo.bill.update_lines` / `qbo.purchase.update_lines` (replace an account line with the invoice's item
  lines; the total must stay unchanged or the write is refused) and `qbo.attachable.upload` (attach the
  invoice). Later: `qbo.bill.create` (draft bills from invoices), `qbo.item.update_purchase_cost`, memo
  updates. Each write sends the current `SyncToken`, stores the prior state in `external_action.before`,
  and fails cleanly on a stale token (the record changed since the agent read it).
- Rate limits: central throttle per realm with retry/backoff on 429.
- **"Sync now" is never lost (v0.12 fix).** Sync instances are named by connection and time slot, so a
  "sync now" within a minute of connecting merged into the first sync's slot and started nothing. Now:
  when no sync of the connection is running, "sync now" starts one with a fresh id
  (`<connection>:now:<uuid v7>`); when one is running, it answers 202 `queued` and sets
  `sync_cursor.pending`, and the running instance starts one more when it ends. Cron and webhook
  slots are unchanged.
- Verify endpoint shapes, minor version, and current Intuit API terms against Intuit's developer docs
  before coding.
- **Accounts receivable (v0.12, owner 2026-11-06).** Sync adds `Invoice`, `Customer` and `Payment`
  (initial sync: customers whole, invoices and payments for 365 days; then CDC as for the rest).
  Invoices map to `receivable` (§5.5) with their balance and status; payments stay raw records (the
  evidence) and move their invoices' balance through the invoices' own CDC versions; customers stay raw
  records and are offered to the directory as an import (never created there on their own). Events
  `receivable.created`, `receivable.updated`, `receivable.paid` (balance reached zero), not raised for
  history. Reads: `qbo.invoice.query`, `qbo.customer.query`, `qbo.payment.query`, and
  `qbo.aging_report` (QuickBooks' A/R aging report, read live, as of a date, with each open invoice and
  its bucket; sources are the receivables). Write: `qbo.invoice.add_note` (`external`, verb `update`,
  entity `invoice`, scope `notes_only`): appends a dated line to the invoice's **PrivateNote** only, a
  sparse update with the SyncToken; the before state is the old note; it can't touch anything else.
- **Create bill (v0.12, owner 2026-11-06).** `qbo.bill.create` (`external`, verb `create`, entity
  `bill`, `amount` declared for approver rules): vendor, dates, doc number, lines (account or item,
  amount; items with qty and unit price), expected total. Refused when proposed and again before
  writing if the lines don't add up to the total, the vendor isn't the company's, or a bill with the
  same vendor and doc number exists (synced or found live); QuickBooks' `requestid` comes from the
  action's key. Behind approval like every write; the default matrix keeps create at `approval`, and
  the template that uses it starts with approval on (invariant 8). Delete stays off.
- **Ingredients (P-2, owner 2026-11-07).** Tools for agents built later in the agent lab: reads
  `qbo.account.query` (entity `account`), `qbo.class.query` (`class`) and `qbo.purchaseorder.query`
  (`purchase_order`); writes `qbo.vendor.create` (`vendor`, verb `create`, refused when a vendor has
  the name) and `qbo.purchaseorder.create` (`purchase_order`, verb `create`, the rules of create bill),
  both behind approval; bill and purchase lines may name a class and a customer (billable or not).

### 6.3 Upload connector

- Upload PDF/JPG/PNG documents → `document` (no transaction yet) → linked to a transaction by vendor +
  total + date (±7 days) when possible. Unlinked documents still extract.
- Upload CSV of purchases (date, vendor, amount, memo) → `raw_record(connector='upload')` → transactions.
- The demo path when QBO is not connected.

### 6.4 Gmail (send only; owner, 2026-11-05)

> **Decision (owner, 2026-11-05): no restricted Gmail scopes, so no CASA security assessment.**
> `gmail.readonly` and `gmail.compose` are restricted scopes: a public app needs Google's full
> verification plus a yearly CASA assessment. Mezonas asks for **`gmail.send` only** (a sensitive scope:
> Google's standard review, no CASA). **Reading mail is done by forwarding** (§6.5): the client forwards,
> or sets a Gmail filter to auto-forward, the messages agents need (invoices, receipts, replies) to its
> private Mezonas address. Google Workspace clients who want in-mailbox search can later grant
> domain-wide delegation from their own admin console, which needs no public verification. The read,
> label and draft design below is kept for that later step and is not built now.

- OAuth 2.0 with Google, granted by the client for one person's or a shared mailbox, scope `gmail.send`
  only. Tokens encrypted in the vault (§6.9).
- **Tool, write** (`external`, approval required): `gmail.send` (reach out, §1.25 of the plan): sends a
  message the client's approver has seen, from that mailbox; replies come back through forwarding.
  It may attach up to five of the client's stored PDFs and images, named by document id and listed
  by name and size on the approval card; a reply's PDFs and images become the client's documents
  (P-3, `docs/plan.md` §1.65).
- Google's review needs a live homepage and privacy policy on mezonas.com (the Limited Use statement),
  domain verification (done 2026-11-05), a demo video and a reason for the scope.
- **Confirmed (owner, 2026-11-06): still send-only, no CASA.** Reading mail is forwarding: the client
  sets a Gmail filter that forwards a label to its Mezonas address. **Writing in the client's voice**
  learns only from **voice samples**: messages the client pastes into the knowledge base or forwards to
  its forwarding address with the `+voice` tag, stored as `knowledge_entry(kind='voice_sample')` with
  whose voice it is. Only that tagged address keeps a body (quoted history cut, at most 4,000
  characters, card numbers redacted, allowed senders only); ordinary forwarding still keeps none.
  The built-in skill `writing.draft-in-voice` reads samples with `knowledge.voice_samples` as tool
  results (data, invariant 9), never from a mailbox.

Later, only if a client needs it (restricted scopes, CASA or Workspace delegation):
- `gmail.readonly` search and read, `gmail.labels`, `gmail.compose` drafts, with a narrow ingestion
  query: only matching messages synced (headers and snippet to `raw_record(entity_type='Message')`,
  attachments to `document(source='email')`), bodies fetched on demand, history polling every 5 minutes.
- Email content is untrusted input (§16): bodies and attachments reach agents only as tool results.

---

### 6.5 Email forwarding (built in, with upload)

The MVP's email path, and a fallback for clients who don't connect a mailbox (the design's "Upload and
forwarding · built in"). Each client gets a private forwarding address (e.g.
`<client>-<random>@in.<domain>`, kept with the allowed senders on the client's upload connection), shown
on the portal's Connections page; the client adds a forwarding
rule in their own mail (e.g. from `ap@`).
- Received by **Cloudflare Email Routing** into the Worker's `email()` handler. Only mail from the
  sender addresses or domains the client lists is accepted; everything else is dropped and counted.
- Each message's PDF and image attachments become `document(source='email')`, deduplicated by sha256
  and linked like uploads (vendor + total + date, with the sender domain as a vendor signal). Headers and
  subject are kept on the document; bodies are not stored. Email text is untrusted (§16).
- Verify Email Workers' message size limits and MIME parsing (e.g. `postal-mime`) at the start of M2.

### 6.6 Webhooks (owner, 2026-11-04)

A generic connector (`webhook`, `auth: 'none'`) for Zapier, Make, n8n and anything else that can send
or receive an HTTP POST. A published Zapier app (triggers and actions over the same endpoints) comes
later; its plan is in `packages/connectors/src/webhook/NOTES.md`.

- **In.** The client creates inbound hooks on its webhook connection in the portal (a name each). A hook's
  URL is `POST /api/hooks/:clientId/:hookId` with a secret token (`?token=` or the `x-mezonas-token`
  header), or an HMAC-SHA256 signature over `timestamp.body` (`x-mezonas-signature`,
  `x-mezonas-timestamp`, five-minute window) for senders that can sign. Tokens are kept in the
  connection's encrypted credentials and shown only in the client's portal; hook ids and names are in
  `connection.config` so the operator can filter triggers on them. Tokens are compared in constant time.
  A delivery is JSON or a form, at most 64 KB, at most 60 a minute per hook; it is stored once as
  `raw_record(entity_type='Delivery')` keyed by the sender's `Idempotency-Key` (else the body's sha256),
  so a resend is acknowledged and stored nothing, and emits **`webhook.received`** (connector event type,
  §8) with the body as `data`. The body is untrusted data (invariant 9): it reaches steps only through
  the trigger payload and tool inputs, never instructions.
- **Out.** `webhook.event.send` (`external`, verb `create`, approval on by default) POSTs
  `{ event, data, id, sentAt }` as JSON to the outbound URL the client pasted (its Zap's catch hook),
  with `Idempotency-Key` (the external action's key) and an `x-mezonas-signature` HMAC under a signing
  secret shown in the portal. Only `https` URLs to public hosts (no IP literals in private ranges, no
  `localhost`/internal names), no redirects, 10-second timeout; the response status and the first 2 KB
  of its body are the action's result. The outbound URL is in the encrypted credentials.
- How-to for clients: `docs/connect-zapier.md`.

### 6.7 Zoho CRM (owner, 2026-11-04)

Connector `zoho_crm`, OAuth 2.0 (Zoho Accounts, multi data center). Facts checked and unchecked are in
`packages/connectors/src/zoho_crm/NOTES.md`.

- The client signs in from the portal. The authorization request goes to `accounts.zoho.com`
  (`access_type=offline`, `prompt=consent`); the callback returns `location` and `accounts-server`. The
  code is exchanged at that accounts server, only if it is a known Zoho accounts host; the token
  response's `api_domain` is where every API call goes. Tokens, the accounts server and the API domain
  are encrypted on the connection; the data center and API domain are also in `config`, the org id is
  `external_account_id`. Access tokens last an hour and are refreshed (and persisted) before expiry or
  on a 401; a refused refresh asks the client to reconnect. Disconnect revokes the refresh token.
- Scopes: read, create and update for Leads, Contacts, Accounts, Deals, Notes and Tasks, plus org read.
  No delete scope.
- **Tools, read** (`none`): `zoho_crm.record.search` (criteria, email, phone or word, paged),
  `zoho_crm.record.get`.
- **Tools, write** (`external`, approval on by default): `zoho_crm.record.create`,
  `zoho_crm.record.update` (before state: the record's current values of the fields it changes; refused
  if the record changed since the agent read it, by `Modified_Time`), `zoho_crm.note.create`,
  `zoho_crm.task.create`. Delete is off.
- Sync of modules into `raw_record` and Zoho notifications are follow-ups; v1 is tools only.
- Rate limits: credits per rolling 24 hours and concurrent-request caps by edition; a 429 fails the call
  so the step retries with backoff.

### 6.8 Podio (owner, 2026-11-04)

Connector `podio` (the tool first noted as "poladio"), OAuth 2.0. Facts checked and unchecked are in
`packages/connectors/src/podio/NOTES.md`.

- The client signs in from the portal (`podio.com/oauth/authorize`, code exchanged at
  `api.podio.com/oauth/token`). Tokens are encrypted on the connection; the signing-in user is
  `external_account_id`. Access tokens last 8 hours and are refreshed (the new refresh token saved
  each time); a refused refresh asks the client to reconnect.
- Podio apps are built by each client, so tools take fields generically (`{ <field external_id>:
  value }`) and check them against the app's own definition at call time: unknown, inactive or
  read-only fields, values of the wrong type, choices that don't exist and missing required fields are
  refused before anything is written.
- **Tools, read** (`none`): `podio.space.list`, `podio.app.list`, `podio.app.get` (fields, types,
  choices), `podio.item.filter`, `podio.item.get`.
- **Tools, write** (`external`, approval on by default): `podio.item.create` (its `external_id` is the
  external action's key, looked up first, so a retry finds the first item), `podio.item.update` (before
  state: the changed fields' values; refused if the item's revision moved), `podio.comment.create`,
  `podio.task.create`. Delete is off.
- Rate limits answer 420; the call fails as retryable. Sync and Podio hooks are follow-ups.

### 6.9 Access: the client's vault, grants and the code service (owner, 2026-11-05)

**The vault.** Everything that lets an agent into a client's tools is a **vault item**, stored as a
`connection`: OAuth connections (as today), API keys (`auth: 'api_key'`, entered once in the portal) and
browser logins (§6.10). Secrets are encrypted with **the client's own data key**: each client has a
key, generated when first needed and stored only wrapped by the master `ENCRYPTION_KEY` (`tenant_key`).
A credential envelope names the client key it was written with and stays bound to its client and
connection (§16). Rotating the master key re-wraps client keys only; destroying a client's key makes
everything it encrypted unreadable at once (for retiring a client). Secrets are **write-only**: the
client admin enters them, no screen or route returns them, and they can only be replaced or removed.
The operator never sees a client's secret.

**Grants.** A client agent reaches a vault item only through its **binding** (as today: the operator
binds one connection per connector, or per site for browser connections). A binding may carry **grant
limits**: a ceiling per verb (`auto`, `approval`, `off`) and, optionally, the subset of the connector's
tools the agent may call. What a call may do is the strictest of: the connection's matrix, the agent's
grant, the step's approval setting and the agent's mode. So one QuickBooks connection can serve an
intake agent that only reads and a billing agent that creates bills with approval, and an agent with no
binding cannot reach QuickBooks at all. The operator sets and loosens grants; the client admin sees every
agent's access on the portal's **Access** page and can tighten or revoke a grant at once (invariant 8's
rule: only the operator loosens). Every change is an `agent_change` row.

**The code service** (`apps/mfa`). Second factors never live with passwords. A separate Worker, with
its own encryption key, its own Durable Object storage (no database shared with `apps/api`) and its own
secrets, holds the client's **agent identities**: per identity an email address on Mezonas' agent domain
(`AGENT_EMAIL_DOMAIN`, Cloudflare Email Routing → the code service) and optionally a phone number in a
Twilio subaccount kept for codes, plus any authenticator (TOTP) secrets. The client's tool admin creates
the agent account in their tool with that address and number. A login in progress (our code, §6.10)
**opens a wait** for one identity, one site, the expected sender and the code's pattern, for a few
minutes; the service reads the code out of the matching message with that pattern (never a model),
hands it **once** to the login that asked, closes the wait and deletes the message. Anything that
arrives outside a wait is never handed out: an unexpected code or a password-reset message is held and
raises an **alert** to the operator and the client admin, since it means someone else is trying that
account. Links in messages are never followed. Email codes count only when the message passes SPF,
DKIM and DMARC. Each identity has a daily cap on code requests. Only `apps/api` can call the service,
through a service binding; its only public routes are Twilio's signed inbound webhook and the email
handler.

**Human release (optional, owner 2026-11-05).** Any vault item can require a person to release it
before an agent uses it. Off by default; when on, the connection names one person (a user of the client
with a verified phone or email), the channel (text or email) and the release window (one run, or up to
24 hours). The first time a run needs the connection without a valid release, the step pauses and we
send that person a one-time 6-digit code; they enter it in the portal or reply to the message with it,
and the agent goes on. The code proves possession of the person's phone or inbox, not only a portal
session. Codes are stored hashed, last 10 minutes, allow 5 tries and work once; the agent never sees
one. No release by the end of the wait fails the step ("access not released"). The client admin turns it
on or off and picks the person; the operator can turn it on, never off. Every request, release, failed
try and revoke is logged, and the Access page shows live releases with a Revoke button.

### 6.10 Browser connections (owner, 2026-11-05)

For tools with no API, an agent may work in the website itself, on **Cloudflare Browser Run**, signed in
as a **dedicated agent account** (never a person's own login) that the client creates with the
smallest role that does the job.

**Sites.** The operator keeps a catalogue of allowed sites (`browser_site`, versioned like skills): the
login page and the origins credentials may be typed into, the login steps, how to recognise the
signed-in page, how to sign out, the pages agents may open and the pages they never open (on every site:
settings, passwords, users and permissions, billing and payment, deletion), how second-factor codes
arrive, and a **risk tier**:

| Tier | Examples | Agent signs in on its own | Writes |
|---|---|---|---|
| low | supplier portals, price lists, invoice downloads, shipment tracking | yes | approval by default; `auto` allowed by the matrix as for any connection |
| medium | ordering portals, CRMs without an API | yes | always approved |
| high | payroll, tax portals, health records, insurance | no: a person signs in through Browser Run's human handoff | always approved |
| blocked | banks, payments, crypto, email accounts, identity providers, password managers | never | never |

The tier comes from four questions: can the site move money, change access or reset accounts, does it
hold regulated data, and does it have an API (then we use the API). A client can make a site stricter
for itself, never looser.

**Signing in.** A browser connection is a vault item: the username and password of the agent account,
entered by the client admin, plus the identity in the code service for its second factor. Our code signs
in, not the model: it opens the login page, checks the address against the site's login origins (no
match, nothing typed), types the credentials, asks the code service for the code, and checks the
signed-in page. Session recording is off during sign-in. The model then works through browser tools
(read a page or table, download a file as a document, and, later, submit a form as an external action
behind approval); page text is data (invariant 9), password fields are removed from what it reads, it
cannot run scripts in the page and it can only open the site's allowed pages. At the end our code signs
out and the browser is destroyed. Low-tier sites may keep the session, encrypted in the vault, to skip
the next sign-in.

**Stops.** A CAPTCHA, an "unusual activity" or new-device check, or any unexpected page stops the run
and asks a person; two failed sign-ins disable the connection so the client's account is never locked.
Each connection has a daily cap on sign-ins and optional hours. Each session records the pages visited,
the actions and screenshots; the client sees a plain summary in the run timeline and can disconnect, which
deletes the stored login and session at once. The client confirms it owns the account and that the
site's terms allow automated access; the operator checks the terms before allowing a site.

### 6.11 New connectors (v0.12, design; build order below)

Each is a connector like the others (manifest with `permissionEntities`, tools, vault credentials,
portal sign-in by the client, approval on every write, delete off), built and tested against a fake,
registered everywhere and signing in only once its keys are set (`isConfigured`). No new accounts or
keys are made by a build agent; the owner creates each developer app.

| Order | Connector | Auth and scope | Tools | Depends on |
|---|---|---|---|---|
| 1 | `gdrive` Google Drive | Google OAuth, `drive.file` only (files the app creates), in the existing Google project | `drive.file.upload` (`external`, create, entity `file`: a document into a folder the connection made, by a path template such as `Bills/{{yyyy}}/{{MM}}`), `drive.file.list` (read, our files only) | Google consent screen gains the scope (owner) |
| 2 | `outlook` Outlook | Microsoft identity platform, delegated `Mail.Send`, `offline_access`, `openid email`; no read scope | `outlook.send`, the same input as `email.send` and `gmail.send`; sent once (attempt recorded first, as Gmail); replies come back by forwarding | An Entra app with publisher verification (owner) |
| 3 | `ramp` Ramp | Ramp OAuth (authorization code) | `ramp.transaction.query`, `ramp.user.query` (reads); `ramp.receipt.upload` (`external`, create, entity `receipt`); event `ramp.transaction.created` from a poll every 15 minutes | A Ramp developer app (owner) |
| 4 | `hubspot` HubSpot | HubSpot public app OAuth: contacts, companies, deals, notes, tasks; read and write | `hubspot.record.search`, `.get`; `hubspot.record.create`, `.update` (before state, stale check by `updatedAt`), `hubspot.note.create`, `hubspot.task.create`; a directory import source | A HubSpot developer account (owner) |
| 5 | `bankfeed` bank and card feeds | An aggregator's hosted link flow (Plaid Link or the vendor's equivalent); read-only transactions | `bankfeed.transaction.query`; event `card.charge.created` / `bank.transaction.created` from the vendor's transactions sync; never money movement | Vendor: **Plaid** (owner, 2026-11-06; `docs/plan.md` §1.52). **Owner decision:** price per connected account, production review, and whether it is a HIPAA-mode processor |
| 6 | `slack` Slack | Bot token, `chat:write` to channels the client picks | `slack.message.post` (`external`, create) | The owner asked for it (2026-11-06): Wave 4, W4-C. A Slack app with public distribution (owner) |
| 7 | `gsheets` Google Sheets | Google OAuth, `drive.file` only (sheets Mezonas creates and sheets the client picks with Google's picker), on the existing Google client | `sheets.range.read` (read); `sheets.rows.append` (`external`, create, entity `row`); `sheets.range.update` (`external`, update, entity `row`, before state the cells' current values) | Added by the owner (2026-11-06): Wave 4, W4-D. The Sheets API enabled and a browser key for the picker (owner) |
| 8 | `gchat` Google Chat | A Chat app of Mezonas' own (service account, `chat.bot`); a space is the client's only after its one-time code is posted there | `gchat.message.post` (`external`, create, entity `message`) to bound spaces | Added by the owner (2026-11-06): Wave 4, W4-E. The Chat API set up and the app on the Workspace Marketplace (owner) |

Agents never sign in to a bank or card website (blocked tier, §6.10); feeds come only through the
aggregator's API.

### 6.12 WhatsApp passive capture (v0.14, owner 2026-11-06)

Messages that reach a client's WhatsApp number (its Twilio sender today, `docs/plan.md` §1.22; Meta
later, §1.19) are kept for the client, and their attachments are filed as documents where the client
turned that on. **Passive:** nothing on this path replies; an agent works on what arrives only if a
workflow of its own starts on it, and anything it sends goes through the gate as always. Same pattern
as Respaldo's capture (claim once by message id, fetch in the background, size checked before and
after, storage keys from ids only), with nothing shared.

**Conversations.** A `conversation` (§5.5, 0031) is one WhatsApp chat on one connection: `direct` (one
contact; Twilio, built now) or `group` (Meta's groups API, designed only: the schema takes it, nothing
makes one yet). The first inbound message from a contact on a connection makes its conversation, in
the webhook's transaction, with the client's default capture (`tenant.settings.messaging.capture`).
Someone who wasn't a contact (§1.22 makes them one with no consent) gets the default with attachments
**off** whatever the default says, so a stranger's files are never fetched until a person chooses to.
SMS keeps today's behaviour and makes no conversation yet (`channel` leaves room for it).

**Capture** (per conversation; `capture` jsonb):

| Field | Meaning | Default |
|---|---|---|
| `archive` | keep the message text (raw record, contact thread). Off: only the envelope is kept (id, time, sender, channel, attachment facts) for dedupe, STOP and counts; the thread shows "Not kept"; agents read no text | `true` (today's behaviour) |
| `attachments` | `off`: record only that each attachment existed (index, content type, size when known), never the bytes or a link; `documents`: PDFs and images; `all`: also audio, video and common office files from a fixed list. An unknown or executable type is refused even under `all` | `off` |
| `maxBytes` | per file; refused above it | 20 MB, never above the documents capability's 32 MB |
| `agentId` | a client agent of this client with a `whatsapp` message trigger, started with the new documents (below) | none |

**Who changes it.** The client admin (portal) and the operator (back office) may each turn `archive`
and `attachments` on or off: it is the client's data and the client's choice, not a permission on the
client's tools, so invariant 8's "only the operator loosens" doesn't apply. `maxBytes` and `agentId`
are the operator's (they are setup, and `agentId` wires an agent). The client default is the
operator's. Every change is a `conversation_change` row (who, side, before, after, reason) or, for the
default, a `tenant_change` row; client users can't see or change capture.

**Download.** When a message has media (`NumMedia`, `MediaUrl{i}`, `MediaContentType{i}`) and the
conversation's `attachments` allows the declared type, the media is fetched after the inbound
transaction commits, as a durable job: one Workflow instance per message
(`capture-<client>-<message sid>`), one step per media index, retried with backoff; a cron pass
restarts captures left pending; without the Workflow binding (local, tests) it runs after the
response.
- The request goes only to Twilio's API origin (`https://api.twilio.com`, compared as
  `new URL(x).origin`), on a URL built from validated ids (the client's subaccount SID, the message
  SID and the media SID), never a URL taken from the webhook, with the client's subaccount
  credentials. Twilio answers with a redirect to a short-lived signed link: followed once, by hand,
  HTTPS only, without our credentials, and only to an origin on a fixed list (to verify, plan §1.55).
- Size: the declared length is checked before reading and the bytes are counted while reading; the
  read stops at `maxBytes`. Type: the response's type must match the declared one, and PDFs and images
  must start with their own magic bytes.
- Each file is stored once in R2 by sha256 through the documents capability (`storeDocument`,
  `source: 'message'`), so `document.received` fires and the background reading and linking apply
  as for an upload. The same file sent twice is one document (§7), named by both messages.
- **Once per (message SID, media index):** a raw record `MessageMedia` keyed `<sid>:<index>`, inserted
  in the same transaction as the document, holds the outcome (`filed` with the document id,
  `refused` with the reason, `failed`). A retried webhook or step finds it and does nothing more.
- The document's `meta` names its sources: the message's raw record, the conversation, the message SID
  and the index. The raw records are never changed (invariant 3).
- **Download now:** the operator or the client admin may fetch one message's attachments later, if
  the conversation's setting allows them at that moment; the same job, the same once-only key.
- Media stays at Twilio; deleting it there after filing is an open owner choice.

**Agents.** `message.get` and `messages.search` (the provider-neutral ids, §1.22) gain the
conversation (`id`, `kind`, `title`) and each attachment (`index`, `contentType`, `sizeBytes?`,
`status`: not downloaded, pending, filed, refused or failed; `documentId` when filed). Text and files
reach a model only in tool results (invariant 9); a document's content is read with the `docs.*`
tools. With `capture.agentId` set, once a message's downloads finish, that agent gets
`inbound.message` (§10.8, channel `whatsapp`) with the new document ids, through its existing message
trigger and People filter; no new trigger kind, no reply, and the agent isn't started a second time
for the same message.

**Groups (design only).** Groups arrive with the `whatsapp_meta` connector (§1.19 of the plan). To
verify before building: Meta's groups API needs an Official Business Account, a Tech Provider
registration, groups created by the business, and limits on participants (third-party guides say
about 8). Twilio has no WhatsApp groups (WhatsApp retired its old groups API in 2020; Twilio's
"group" sample fans out one-to-one chats through Conversations). Unofficial WhatsApp clients are out:
they break WhatsApp's terms.

**Through Meta (W4-A, `docs/plan.md` §1.57).** The `whatsapp_meta` connector (the client's own number,
connected with Meta's Embedded Signup) feeds the same capture: its messages are routed by the number
they came to, stored once per `wamid`, and their attachments fetched with Meta's two-step download
(the media id resolved on the client's number, then the signed link on Meta's media host, both with
the client's token) under the same checks. Group messages are kept, as `group` conversations, only
where the operator turned groups on for the client; their payload is still to verify.

**Compliance.** Twilio is already a processor, and `meta_whatsapp` is listed for `whatsapp.*`. The
public privacy page says that we archive messages sent to a client's number and, where the client
turns it on, their attachments, on the client's behalf. Conversations, their change log and the
filed documents follow the client's existing data handling: exports and retirement.

**Screens.** Minimal, until the owner's redesign: the portal's `/conversations` (client admin) lists
each conversation with its two switches; the back office shows the same on the client's messaging
page, with the client default. Design-system classes only; portal words in six languages.

## 7. Documents capability

A platform capability any pack or custom skill can use; exposed as tools (`docs.*`, §9.4).

- Store: originals in R2 keyed by sha256, never mutated.
- Locate support for a transaction: connector attachments first (QBO Attachables), then email
  (forwarded documents; with Gmail connected, documents already synced, then a scoped Gmail search), then
  uploaded documents (vendor + total + date
  match), then a request to a person (inbox, or a Gmail draft to the purchaser for approval).
- Extract: send the document to Claude as a PDF or image content block with a forced tool whose input
  schema is `InvoiceExtraction` (Zod → JSON Schema): header fields, lines[], subtotal, freight,
  surcharges[], tax, total, per-field confidence, page refs.
- Validate: `abs(sum(lines.ext_price) - subtotal) <= max(0.02, 0.5% of subtotal)` and
  `subtotal + freight + surcharges + tax ≈ total`. Fail → `document.status = needs_review` +
  `inbox_item(kind='extraction_review')`.
- Store the model and agent version on `doc_extraction`. Never overwrite; re-extraction inserts a row.

---

## 8. Senses (events)

A sense is a typed event emitted when data changes meaningfully. Written to `event` in the same
transaction as the change (outbox). After commit, a dispatcher hands it to the trigger router, which
starts a run for each enabled workflow whose trigger matches; a cron sweep re-dispatches anything left
behind.

Platform event types: `transaction.created`, `transaction.updated`, `document.received`,
`document.extracted`, `document.extraction_failed`, `inbox.resolved`, `external_action.done`,
`external_action.failed`, `alert.raised`, `schedule.tick`. Packs declare their own
(`materials.line.matched`, `materials.price.changed`, ...). Connectors may declare their own too
(`webhook.received`, §6.6), listed for every client. The builder's trigger picker lists the event
types available to the tenant (platform + connectors + enabled packs), each with a sample payload.

**Dispatch right after commit (v0.12 fix).** The API end-to-end test (#102) found events that reach
the router only on the cron's sweep (older than 30 seconds), so runs start 30 to 90 seconds late:
events emitted in background work (reading an upload, a sync step, a run's step) had no after-commit
dispatch. Every transaction that emits records the event ids it wrote (`emit` returns them; the
`withTenant` caller collects them) and dispatches them once it commits, in the request's or step's
`waitUntil`; the sweep stays the backstop. v0.12 adds the event types `thread.message_posted`,
`run.succeeded` (live runs only, with the workflow's handoff output), `receivable.created`,
`receivable.updated` and `receivable.paid`.

---

## 9. Tools, skills and agents

### 9.1 Agent bundle (stored in `agent_version.bundle`)

One version is the **whole agent**: its definition, its workflows and its settings. Editing anything
(instructions, a skill setting, one step in the builder) makes a new version of the bundle. This keeps a
client agent's history linear and makes template updates one merge, not one per workflow.

```ts
const AgentBundle = z.object({
  schemaVersion: z.literal(1),
  definition: AgentDefinition,
  workflows: z.array(z.object({
    slug: z.string(), name: z.string(), enabled: z.boolean().default(true),
    workflow: Workflow,                            // §10.1
  })),
});

const AgentDefinition = z.object({
  schemaVersion: z.literal(2),
  identity: z.object({ name: z.string(), role: z.string(), mission: z.string(), avatar: z.string().optional() }),
  kind: z.enum(['functional', 'platform']),
  model: z.object({ id: z.string(), maxTokens: z.number().default(4096) }),
  instructions: z.string(),                       // plain language; how this agent works
  skills: z.array(z.object({
    skill: z.string(),                            // 'materials.match-lines' | 'custom:<slug>' [@version]
    settings: z.record(z.unknown()).default({}),  // overrides the skill's settings defaults
  })),
  extraTools: z.array(z.string()).default([]),    // tools beyond those its skills bring
  canCommand: z.array(z.string()).default([]),    // agent slugs it may ask (same client)
  permissions: z.object({
    mode: z.enum(['suggest_only', 'act']).default('suggest_only'),   // suggest_only: every write waits
    approver: z.string().optional(),              // default approver for this agent's steps (role or user)
  }),
  budgets: z.object({ maxSteps: z.number().default(12), maxCostUsd: z.number().default(0.5) }),
  memory: z.object({ enabled: z.boolean().default(true) }),
});
```

**v0.13** (`AgentDefinition` stays `schemaVersion: 2`; the field is optional, so stored bundles parse
and hash the same):

```ts
oversight: z.object({                              // §10.11; absent: off (agents before v0.13 run as today)
  review: z.enum(['off', 'failures', 'checkpoints', 'all']),
  model: z.object({ id: z.string(), maxTokens: z.number().default(2048) }).optional(), // default: `model`
  maxPerRun: z.number().int().min(0).max(10).default(3),     // interventions per run
  maxCostUsd: z.number().default(0.25),                      // per run, on top of `budgets`
}).optional(),
```

Every item a merge must line up carries a **stable id** that survives forking and editing: workflows
by `slug`, steps and fork paths by `id` (generated once, copied on fork, never reused), skills by `skill`.

An agent's **commands** are its skills: anything that can be a workflow step can be invoked in a
thread as `/skill-slug args` or by another agent of the same client.

### 9.2 Skill definition

```ts
const SkillDefinition = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),                                 // 'docs.extract', 'materials.match-lines', 'custom:<slug>'
  name: z.string(), description: z.string(), category: z.string(),
  mode: z.enum(['tool', 'agent']),                // 'tool' = deterministic handler; 'agent' = reasoning loop
  handler: z.string().optional(),                 // tool id when mode = 'tool' (built-ins only)
  instructions: z.string().optional(),            // added to the agent's prompt when mode = 'agent'
  tools: z.array(z.string()),                     // tools the agent may use while running this skill
  input: JsonSchema, output: JsonSchema,          // typed; the builder makes forms from these
  settings: z.array(z.object({                    // e.g. match_confidence_auto: 0.9, price_change_pct: 5
    key: z.string(), label: z.string(), type: z.enum(['number', 'boolean', 'string', 'enum']),
    default: z.unknown(), options: z.array(z.string()).optional(),
    clientSpecific: z.boolean().default(false),   // e.g. a vendor list: never promoted into a template
  })).default([]),
  requiresConnectors: z.array(z.string()).default([]),
  requiresPacks: z.array(z.string()).default([]),
  producesAlerts: z.boolean().default(false),     // outputs must carry `sources`
});
```

- **Built-in skills** are code: platform skills (`docs.find-support`, `docs.extract`, `threads.summarize`,
  `inbox.ask`) and pack skills (`materials.*`). Their version is the package version.
- **Operator-written skills** are created in the back office's Skills library, shared or for one client: name, description, instructions, a selection of
  existing tools, input and output fields (a form that produces the JSON Schema), settings. Mode
  `agent`, or `task` with a model (v0.13). Saved as `skill_version` rows with the same draft → publish → rollback rules as agents.
- A client agent can use a skill only when the client has the required connections bound and packs
  enabled. Forking a template into a client shows what's missing there.
- **v0.13: three modes.** `mode` becomes `'tool' | 'task' | 'agent'`, and `SkillDefinition` gains
  `model?: { id, maxTokens? }`:
  - `tool`: code (a handler), no model. Unchanged.
  - `task`: a typed job that does not depend on the agent running it, such as reading an invoice into
    JSON, classifying a line or summarising a thread. `model` is **required**: the skill's default,
    chosen for the job. The system prompt is the platform preamble and the skill's instructions;
    **no** agent instructions and **no** memory notes. The input goes in as data, in the user turn
    inside the platform's untrusted-data wrapping, never in the system prompt, because it often
    carries document or email text (invariant 9), as agent skills receive such text in tool results. Same input, same model, same instructions in
    every agent, so its tests (§9.10) hold wherever it is used.
  - `agent`: depends on the agent. Runs on the agent's `definition.model` with the agent's
    instructions and memory notes, as today: analysis, judgment and drafting in its voice. `model` is
    not allowed on the skill (the agent decides).
  - A step may override the model of a `task` or `agent` skill (§10.11). Changing a task skill's
    default model is a new skill version, so client agents pinned to the old one don't change.
  - Existing skills stay `agent` (stored rows parse unchanged); built-in skills move to `task` one at
    a time, each with its recorded fixtures re-recorded. // DECISION: no bulk move.


### 9.3 Versioning, templates and client agents

The heart of the managed service. Agents are effectively built per client; templates are how work is
reused.

**Versions** (templates and client agents alike)
- Every edit inserts a new `agent_version` (status `draft`) with `parent_version_id` = the version it was
  edited from. Publishing sets it `live` and updates `live_version_id`, in one transaction.
- Rollback = publish an older version by copying it as a new version, so history stays linear.
- `bundle_hash` = sha256 of canonical JSON; no-op edits are rejected.
- Version history shows, for each version: who, when, change note, and a diff against its parent
  (fields as sentences; workflows as a step-by-step diff).

**Templates**
- `kind='template'`, `tenant_id` null. Created from scratch, by the Builder, or installed by a pack. Never
  run for a client directly; test-run against the sandbox client or (in test mode) a client's data.
- Each published template version carries a `release_note` that clients' update reviews show.

**Forking**
- Forking template version *T* into client *C* creates a client agent (`kind='client'`, `tenant_id = C`,
  `template_id`) whose v1 is a copy of *T*'s bundle with `based_on_template_version_id = T`. Step and
  path ids are copied, so later merges can line them up.
- A client agent can also be created from scratch for one client (no template), or forked from another
  client's agent (copied, re-bound to the new client's connections; memory and learned data never come).

**Customizing**
- The operator edits the client agent in the same editor and builder as templates: settings for this
  client's data, instructions, skills, workflows added, removed or rewired. Each edit is a new version of
  the client agent; `based_on_template_version_id` is unchanged.
- **Customizations view:** the diff between the client agent's live version and its base template
  version, so the operator always sees what was changed for this client.

**Template updates (three-way merge)**
- When template *T* publishes a newer version *T′*, each linked client agent based on an older version
  shows "update available" with *T′*'s release note.
- Applying it merges structurally: base = the client's base template version, theirs = *T′*, ours = the
  client's live version. Agent fields merge by key; skills by `skill`; workflows by `slug`; steps and
  fork paths by `id`, step config by field; the order of each step list merges as a sequence (inserts
  kept next to their neighbours; two different reorders of the same list, or a step moved to different
  places, conflict). A change on one side only is taken; the same change on both
  is taken once; different changes to the same field, or a delete against an edit, are **conflicts**.
- The result is a draft client version with `author_type='merge'`, `based_on_template_version_id = T′`
  and `merged_from_version_ids`. Conflicts are resolved in the merge view (§10.5) before it can be saved
  as valid; workflow validation (§10.2) runs on the merged result. Then test-run and publish as usual.
- Updates are never applied automatically in v1. The template page shows every client agent: base
  version, versions behind, number of customizations, open conflicts.

**Promoting**
- From a client agent, the operator can promote its customizations (all, or selected changes) into a new
  **template draft**: a three-way merge the other way (base = the client's base template version, ours =
  the template's live version, theirs = the client version). Client-specific values (bindings, ids of the
  client's records) are left out; settings are offered, not assumed.

**Detaching**
- A client agent can be detached (`linked=false`): it keeps its history but no longer receives template
  updates. Re-linking picks a template version as the new base.

**Runs and evidence**
- A run records the client agent, the exact version it ran and a snapshot of bindings and approver.
- Every `step_run`, `message`, `doc_extraction`, `external_action` and pack decision made by an agent
  records `agent_version_id`.
- Skills are referenced by id (live version) or `id@version` (pinned) inside a bundle.
- **The runtime never reads agent, skill or workflow settings from code.** Pack templates are inserted as
  template v1 rows when the pack is installed.

### 9.4 Tool registry

Each tool: `{ id, description, input: Zod, output: Zod, sideEffect: 'none'|'internal'|'external',
verb: 'read'|'create'|'update'|'delete', source: 'platform'|'<connector>'|'<pack>', summary?: Template,
handler }`. Agents touch data only through tools. In the builder, `external` tools are **actions**
("change your tools").

Platform tools:
| id | sideEffect | does |
| --- | --- | --- |
| `ledger.query` | none | Query transactions/lines/vendors with filters |
| `docs.find_support` | internal | Run the locate sequence for a transaction |
| `docs.get` | none | Document metadata + signed URL + latest extraction |
| `docs.extract` | internal | Run extraction |
| `docs.request_from_person` | internal | Create an inbox request for a document (email if configured) |
| `alerts.raise` | internal | Create an alert with evidence |
| `inbox.create` | internal | Create an inbox item |
| `threads.post` | internal | Post a message to a thread |
| `agents.ask` | internal | Ask another agent (routed by the Coordinator) |
| `memory.write` | internal | Save a memory note |

Connector tools come from manifests (§6); pack tools from packs (§12).

### 9.5 Runtime

```ts
runAgent({ tenantId, agentVersionId, skill | task, input, threadId?, runContext }): Promise<AgentResult>
```
1. Load the client agent's version (the run's pinned bundle) and resolve the skill to its version, with
   the bundle's settings for it. `agents.ask` resolves other agents among the same client's agents.
   Validate input.
2. If the skill's mode is `tool`: call the handler directly, log, return.
3. Else build the prompt: platform preamble (cite sources, use tools, never invent numbers) + agent
   `instructions` + the skill's `instructions` + the client agent's memory notes + task input. Expose only the skill's tools
   (and `extraTools`), `ask_agent` if `canCommand` is non-empty, and `finish(result)` typed to the skill
   output.
4. Loop: model call → tool calls → results, until `finish` or budget hit. Enforce `maxSteps` and
   `maxCostUsd`. On budget hit: return `{status:'escalated'}` and create an inbox item.
5. **Permission gate** per tool call. Reads (`none`) run if the connection's `read` isn't `off`.
   Internal writes (`internal`: the platform's own records, e.g. a price observation or an inbox item)
   run and are logged; they don't touch the client's systems. **Writes to a client's tool**
   (`external`) **need approval by default.** One runs without approval only when all three say so: the
   connection's matrix has `auto` for the verb, the step is set to `approval: 'not_required'`, and the
   agent's mode is `act`. Otherwise: matrix `off` → refused (and caught at publish); anything else → an
   `external_action` (status `proposed`) plus an `inbox_item(kind='external_action')` for the step's
   approver, showing now / after this change; the step waits for `inbox.resolved`, and on approval the
   action executes once by idempotency key, with its before state. Automatic writes record the same
   action and before state. Test runs (§10.4) never execute external actions.
6. Log `step_run`, `tool_call`, tokens, cost. Outputs of skills with `producesAlerts` must include
   `sources`; outputs without them are rejected.

### 9.6 Builder

- `draft-agent(input: { description, clientId? })` → `{ bundle: AgentBundle, summary, gaps: string[] }`:
  a new template, or (with `clientId`) a new client agent drafted for that client.
- The Builder receives the tool and skill registries (ids, descriptions, side effects, input/output
  schemas), the connectors and packs available (and, for a client, what that client has connected and
  enabled), event types, the existing templates (so it can say "start from template X" instead of
  drafting from nothing), and the JSON Schemas of `AgentBundle`. It may only select existing skills and
  tools; anything that needs a missing capability goes in `gaps` (e.g. "no card feed connector").
- `revise-agent({ agentId, fromVersionId, instruction })` → a new bundle draft + a human-readable diff.
  Works the same on templates and client agents (e.g. "for this client, skip the approval for invoices
  under $200").
- Server guards: Zod validation, workflow validation (§10.2), `permissions.mode='suggest_only'` for new
  agents, every write step left at `approval: 'required'`, saved as `draft`. The operator adjusts, tests
  and publishes.
- A client's request can be handed to the Builder as the instruction for that client's agent.

**The Builder as a conversation (v0.12).** A **session** (`builder_session`) holds a working bundle
for one agent (new or existing, template or client agent) or one skill. Each operator turn goes to
the Builder with the conversation so far, the registries, the automations, the client's people,
connections and packs, and answers with text and a list of **changes**, each a labelled entry
(`builder_turn.changes`: "+1 fork, step 4", "~1 step 3 setting · window 3 → 5 days"). Every entry can
be undone on its own: undo reverts that entry with core's three-way merge (base = the bundle after the
entry, ours = the working bundle, theirs = the bundle before it), so later entries stay; a conflict
refuses the undo and says why. Commands in the box are parsed by `packages/threads`' parser:
`/skill <id> <instruction>` (change that skill's step or this agent's settings for it; the skill's own
defaults never change from here), `/automation <slug>` (place an automation), `/trigger <kind> …` (add
or change a trigger). **Closest template:** `bundleSimilarity(a, b)` in core, a deterministic score over
skills, tools, trigger kinds and the step-kind sequence; shown as "Collections v2 · 62% alike" with an
offer to fork it instead. **Draft the new skill:** for a gap, the Builder drafts a `SkillDefinition`
(always `agent` mode, or a rules-first plan written as steps) and, from examples the operator attaches,
**test cases** with expected answers (§9.10; a client's examples stay that client's cases). **Save as
automation:** selected steps become an automation draft (§10.7), and the draft agent uses it in their
place. The guards are unchanged: every write step keeps approval on, new agents are `suggest_only`,
unknown skills and tools become gaps, ids are made by the server once. Save writes an ordinary draft
version (`author_type = 'builder'`); nothing is published from a conversation.

### 9.7 Platform agents (templates kind `platform`, seeded as v1 rows)

| slug | kind | skills |
| --- | --- | --- |
| `document-clerk` | platform | `docs.find-support`, `docs.extract` (forked into each client automatically when a client agent needs it) |
| `coordinator` | platform | `route-ask`, `review` (multi-agent review: collect views, write one summary with disagreements) |
| `supervisor` | platform | **Sloan** from v2 (v0.12, §9.8): `supervisor.triage`, `supervisor.report`, `supervisor.daily-check` (watches the client's runs, connections, logins, codes and waiting items; reads with `health.*`, asks with `agents.ask`; reports; `docs/plan.md` §1.28) plus `account.chat` (the client's conversation, with the `account.*` tools) |
| `builder` | platform | `draft-agent`, `revise-agent` (back office only; runs outside any client) |

### 9.8 Sloan, the account agent (v0.12)

**Decision: Sloan *is* the supervisor's client face.** One platform template (`slug = supervisor`,
identity name "Sloan", default service name "Sloan, your account agent"), one fork per client, free by
the existing billing rule (§1.32 of the plan). Template v2 keeps the supervisor's three watch workflows
and adds `chat`, started by `thread.message_posted` in an `account` thread. Existing clients get v2 as
a normal reviewed update (merge), not automatically. // DECISION: one free platform agent per client
rather than two, so watching and answering share one view of the account and one budget.

- **What it sees:** only what the portal shows its client (invariant 11): agents as services (status,
  stage, what each is doing now), runs as timelines with their receipts, the Desk and why each item
  waits (`account.explain_wait`: the facts that made a write need a signature: the step, the matrix,
  the stage, the person's autonomy, the approver rule), the directory, the knowledge base. Never a
  bundle, an instruction, a prompt, a cost or the vault; it has no connection bindings, and publishing
  refuses any connector tool or `external` tool on it.
- **What it does** (internal tools only, attributed to the person asking; the asking user comes from
  the thread, never from model input): `account.pause_agent` / `account.resume_agent` (as the client
  admin's own pause, §11.5; resume only what a client paused); `account.draft_change` (add a signer with
  limits, edit a person, change a contact) as a Desk item for the client admin to sign, applied by the
  same code as the portal's routes and refused if it would loosen anything (the approver rules'
  stricter-only check, invariant 8); `account.pass_to_lead` (a request or a new-agent idea as a
  `change_request`, linked to the thread); `account.pass_to_agent` (a request to an agent whose message
  trigger accepts Sloan, §10.8).
- **Who sees the conversation:** the person who started it, the client admins, and the operators
  serving the client, the lead first; operators may post as themselves. Sloan's replies are model text
  in a client thread: the only agent allowed to write one in v0.12, and only through `threads.post`
  with sources.
- **Limits:** mode `suggest_only`, memory per client, budget per message (8 steps, $0.30), stage `live`
  from the start (it writes nothing to a client's tool, §10.9).

### 9.9 Agent KPIs and the client view (v0.12)

A template declares what its client agents show the client, in the bundle (so it is versioned,
diffed, merged and travels with every fork): `AgentDefinition.clientView?: {kpis: Kpi[], panels:
Panel[]}`, optional with no default, so older bundles hash the same.

```ts
Kpi = { id, label: LocalizedText, period: '7d'|'30d'|'month'|'week', format: 'count'|'money'|'percent',
        measure: Measure }
Measure = { kind: 'runs', status?: 'succeeded'|'failed'|'any', workflow?: slug }
        | { kind: 'actions', tool?: toolId, connector?: id, status: 'done' }
        | { kind: 'sum'|'count', step: stepId, path: 'a.b' /*identifiers only*/, money?: boolean }
        | { kind: 'ratio', numerator: Measure, denominator: Measure }
Panel = { id, kind: 'kpis', kpis: kpiId[] } | { id, kind: 'pack_report', pack, report }
```

KPIs are computed in SQL over the client agent's **live** runs only (`run`, `step_run.output` at the
path, `external_action`), money as numeric. The portal gets labels and values, never the definition.
Pack reports keep working as panels. "Items matched on their own" is a ratio of two step-output sums;
"overcharges caught" a money sum. The Weekly Table and the Table read the same KPIs. In merges,
`clientView`'s lists are whole values (both sides changing them conflicts).

### 9.10 Test bench and skill tests (v0.12)

**Test cases** are data (`test_case`, §5.5): a name, an input, **fixtures** (the answers each read tool
gives, by tool and input), the expected output and a **matcher** (`exact`, `subset`, per-field
tolerances, a money tolerance, or a label field for precision). For a **skill**, a case runs the
skill's definition at the version under test with a tool port that answers only from the fixtures and
refuses everything else, writes included: tests "use saved examples only and never touch a client's
tools". For a **template**, a case is a trigger payload: it runs as a test run of the template's test
copy in the Sandbox (§10.4), never writing, and compares named step outputs. A **suite run** reports
pass rate, precision on the case's label field where set (e.g. "same" for matching), and cost per case
(the operator's; recorded on the suite run, not in a client's usage). **Publishing** a skill with
`require_tests` is refused unless the latest suite run of that exact version passed every required case
(422 `tests_failing`); the operator switches the requirement off only with a reason (logged).

**Client data in tests.** A case built from a client's records (the Builder's examples, "add this run
as a test") carries that client's `tenant_id`: it runs and shows only in that client's scope, never in
a shared skill's publish gate, and is never copied into a shared case (invariant 1). Shared skills are
gated on shared cases, written by the operator from synthetic data.

**The agent lab** (back office) lists templates (published, drafts never published, client-only agents),
each with its clients, versions behind (from "used by"), promote (built, §9.3) and its test bench.


---

## 10. Workflows

### 10.1 Workflow definition (one per workflow in an agent bundle, §9.1)

A workflow is a **structured list of steps** (owner's design): one trigger, then steps that run top to
bottom. A **fork** has ordered paths; the first path whose rules match runs, else "otherwise"; then the
workflow continues after the fork ("paths join here"). Steps can be nested inside fork paths and
`for_each` blocks. There are no free-form edges.

```ts
const Workflow = z.object({
  schemaVersion: z.literal(3),
  trigger: z.object({ id: z.string(), on:
    z.object({ type: z.literal('event'), event: z.string(), filter: Rules.optional() })
    .or(z.object({ type: z.literal('schedule'), cron: z.string(), tz: z.string().optional() /*client tz*/ }))
    .or(z.object({ type: z.literal('manual'), input: JsonSchema }))
    .or(z.object({ type: z.literal('command'), command: z.string() })) }),
  steps: z.array(Step),
});

Step = { id, kind, name, client?: { visible: boolean, label?: string }, ...config } where kind ∈
  'skill'     { skill: 'id[@v]', agent?: 'slug' /*default: owner*/, input: Template, settings?,
                approval?: Approval /*only if the skill's tools can write to a client tool*/ }
  'action'    { tool: 'id', input: Template, approval: Approval }   // changes a client tool; §9.5

Approval = { required: 'required' | 'not_required' = 'required', approver?: role | userId,
             timeout?: Duration, onReject: 'stop' | 'continue' = 'stop' }
  'person'    { mode: 'approve'|'ask', assignee: role | userId, title: Template, payload: Template,
                timeout: Duration, remindEvery?: Duration, channel?: 'inbox'|'email',
                onReject?: 'stop'|'continue', onTimeout: 'stop'|'continue'|'notify_operator' }
  'fork'      { paths: [{ id, name, when: Rules, steps: Step[] }], otherwise: { id, steps: Step[] } }
  'for_each'  { over: Template /*array*/, concurrency: number, steps: Step[] }
  'wait'      { for: Duration }
  'notify'    { channel: 'thread'|'email'|'digest', to?: Template, message: Template }
  'stop'      { status: 'succeeded'|'failed'|'cancelled' }

Rules = { match: 'all'|'any', rules: [{ field: Template, op: '>'|'>='|'<'|'<='|'='|'!='|'contains'|'in'|'is'|'exists',
                                         value: unknown }] }
```

Templates reference `{{trigger.<path>}}` and `{{steps.<id>.output.<path>}}`; inside a `for_each`,
`{{item}}` and `{{index}}`. Rules are what the builder shows ("Price change > 15% or Monthly impact >
$500"); they compile to JSONLogic, never `eval`. A `person` step's output carries `approved` and the
answer, so a later fork can branch on it. **Approvals are per step:** every step that can change a
client's tool carries an `approval` setting, `required` unless the operator changes it; the approver
defaults to the step's, then the agent's, then the client's setting. A `person` step adds a human
checkpoint anywhere else. `client` controls the portal's run timeline: by default
skill, action, person and notify steps are shown (with `label`, or the step name), and forks, loops and
waits are hidden.

**v0.12 additions to the workflow schema** (still `schemaVersion: 3`: every addition is optional or a
new union member, so stored bundles parse and hash the same):

```ts
'use_automation' { automation: 'slug@version' /*pinned*/, input: Template,
                   approvals?: { [innerStepId]: Approval } /*client agents only; §10.7*/ }
'person'  + choices?: [{ value, label: LocalizedText }] /*1–6 quick answers, mode 'ask'*/
          + assignee may be 'lead' (the client's lead, §4)
trigger.on adds (§10.8):
  { type: 'schedule', cron, tz?, skipHolidays?: boolean }
  { type: 'webhook', hookId, filter?: Rules, dedupeKey?: Template, rateLimit?: { max, per: 'minute'|'hour'|'day' } }
  { type: 'manual', input: JsonSchema, client?: { canRun: boolean, label?: LocalizedText } }
  { type: 'message', channels: ('email'|'sms'|'whatsapp'|'command'|'sloan')[], from: PeopleFilter,
    reply?: { confirm: LocalizedText } }
  { type: 'handoff', from: { agent: slug, workflow?: slug }, filter?: Rules }
Workflow + moreTriggers?: Trigger[]    /*other ways to start the same workflow, each with its own id*/
         + handoff?: { output: Template, sources?: Template }   /*what a successful run passes on*/
PeopleFilter = { relationships?: string[], tags?: string[], contactIds?: string[],
                 clientRoles?: ('client_admin'|'client_user')[] }
```

Each trigger starts one workflow; a workflow may have more than one (Remy's "Charge comes in" starts on
a new charge and on a texted photo). The run's `trigger` records which one fired (`trigger.id`,
`trigger.type`); validation types `{{trigger.<path>}}` against every trigger of the workflow: a field
some triggers lack is typed as optional (it may be empty), never an error.

**v0.13 additions** (still `schemaVersion: 3`; both optional):

```ts
'skill'            + model?: { id: string, maxTokens?: number }   /*mode 'agent' skills only; §10.11*/
'skill' | 'action' + review?: 'auto' | 'off' | 'always'           /*default 'auto': the agent's oversight decides*/
```

### 10.2 Validation (shared by builder and server, in `packages/core`)

A workflow can be saved as a draft with errors, but only a valid one can be test-run or published.
- One trigger; step and path ids unique across the bundle; every fork has at least one path; a
  `for_each` has at least one step.
- A template may reference only the trigger and steps that run **before** it on its own path. Outputs of
  steps inside a fork path or a `for_each` are not visible after it; a fork exposes which path ran.
- Every `skill` step's input satisfies the skill's input schema (typed from upstream outputs and the
  trigger payload); every skill and tool exists and is allowed by the owning agent (its skills plus
  `extraTools`).
- A step set to `approval: 'not_required'` must be one that writes to a client tool. For a client agent,
  at publish: no action's verb is `off` on the bound connection, and a step set to `not_required` whose
  connection only allows `approval` is an error ("this connection requires approval for updates"). The
  builder marks which write steps will run automatically and which need approval.
Errors carry the step id and field, so the builder can mark the step and the inspector field.

### 10.3 Executor

- One Cloudflare Workflow class, `RunWorkflow`, executes any workflow. Runs belong to a client agent:
  triggers start instances for the enabled workflows in the **live version of active** client agents:
  the senses router for `event` triggers (a client's event starts only that client's agents), a Worker
  cron for `schedule` triggers (each `cron` in the client's timezone unless overridden), the API for
  `manual` and `command` triggers. The instance id is the `run` id, so starting the same run twice is
  refused.
- The instance loads the client agent's pinned version and bindings and runs the steps in order, each
  with `step.do(stepId, ...)` so it is durable and retried. A fork evaluates its paths in order and runs
  the first match (or otherwise). Step outputs stay small (record ids); large data lives in Postgres.
- `person` steps and actions that need approval create an inbox item, then `step.waitForEvent` with a
  type unique to that item and the step's timeout. Resolving the item (`POST /api/inbox/:id/resolve`)
  sends that event to the run's instance.
- `for_each` runs its steps once per item, with bounded concurrency, step names `${stepId}:${index}:${childId}`.
- Every step writes a `step_run`. Run status and cost roll up to `run`.

### 10.4 Test runs

The operator test-runs any version, template or client agent, draft or live: a client agent against its
own client's data, a template against the **sandbox client** or (in test mode) against a chosen client's
data, choosing a trigger payload (a sample event, a recent real record, or manual input). A test run is
a normal run with `mode='test'`: it reads real data, writes its own steps and outputs, but **never
executes external actions** (they are recorded as proposed and shown as "would have done"), does not
emit events that start other workflows, and is hidden from the client portal. Internal writes made by
test runs are tagged with the run. A client agent can't be activated, and an update merge can't be
published, without one passing test run on that client.

### 10.5 The workflow builder, run view and merge view (back office)

Routes `/ops/templates/[slug]/workflows/[workflow]` and `/ops/clients/[id]/agents/[slug]/workflows/[workflow]` (one builder for
templates and client agents), following the owner's design (`docs/design/screens/5-workflow-builder.png`).
Operator only; clients never see it.
- **Header**: agent name, version badge (`DRAFT · V1`, `LIVE · V4`), counts ("10 steps · 2 forks · 4
  change your tools · 2 need approval"), Test run, Publish; tabs Overview / Workflow / Runs / Versions /
  Settings.
- **Add a step** (left): search; triggers; skills (the agent's skills first, then the library); actions
  grouped by tool ("change your tools"); people (approve, ask); logic (fork, for each, wait, notify,
  stop). Drag into the list or into a fork path, or press + to add at the end.
- **Steps** (centre): numbered cards with kind tag, name and tools; drag by the handle to reorder or move
  between fork paths; forks show their paths side by side with "Drop a step here" and "paths join here";
  badges for invalid, needs approval, runs automatically, hidden from client, and **customized for this
  client** (against the template).
- **Inspector** (right): the selected step's form, generated from the skill or tool input schema;
  template fields offer a picker of upstream outputs valid at this step; for steps that change a tool,
  an **Approval** control (on by default; switching it off is only offered where the client's connection
  allows it) with the approver; fork paths as ordered rule
  rows ("+ Add condition", "+ Add path", remove fork); settings with defaults (and, on a client agent,
  the template's value beside a customized one); the step's client timeline label and visibility.
- **Versions**: history with change notes and a step-by-step diff; rollback; on templates "Used by"
  (client agents, base versions, customizations); on client agents "Based on template vN" with "Update
  available", "Compare with template" and "Promote to template".
- **Merge view** (template update or promotion): the step list with each step marked added / removed /
  changed / moved per side; conflicts listed and marked, each resolved as ours, theirs, or edit; agent
  fields and settings side by side. Save produces the merge draft once every conflict is resolved and
  the merged workflow validates.
- **Run view** (`docs/design/screens/6-run.png`): "What it did" as a checklist of steps with status,
  summary, cost and links; "Changes to your tools" as now / after this change for each action, with
  approve, reject or edit where it waits; a link to the full log (inputs, outputs, tool calls). Live
  runs poll.

### 10.6 The client run timeline (portal)

Clients see a run as a timeline of its client-visible steps: label, status, time, a one-line summary
(`step_run.summary`, written by the skill or tool from its output; never model reasoning or prompts),
links to the records and documents it touched (`sources`), approvals and who gave them, and actions taken
in their systems. No costs, no instructions, no internal steps.

### 10.7 Automations (v0.12)

An **automation** is a reusable, versioned chain of steps, used in a workflow as one step. Rows
`automation` and `automation_version` (§5.5) follow skills exactly: shared (`tenant_id` null) or written
for one client, draft → publish → rollback, versions immutable.

```ts
Automation = { schemaVersion: 1, slug, name, description,
               input: JsonSchema, output: TemplateObject /*over its own steps*/,
               steps: Step[] /*any kind except use_automation; no trigger*/,
               requires: { skills: string[], tools: string[], connectors: string[] } /*computed on save*/ }
```

- **Decision: a new step kind, `use_automation`**, referencing a **pinned** version (`slug@version`).
  The use step's `input` is checked against the automation's input schema; its output is the
  automation's `output`, typed for later steps. Inside, steps read `{{input.<path>}}` and their own
  earlier steps; nothing outside the use step sees an inner step.
- **Validation** (core, shared): an automation version validates on its own (as a workflow with
  `input` in place of `trigger`); a use step validates its input and, at publish, that the agent's
  bindings cover the automation's connectors. Using an automation brings its skills and tools into the
  agent's allowed set. No automation inside an automation in v0.12.
- **Approvals:** inner write steps keep their own setting (on by default, invariant 8). A client
  agent's use step may set `approvals[innerStepId]`, by the operator only, with the same rule as any
  step (not required only where the matrix allows `auto` and the mode is `act`).
- **Executor:** at run load the pinned version's steps are expanded under the use step: node ids
  `${useStepId}/${innerStepId}` (inside `for_each`, `${stepId}:${index}:${childId}` as today), so names
  stay unique and durable and a retried run finds them. The use step writes its own `step_run`
  (`skill_ref = 'automation:<slug>@<version>'`, status from its children); the run view shows it
  expandable. Idempotency keys use the full node id.
- **Merges:** the use step is one step with a stable id; `automation`, `input` and `approvals` merge
  field by field like any step's config; inner steps are not in the bundle, so they never conflict.
  Moving a client agent to a newer automation version is a field change (a conflict only if both sides
  changed it).
- **Usage and health:** "used by" = live versions of templates and client agents that reference it
  (by scanning bundles, as skills do); the **clean-run rate** = the share of its use steps in live runs
  of the last 30 days that succeeded with no step retried.

### 10.8 Triggers: six kinds (v0.12)

| Kind | Starts when | Notes |
|---|---|---|
| Schedule | A cron in the client's time zone | `skipHolidays`: skips US federal holidays (observed dates, core `holidays/us.ts`) and the client's own dates (`tenant.settings.holidays`). // DECISION: US federal only, owner may add calendars |
| Event | A platform, connector or pack event (as today) | Filters as rules |
| Webhook | A delivery to one of the client's inbound hooks (§6.6) | Sugar over `webhook.received` for that hook: rules on the body ("run only if"), `dedupeKey` (a template over the body; the run id is uuid v5 of agent, workflow and the key, so a repeat starts nothing), `rateLimit` (deliveries over it start no run and are counted on the hook) |
| Manual | A person presses Run | The operator always may; with `client.canRun`, the client admin and signing client users may too, from the portal, with a form generated from `input` (validated with Zod-from-JSON-Schema on the server) |
| Message | Something is sent to the agent | `email` to the agent's own address; `sms`/`whatsapp` to a number bound as its channel; `command`: `/<agent>` in a client thread (§11.2); `sloan`: a request Sloan passes. Only senders matching `from` (People) start it; anyone else gets a polite fixed reply (to email only when it passes DMARC) and the lead is told. The message is data for step 1: its text through a read tool (`inbound.get`), its attachments as documents; it can't change the agent's rules or access (invariant 9). `reply.confirm` is a fixed template sent within a minute, behind no approval because it goes only to the sender, from the same channel, and says only that it was received |
| Handoff | Another agent of the same client finishes a live run successfully | The finishing run emits `run.succeeded` with its workflow's `handoff.output` and `sources`; the router starts matching handoff triggers in the same client only, never the same agent, at most 3 handoffs deep (`depth` in the payload) |

**The agent's address** (v0.12): `<agent>.<client label>-<client id in base32>@<EMAIL_FORWARDING_DOMAIN>`
(`<agent>` is its command name, below), received by the Worker's `email()` like forwarding. The
prototype's `<agent>@<client>.agents.mezonas.com` needs Email Routing per client subdomain and a
Cloudflare API token to add them, and sits beside the code service's agent domain; it waits for the
owner (`docs/plan.md` §7). **The agent's command name**: the first word of its identity name, lower
case (`/remy`), unique among the client's live agents (else its slug), checked at activation.

**Who may start it** comes from People (`PeopleFilter`), matched on the sender's contact (email, phone,
WhatsApp) or the posting user's membership. **Last fired** and the guards per trigger are answered from
`run.trigger` (no new table).

### 10.9 Go-live stages (v0.12, owner 2026-11-06)

A client agent's `stage` (§5.5): **bench** → **trial** → **signoff** → **live**.

| Stage | Runs | Writes | Leaves when |
|---|---|---|---|
| bench | Test runs only (`run_status` draft or testing); Sandbox or the client's data, never writing | Never | The activation check passes (bindings, a live version, a passing test run since the last publish) and the operator starts the trial (today's Activate) |
| trial | Live runs on the client's data | **Every write needs a signature**, whatever the step, matrix or mode say: the gate treats the agent as `suggest_only` | At least `minDays` (default 14) **and** at least `minRuns` (default 25) finished live runs since the trial started (whichever comes later); the operator may change both, logged. Then the hourly pass moves it to signoff |
| signoff | As trial | As trial | The client admin approves "<agent> going live" on the Desk (a summary: runs, changes made, signed, rejected). A rejection sends it back to trial with the reason, to the lead |
| live | Live runs | As the step, matrix, grant and mode say | — |

- The stage is read fresh at every write decision (like the matrix), through one core helper
  `effectiveMode(definition, stage)`, used by the gate, reach out and inbound call answering.
- **Skips:** the operator may move an agent forward past a stage with a reason (an `agent_change` row
  `kind: 'stage'` and the audit log); moving back is always allowed. An agent whose live version has
  no write to a client's tool (Sloan, the supervisor) goes from bench to live with the logged reason
  "no writes". Agents live before v0.12 are backfilled `live`.
- A new publish or a merged template update keeps the stage. Billing is unchanged: an agent is billed
  while `run_status` is active, trial and signoff included (owner may revisit).
- **Running live on a past event (v0.12 fix, from the API end-to-end test).** A client's first
  invoice often arrives while its agent is still on the bench: the test run uses it, and its event was
  swept with no agent to start, so nothing ever runs it live (re-uploading the same file emits
  nothing). The operator may start a live run of an agent in trial, signoff or live on one of the
  client's past events (`POST /api/ops/agents/:id/run-event {eventId}`, the events the test-run picker
  already lists, never a test run's): the router's own matching decides which workflows it starts, the
  run id is the router's (uuid v5 of event, agent and workflow), so an event that already started that
  agent starts nothing again (409 `already_ran`), and writes behave as in any live run (in trial, every
  one is signed). Recorded in the run's trigger (`replayedBy`) and `agent_change`.

### 10.10 Run controls and model calls (v0.12)

- **Retry from the failed step:** a new run (`retry_of`, `resume_from`) of the same version and trigger.
  Steps before the failed one are not run again: their outputs are copied from the original run
  (`step_run.status = 'succeeded'`, summary "reused"). For each write step, an action of the original run
  that was **approved and not done** with the same input (hash) is executed under its **original**
  idempotency key, its approval carried (`approved_via: retry_of`), if it was signed less than 72 hours
  ago and the gate still allows it now (matrix, grant, stage, release); otherwise it is proposed again.
  An action already `done` is never redone. Only failed live runs are retried; the operator retries.
- **Cancel:** the operator ends a queued, running or waiting run: the Workflow instance is terminated,
  the run and its open steps become `cancelled`, its open items `expired`, its proposed actions
  `rejected` ("run cancelled"). An action already `executing` finishes first (the cancel waits for it).
- **Replay as a test run:** the same version and trigger payload as a **test run in the same client**
  (never writing). // DECISION: not in the Sandbox: copying a client's payload into another client
  would move its data across clients (invariant 1). The prototype's "Replay in Sandbox" means this.
- **Group by error:** failed runs grouped by an error key (`error.key` = tool or step kind + code, written
  on failure; older runs grouped by `error.code`), with counts, clients and agents.
- **Saved views:** an operator's named filters for the runs list (`saved_view`).
- **Model calls:** every model call of a run is a `model_call` row (provider, model, tokens, cost,
  duration, stop reason) with its request and answer stored in object storage under the client's
  prefix (card numbers redacted, §16), shown on the back office's run page only, never in the portal.
- **Run lists** (both surfaces) take one typed filter, `RunFilter` (core): agents, statuses, time range,
  how it started, who signed, which tool it changed, attempts, cost (operator only), error key, client,
  template, version. Plain-words questions (§11.6) produce the same filter.
- **Short ids:** a run is shown as `R-` and the last 6 hex characters of its id, as records are.

### 10.11 Run oversight and a model per step (v0.13, owner 2026-11-06)

The workflow stays the operator's fixed plan (§10.1). The client agent that owns it now oversees its
runs: work that needs no judgment runs as code, work that needs some runs on the model it needs, and
when a step goes wrong the agent looks at it and decides what happens next, inside the plan.

| Work | Runs as | Examples |
|---|---|---|
| Clean | Code, no model | Fork rules, `action` steps, `tool`-mode skills, waits, notifications |
| Reading | A `task` skill on its own default model, usually fast | Reading an invoice into JSON, classifying, adjudicating a match |
| Judgment | An `agent` skill on the agent's model, with its instructions and memory | Analysis, drafting a message in its voice, an exception |
| Oversight | The agent, on its oversight model | Why did this step fail, and what now; is this output right before we write |

**Which model a step runs on.** By the skill's mode (§9.2): a `task` skill on its own `model`, an
`agent` skill on the agent's `definition.model`. A `skill` step may override either with
`model: { id, maxTokens? }` (a big document on a stronger model; one agent's drafting on Opus).
Validation: the id is one `packages/llm` knows and prices; `model` on a `tool`-mode skill step, or on
an `agent`-mode skill definition, is an error; a `task` skill without `model` is an error. The builder labels the choices Fast (Haiku), Standard (Sonnet),
Strong (Opus) and OpenAI. Each call is a `model_call` row with its model (§10.10), so the run view shows
cost per step. A merge treats `model` as one step field. // DECISION: a model id on the step, like the
agent's, not named tiers; tiers are the builder's labels.

**Oversight settings** (`definition.oversight`, §9.1; absent means `off`, so agents built before v0.13
run as today):
- `review`: `off`; `failures` (review failed steps); `checkpoints` (failures, plus checkpoint steps
  after they succeed); `all` (every skill and action step after it finishes).
- `model`: what oversight reasons on; default the agent's model. This is the agent's "brain"; steps are
  its hands.
- `maxPerRun` (default 3 interventions) and `maxCostUsd` (default $0.25, on top of the agent's budget).
- A step may set `review: 'off' | 'always'` (default `auto`: follow the agent).
- New agents, Builder drafts and new templates start with `review: 'failures'`. // DECISION: not on
  for existing agents, so their runs, costs and recorded fixtures don't change unasked.

**Reviewed steps.** `skill` and `action` steps, and the inner ones of an automation (§10.7) under their
expanded node ids. Forks, loops, waits, notifications and person steps fail as today. A **checkpoint**
is computed by validation, never guessed by the model: a skill step whose output a later write step's
input template references (an `action`, or a skill step whose tools can write), or any step with
`review: 'always'`.

**What the agent sees.** One model call with no tools, given: the step's definition and its skill's or
tool's description and input schema; the step's resolved input; its output, or its error with the
error key (§10.10) and attempt count; the plain summaries of the run's earlier steps; for a failure,
the last 5 failures of the same step in this client agent's runs with the decisions taken. Inputs,
outputs, errors and summaries go in as data in a tool-result block, never in the instructions
(invariant 9). Nothing from the vault, another client, or another agent's prompts.

**Decisions** (a Zod schema in core, `oversight/decision.ts`; the agent answers through `finish`):

| Decision | After | Effect |
|---|---|---|
| `continue` | A checkpoint | The run goes on. |
| `retry {after?}` | A failure | The step runs again with the same input after `after` (default 30 s, at most 1 hour): timeouts, rate limits, a connection that came back. |
| `retry_with {input}` | Either | The step runs again with a corrected input, which must validate against the skill's or tool's input schema; recorded field by field (`input_before`, `input_after`). |
| `ask {question}` | Either | An inbox item to the step's approver (default the client's team: the agent's approver, the client's setting, else the client admin; P-6) in the platform's words with the agent's question; the run waits. Approved: continue (a checkpoint) or retry (a failure). Rejected: the step's `onReject`. |
| `stop` | Either | A failure fails the run; a checkpoint cancels it. The agent's note goes to the operator. |

Any decision may carry a `proposal {summary, change}`: a lasting fix in plain words (add a trim step,
raise a timeout, add a vendor alias). It becomes an operator inbox item (`kind: 'review'`, subject
`oversight_proposal`), fingerprinted like the supervisor's findings so the same fix is proposed once.
The operator applies it in the builder or the Builder conversation; nothing changes a bundle on its own.

**Guardrails.**
- **The plan is fixed.** Oversight never adds, skips, reorders or edits steps, never changes an
  approval, matrix, grant, mode or stage, and calls no tools (invariants 3, 4, 9). The decision schema
  has no field for any of these.
- **Writes.** A `retry_with` on a write step is a new input, so the gate decides again (§9.5) and an
  approval given for the old input never carries; in trial and signoff every write is signed, as
  before. A write step is retried only when its external action never reached `executing` (refused,
  invalid, or failed before the call). One that reached the client's tool and failed is a `stop` with
  an operator item, because its before state may no longer hold. A `retry` keeps the action's
  idempotency key; a `retry_with` uses `${nodeId}:o${seq}`.
- **Limits.** At most 2 interventions per step and `maxPerRun` per run, within `maxCostUsd`. Past a
  limit, or when the answer fails validation, the step fails exactly as it does without oversight. A
  failed review never hides the step's own error.
- **Durable.** Each review is `step.do('${nodeId}:oversee:${seq}')` and each retry
  `${nodeId}:retry:${seq}`, so a replayed instance finds the same decision and never decides twice.
  Each decision is an `oversight_decision` row (§5.6) with `agent_version_id` and the record ids it
  relied on (invariant 10).
- **Test runs** run oversight too, so the bench shows it, and write nothing, as any test run. Its
  calls are recorded and replayed like any model call (`LLM_MODE=replay`).
- **Run controls** (§10.10) are unchanged; a run the operator retries starts its intervention count
  at 0.

**Who sees what.** The back office's run view shows each decision, the agent's note, the input change,
the model and the cost. The portal's run timeline shows only the platform's words for each decision, in
the client's language ("Tried again", "Corrected the vendor name and tried again", "Asked Dana"), never
the agent's note, a prompt or a cost (invariant 11). A run that still fails emits `run.failed` with the
agent's diagnosis attached, so Sloan's triage (§9.8) can use it instead of making its own model call.

**Usage.** Oversight's model calls count in the run's cost, the client's usage and credits like any
other (§13). `failures` costs nothing on a clean run; `all` roughly doubles a run's model calls.

**Why not a graph library.** Considered and declined (owner, 2026-11-06): LangGraph and similar graphs
are defined in code, while our workflows are versioned data, built in the builder and merged three
ways by stable step ids, so we would compile our schema into a graph anyway; Cloudflare Workflows
already keeps runs durable through approvals that wait for days, and a second checkpoint store would
split the truth about a run and hold client data outside RLS (invariant 1); model calls must go through
`packages/llm` for replay, cost and redaction. Oversight adds the one dynamic choice that matters, a
decision at a failed or checked step, without free-form edges.

**Built in** (`docs/plan.md` §1.53, §1.54): the decision schema, checkpoint computation and portal
words in `packages/core`; an `OversightPort` the executor calls (`packages/workflows`), so the
executor stays free of models; the review itself in `packages/agents/src/runtime/oversee.ts`, its rows
written from `src/log/`; the wiring in `apps/api`.

### 10.12 Conversations with people (P-4, owner 2026-11-07)

A **conversation** is one step in which the agent talks with one person on one channel until a goal
is met: "clarify this purchase request with whoever sent it until the item list is right", "work out
with the owner where to buy this item", "clear up this quote with the vendor's rep". Reach out (§1.25
of the plan) asks one question and waits for one answer; a conversation keeps going, turn by turn,
inside fixed bounds. The workflow is still the operator's fixed plan (§10.11): the conversation is one
step of it, and the agent can't change who it talks to, the channel, the goal or the limits.

**Shape.** A built-in skill, `comms.converse` ("Talk with a person"), run only as a workflow step
and carried out by apps/api, like `comms.reach-out`. // DECISION: not a new step kind: a skill step
already has an approval setting, a per-step `model`, oversight, the builder's skill inspector and the
executor's `waiting` and `approval` outcomes, which already let one step wait any number of times.

```ts
ConverseInput = {
  to: { role } | { contactId: Template } | { userId: Template },  // a directory contact, or a client user
  channel: 'whatsapp' | 'sms' | 'email' | 'portal',                 // contacts: the first three; users: portal
  goal: string /*fixed*/, result: JsonSchema /*fixed, an object*/, confirm: boolean = true,
  opening: string /*fixed: what the first message says*/, whatsappTemplate?: { id, variables },
  about: string[] /*record ids: sources*/, data?: Template /*record data, given to the model as data*/,
  limits: { maxMessages = 6 /*1–12*/, waitPerReply = '1 day' /*≤ 7 days*/,
            deadline = '3 days' /*≤ 14 days*/, maxCostUsd = '0.50' /*≤ 5*/ },
}
ConverseOutput = { outcome: 'completed' | 'handed_over' | 'opted_out' | 'declined' | 'not_allowed' | 'not_sent',
  result /*typed by result*/, confirmed, who, channel, messages, replies,
  transcript: [{ direction: 'out'|'in', text, at, sourceId }], sources, reason, costUsd }
```

`goal`, `result` and `opening` are fixed inputs (the step's own text, never a template: they become
instructions). Validation types `{{steps.<id>.output.result}}` from `result`, so later steps and forks
use the answer like any typed output.

**Turns.** Each turn is one model call on the agent (agent-mode work: its instructions, memory notes
and the client's language; the step's `model` overrides the agent's). The model sees a platform
preamble, the goal and the brief as instructions; the transcript and the record's data arrive in a
tool-result block, never as instructions (invariant 9). It answers through one forced tool, `turn`:

| Answer | Effect |
|---|---|
| `ask {message}` | The message is sent; the step waits for the reply. |
| `confirm {message, result}` | The proposed result (validated against `result`) and a message asking the person to confirm it. |
| `done {result, confirmed, closing?}` | Ends the conversation as `completed`. With `confirm`, accepted only after a `confirm` was answered and `confirmed` is true; `closing` is a last thank-you, sent under the same rules. |
| `give_up {reason}` | The agent can't get there: hand-over (below). |

There is no field for a recipient, channel, approval or limit, so nothing the person writes can change
them. An answer that fails its schema fails the turn; the step fails, and oversight (§10.11) may retry
it, which redoes only that turn.

**Sending.** Each message to a contact is a reach-out of its own: a `reach_out` row with the
message as fixed text in the contact's language, the conversation's one channel, and the reply wait.
So everything reach out checks holds per message: opt-out, consent, the binding's conditions, the
person's autonomy (`off`), the agent's bound channel, the matrix (`off` refuses) and grant, a human
release, quiet hours (a message is held until they end) and the idempotency key
(`<run>:<node>:m<n>:reach:0`, sent once). A conversation counts once toward the person's daily cap.
**WhatsApp's 24-hour window:** the opening goes as `opening.whatsappTemplate` when the person hasn't
written in 24 hours; without one it ends `not_allowed` ("outside WhatsApp's 24-hour window and no
approved template") and nothing is sent. A later message outside the window (an approval that waited
too long) ends the conversation the same way, handed over. **Portal:** with a client user, the
messages are posted in the agent's thread (`agent` subject, "Message Pia"), addressed to that user.

**Approval.** On by default (invariant 8), in two layers:
- **The conversation** is signed once, like a reach-out's plan: who, channel, goal, limits and the
  opening message as written ("Talk with Dana on WhatsApp to confirm the item list: up to 6 messages,
  a day per reply, done within 3 days. First message: …"), routed by the approver rules. It runs
  unsigned only under the usual three conditions, and never when the person's autonomy on the
  channel is `approval`.
- **Each later message** goes under that signature, except when the person's autonomy on the channel
  is `approval` or the agent isn't live yet (bench, trial, sign-off): then each message is its own card, "Message 3
  of up to 6 to Dana on WhatsApp", with the text, the conversation so far (their words quoted and
  marked as theirs), the goal and why it waits ("Dana's WhatsApp messages need approval"). Approving
  sends exactly that text; declining ends the conversation `declined` (the step's `onReject`). Only
  the operator sets a person's channel to "on its own" (§1.42 of the plan).

**Replies.** Matched by reach out's matcher, since each message is an open reach-out: a text,
WhatsApp or email reply ends that message's row as `replied` and wakes the run. **One at a time per
person:** a conversation doesn't start while the person has another open reach-out or conversation
(`not_allowed`, "already waiting on them"), no reach-out or other conversation starts to someone in an
open conversation, and the matcher gives a reply to an open conversation message on its channel
first. Messages they send between ours are read at the next turn and don't start the agent's message
trigger while the conversation is open. STOP ends it `opted_out`. In the portal, the user's next
message in the agent's thread while the step waits on them is the reply.

**Ending.** `completed` (the goal met, confirmed when asked); `opted_out` (STOP); `declined` (the
approver turned the conversation or a message down); `not_allowed` (it couldn't start: no consent, no
channel, busy, outside the window). Every **limit** (messages, no reply in time, the deadline, cost) and
`give_up` **hands over**, never fails silently: an inbox item of the kind a person step makes
(`request`, subject `conversation_handover`) to whoever approves the conversation, the client's team
by default (the operator only when the client's approvals are set to us), with the
goal, what is known and the transcript; the step waits on it like a person step. The person answers
with the result (checked against `result`) and the run goes on with `handed_over`; or drops it,
which is the step's `onReject`.

**Stepping in (P-6).** While it runs, the conversation's approver (from the portal's run page) or the
operator (from the back office's, with a reason) can **take it over**: the message waiting for a reply or
for approval is ended unsent, the agent sends nothing more, and the step hands over to that person, who
answers with the result as with any hand-over. Or **end** it: the step's `onReject`. Both go on the
transcript ("Mezonas took the conversation over: …"), with no model call. A message waiting for its own
approval can be **edited** by whoever approves it: the edit becomes the message, so what is approved is
exactly what is sent, through the same checks (length, consent, quiet hours, the WhatsApp window; card
numbers redacted); the agent's text is kept and the run pages say who edited it.

**Durable.** The opening turn runs in the step's own durable step, turn *n* in the wait's
`…:wait:<k>:resume` step or an approval's `…:approval:<k>:resume` step: stable names, so a replayed
run takes the stored outcome. Inside one, the turn's answer is stored on its message row before the
message is sent, so a retried durable step neither calls the model twice for a turn nor sends twice.

**Storage.** No new table. The messages are `reach_out` rows (subject `converse:<run>:<node>`, one per
message, their reply as untrusted data) and the lines reach out already writes in the contact's
thread; portal messages are `message` rows in the agent's thread; each turn's model call is a
`model_call` row and its cost is the step's.

**Who sees what.** The back office's run page shows the transcript with each turn's model and cost.
The portal's run timeline shows the client's side of the conversation (the messages and when), never
a prompt, a model or a cost (invariant 11). Test runs send nothing: the opening is written (one model
call) and shown as what would have been sent (`not_sent`).

**Builder.** "Talk with a person" in the palette; the inspector asks who, the channel, what to find out
(the result's fields), the first message, the WhatsApp template, the limits and the model. Validation
is core's, one function for the builder and the server (invariant 4).

### 10.13 Message translation (P-7, owner 2026-11-08)

A client may keep its work in one **working language** (`docs/plan.md` §1.69). It is off until the
operator or the client admin sets one, so a client without it works exactly as before.

**Incoming.** A text, a WhatsApp message (Twilio or Meta), an email reply to a reach-out or to an
agent's address, and a client user's thread message are stored as today. After that commit, a job
reads the new ones, detects each one's language in code (common words and letters of the six
languages; a model only when the code isn't sure, in the same call), and translates those in another
language into the working language (thread messages: into English, for the back office). The hourly
cron runs the same job, so one that was lost is caught. A person can turn it off per contact.

**Outgoing.** When a person writes the words for a contact (the Desk's message edit, §11.1), they may
ask for them in the contact's language. The translation becomes the message to sign; the card shows
both texts; what is signed is exactly what is sent. The lead's replies in the client's thread can be
translated into the working language the same way, stored beside the lead's words. Agents already
write to contacts in their language, and fixed templates carry a text per language, so neither is
translated again.

**Where it lives.** Detection, settings and limits are pure code in `packages/core/src/translate/`.
The translation call is `comms.translate`: one model call on the client's chosen model (default the
classification model), the text handed over as a tool result, the answer checked with Zod. Agents
reach it as a tool and a skill step (`packages/agents`); the background job, the routes and the views
are in `apps/api/src/translate/`. Each outcome is a `message_translation` row (§5, migration 0034),
insert only, beside its original (a raw record, a thread message or a reach-out's message) with the
model, tokens, cost and, where an agent made it, the agent version, run and step.

**Rules.** The original is never changed (invariant 3). The translation is data: it reaches agents
only as a tool result and is never parsed for commands or keywords (invariant 9). A day's model
translations stop at the client's limit; HIPAA mode allows only covered providers; long texts are cut
at 6,000 characters and marked. Translations made outside a run are the client's usage
(`usage_platform_daily`), those in a run are the step's. The portal shows the translation with the
original one click away, never a model or a cost (invariant 11). Documents, invoices, call audio and
live calls are never translated; a language outside the six is stored as unknown, not guessed.

---

## 11. Inbox and threads

- Inbox kinds: `approval`, `review` (a pack's review, e.g. match review), `request` (ask a person for a
  document or answer), `extraction_review`, `external_action` (approve a write to a connected tool:
  shows the tool, the target record, the change, and the record's current state), `change_request`
  (a client asks the operator for a change or a new service; it goes to the operator's request queue and
  is resolved by linking the client agent or template versions made for it).
- Who sees what: clients see their own items (client_users only those assigned to them); operators see
  every item in the clients they serve, plus the operator inbox (delegated approvals, escalations,
  budget hits, failed runs).
- **Stepping in (P-6).** The client's items are the client's to answer. The operator may step into any
  open one of a client they serve, with a reason: approve, reject or answer it (the client's own resolve
  path, so a change is still approved once and written once with its before state), or pass it to a
  client role or person. Never a request for a code (only the client's code releases it), and never the
  go-live sign-off. The item and the portal read "We stepped in" (a person's action, copper) with the
  reason, never our person's name; the route's audit row names the client; the client's lead thread gets
  a line, which the lead-message notification carries to the person it waited on.
- Resolving an item writes `resolution`, emits `inbox.resolved` and sends the event to the waiting run.
- Every run creates or appends to a thread for its subject (transaction, catalog item, vendor, week).
  Messages carry `sources` (record ids) rendered as links, and an `audience`: operator-only notes never
  appear in the portal.
- People can post in a thread and invoke an agent's skills with `/skill args` (parsed server-side into a
  `skill` step on that agent). `agents.ask` goes through `coordinator.route-ask`, which enforces
  `canCommand` and the thread `step_budget`.

### 11.1 The Desk (v0.12)

The Desk is the portal's inbox under the prototype's name: what waits on the person (signs, questions,
messages), what is in progress and what was done this week. Same `inbox_item` rows and resolve path;
these additions:

- **Why it needs you.** Every approval records, when proposed, the facts that made it wait
  (`payload.whyApproval`: `step` (approval required on the step), `matrix` (the connection or the
  entity allows only approval), `grant`, `mode` (suggest only), `stage` (trial or sign-off), `person`
  (the recipient's autonomy), and the approver rule that routed it), from core's `explainWrite`, over
  the gate's own inputs. Client-safe: only these codes and names, never instructions.
- **Questions with quick answers.** A person step with `mode: 'ask'` and `choices` shows them as
  buttons; the answer is the chosen `value`, and a fork can branch on it.
- **Not now.** `snoozed_until` (later today, tomorrow 8:00, Monday 8:00 in the person's time zone, or a
  time): the item leaves "Waiting on you" until then and notifications skip it. It never moves the
  step's timeout; a snooze past the item's due time is cut to an hour before it.
- **Edit before signing.** The approver may change a drafted action's input before signing it: only
  fields the tool's display marks editable (core `ToolDisplay` fields gain `editable: true`), never
  `fixedInputs`, guards, ids or version tokens. The edit is validated by the tool's Zod input, the
  connector's proposal checks run again (e.g. an itemize total), and the approver rules route it again:
  if the edited change would go to someone else, it is refused (409 `reroute`). `external_action.input`
  stays the agent's version, `edited_input` holds the person's, and execution uses the edit. Both show
  on the run page. P-6: a message waiting for approval (a conversation's or a reach-out's) is edited the
  same way, `{input: {message}}` (§10.12).
- **Sign part of a batch.** Items one step proposed together (a `for_each` of actions, or a skill that
  proposes several) share `batch_key = <run id>:<step id>`. `POST /api/inbox/batch/resolve {batchKey,
  approve: [ids], reject: [ids], note?}` resolves each in one transaction ("Send 2 of 3"); each item's
  step follows its own outcome (`onReject`). Items not named stay open.
- **Undo.** After an approval the run is told only once the **undo window** has passed (default 60
  seconds, `tenant.settings.approvals.undoSeconds`, 0 switches it off, at most 300): resolving sets
  `deliver_after`; the every-minute cron delivers the event of every resolved item whose
  `deliver_after` has passed (the existing durable resume, `docs/plan.md` §1.5), so the write runs 60
  to 120 seconds after signing. Before that, `POST /api/inbox/:id/undo` puts the item back to `open`,
  the action back to `proposed`, and appends `{undoneAt, by}` to `payload.undos`; the run, still
  waiting on its original event, never knew. The executor's check before waiting treats an item inside
  its window as not yet resolved. Nothing is written outside the external-action path (invariant 8).
  Rejections are delivered at once.
- **Signing needs a session** (owner, 2026-11-06): a text or email links to the item on the Desk; a
  reply to a message never signs.

### 11.2 Threads, the lead and `/commands` (v0.12)

`packages/threads` (empty until now) owns threads: their store, who may read and post, read state,
posting, and `/command` parsing; `apps/api` wires it, and agents reach it through `threads.post` and
`threads.read` (platform tools; `threads.read` returns messages as data, invariant 9).

| Thread (`subject_type`) | One per | Who reads and posts |
|---|---|---|
| `lead` (`subject_id` = the client) | client | every member of the client; the client's operators, the lead first |
| `account` (a Sloan conversation; `created_by`) | conversation, several per person | its person, the client admins, the operators |
| `agent` (`subject_id` = the client agent) | client agent ("Message Pia") | every member of the client; the operators |
| `run`, `contact`, record subjects | as today | as today |

- Messages carry `sources` (record ids of this client, checked) and `audience` (operator-only notes
  never reach the portal). People post text; agents post through `threads.post`. Read state is
  `thread_read`. Posting emits `thread.message_posted` (`threadId`, `subjectType`, `subjectId`,
  `messageId`, `senderType`, `senderId`, `command?`; never the text).
- **`/commands`.** A message that starts with `/<word>` is parsed (core `parseCommand`) into a
  `command` message. In a client thread, `/<agent command name>` (§10.8) starts that agent's message
  trigger with channel `command`, the rest of the message as its data; an unknown command gets a
  system answer ("No agent called /remy here") and starts nothing. In the back office, `/skill args` on
  an `agent` thread runs that skill as a test run of the agent (operators only, as §11 designed).
- **The lead.** `tenant.settings.lead.userId` (§4), set on the client's settings page. The lead thread
  is the client↔lead conversation ("Message Ana", "Reply to Ana"). **Lead checks** are person steps
  with `assignee: 'lead'`: the item is assigned to the lead's user (`assignee_role = 'operator'`), and
  the client's timeline says "Ana checks new matches". With no lead set it goes to the operator role.
- Model-written messages in a client thread: Sloan (§9.8), and a conversation step with a client user
  (§10.12). Other agents answer a message through
  their workflow (a fixed `reply.confirm`, a notify step), never free model text.

### 11.3 Notifications (v0.12)

Mezonas tells people that something waits for them; it never sends the thing itself (`docs/plan.md`
§1.35's rule): a count, a short fixed sentence in the person's language and a link to the Desk, the
Weekly Table or the page to act on.

| Kind | To | When |
|---|---|---|
| `items_waiting` | each person with open items assigned to them (or to their role, signers only) | at most once an hour per person, only for items new since the last one, never in their quiet hours; snoozed items skipped |
| `weekly_table` | every member (client setting `weeklyDigest`) | Monday 7:00 in the client's time zone |
| `reconnect` | the client admin and whoever connected it | a connection goes to `error`; again only after 24 hours; or when the operator presses "Ask the client to reconnect" (once a day per connection) |
| `credits` | the client admin | credits ran out, or another block of 2,500 was used beyond them (§11.5) |
| `lead_message` | client members on a lead message; the lead on a client's | unread for 10 minutes |
| `signoff` | the client admin | an agent waits for its go-live sign-off (§10.9) |

- **Sender (decision):** a platform mail service in `apps/api` over the existing `resend` client, from
  `Mezonas <notify@RESEND_FALLBACK_DOMAIN>` with Mezonas' key, as human-release codes already send. It
  is not an agent tool and not an external action: it writes nothing to a client's tool and carries no
  record content. Texts go from the client's own Twilio number (its subaccount, as release codes do)
  to a person whose directory entry has a phone with text consent and no STOP, only if the person
  turned texts on; otherwise email only.
- **Preferences:** the client's (`tenant.settings.notifications`, as built) and each person's
  (`tenant.settings.user_notifications[userId] = {email: bool, sms: bool}`; no migration).
- **Outbox:** each send is a `notification` row keyed by `dedupe_key` (e.g. `items:<user>:<hour>`), so a
  pass run twice sends once. A cron pass every 5 minutes builds and sends them; a failed send is
  retried twice, then marked `failed`.

### 11.4 The Table and the Weekly Table (v0.12)

- **The Table** (the portal's home, `GET /api/table`): each client agent as a service with what it is
  doing now (status, current step "3 of 6 · match items", how long it has waited on you), this week's
  figures (runs done; changes to your tools, automatic and signed; each agent's KPIs for the week,
  §9.9), the latest client-visible step summaries across agents, the top three Desk items, and the
  lead's latest message. All from rows the portal already reads; never cost.
- **The Weekly Table** (`weekly_table`): a draft is made Friday 17:00 in the client's time zone so the
  lead can write the **note**, the **decisions** (title, body, options, sources) and **next week** in
  the back office; on Monday at 7:00 the stats are computed again for the week just ended (Monday to
  Sunday, the client's time zone), the row is marked `sent` and the notification goes out. A week with
  no note still goes. **Setup** items come from code: agents in bench or trial missing a connection
  ("Connect your Amex"). The client **replies to a decision** in the lead thread, linked to it
  (`reply.messageId`).
- **PDF (decision):** `GET /api/weekly/:weekStart/pdf` renders the stored row on request with `pdf-lib`
  (pure JavaScript, no browser, works in Workers) in its standard Helvetica (WinAnsi covers the six
  languages); nothing is stored. Browser Run is not needed.

### 11.5 Client controls (v0.12)

- **Pause and resume.** The client admin pauses one agent (`POST /api/services/:id/pause {reason,
  until?}`) or all of them (`POST /api/services/pause-all {reason, until?}`; Sloan stays on so it can
  help), and resumes them. The reason is required and logged (`agent_change`, `kind: 'pause'`, with the
  side). `agent.pause` records side, who, why and until; the minute cron resumes a pause whose `until`
  has passed. A client resumes only a pause made by the client side; the operator can resume any and
  sees the client's reason. Pausing stops new runs; running ones finish (as today).
- **Run now.** A workflow whose manual trigger has `client.canRun` shows on the service with its form
  (`GET /api/services/:id/run-forms`); `POST /api/services/:id/workflows/:slug/run {input}` starts it
  for the client admin and signing client users, validated against the trigger's schema and recorded as
  started by that person. Only active agents in trial, signoff or live.
- **If credits run out** (`tenant.settings.billing.onCreditsOut`): `continue` (default, "add credits and
  tell me": work goes on, extra credits are billed at the credit price as today, and the client admin
  is told each time another 2,500 beyond the included credits are used) or `pause` (when the month's
  credits used reach the included credits, every billable agent is paused with side `system`, reason
  `credits_out`, and the client admin is told; choosing `continue` or the next month resumes them).
  Checked on the hourly billing pass. Sloan is never paused for credits.

### 11.6 Search and plain-words questions (v0.12)

- **⌘K search:** `GET /api/search?q=` (portal, the client's own) and `GET /api/ops/search?q=&client=`
  (operator, clients served): up to 5 hits each of services and agents, runs (short id, agent or
  summary), records (transactions, vendors, receivables: number, memo, name or amount), people and
  organizations (the directory's ranking) and documents (file name, vendor, number). Plain SQL filters
  per kind inside the request's scope (RLS and `tenant_id`); no new index (lists are per client). The
  portal's hits never include templates, bundles or costs.
- **Plain words** ("bills Iris entered over $5,000"): `POST /api/runs/ask {text}` and the ops twin. The
  model (Haiku) gets the question as data and must call `run_filter`, whose input is `RunFilter`
  (§10.10); the answer is checked with Zod, shown back as chips and run through the normal list
  query. Never SQL, never a field outside the filter. Its cost is the client's usage under its account
  agent (Sloan).

### 11.7 Exports (v0.12)

- The client's **data export** (the terms' promise, available for 30 days after leaving) and **"Export
  for your accountant"** (runs and changes, CSV or ZIP) are built by the export stream running outside
  these milestones (`docs/plan.md` §8); this design doesn't repeat them.
- **The client's audit export:** `GET /api/audit/export.csv?from=&to=` (client admin): the client's own
  `audit_event` rows, its people by name, Mezonas' people as "Mezonas" except the lead, by name. **A
  run's audit trail** (`GET /api/runs/:id/audit`): who opened the run or its items and who signed, in
  order, from the same rows and the resolutions. Clients never see sign-ins or cross-client rows.

---

## 12. Business areas, packs and the Materials pack

### 12.0 Business areas (v0.15, owner 2026-11-07)

Agents are many; the data they share is organised by **business area**, not by agent. A business
area is a domain whose data must outlast a run and be read by several agents: purchasing, sales,
receivables. Each area is a **pack** (§12.1): its tables, the tools that read and write them, its
skills, events, template agents and screens. An agent never maps to tables. It reaches an area only
through the area's tools (invariant 2), and it can use more than one area.

**The layers of data.** Only the area layer grows with use cases.

| Layer | What it holds | Defined by | Changes when |
|---|---|---|---|
| Platform | Clients, people, agents and versions, skills, workflows, runs and steps, approvals, external actions, inbox, audit, usage | The platform, once (§5.3) | The platform changes |
| Raw data | Whatever a connector brings in, as JSON (`raw_record`), append-only | No schema | Never: a new connector writes new entity types |
| Shared business records | Records several areas need: `vendor`, `transaction` and `transaction_line`, `document` and its extraction, `receivable`, the directory's people and organizations, `alert` | §5.2, small and stable | Rarely: only for a record every area needs |
| **Area tables** | An area's own data: what only we know about the client's business (a catalog, matches, price history, decisions) | The area's pack, by migration | A new area, or an area's next version |
| Client extras (designed, §5.3) | A few fields on a record (`ext`) or a small list for one client (`custom_record`), checked against a `schema_extension` | Data, no code | The operator adds them; not built in v1 |

**Rules for areas.**
1. **Agents use areas through tools, many to many.** Several agents share one area (an intake agent
   writes the catalog that a price-watch agent reads). An agent may use several areas, and its
   tools come from its skills and `extraTools`, as today.
2. **Areas build on the shared records and the directory.** They never keep their own copy of a
   vendor, a transaction or a person; their tables point at the shared rows.
3. **The client's tools stay the system of record.** Synced data lands in `raw_record` first and is
   normalised from there. Area tables hold what the client's tools don't: matches, a master list,
   history, our decisions. A change to a client's tool is an `external` tool and an
   `external_action` with approval (invariant 8). A change to an area's tables is an `internal`
   tool: logged and attributed to the agent version, with no approval.
4. **Per client.** A client uses an area once it is enabled for them (`tenant_pack`). Every area
   table carries `tenant_id` with forced RLS, and what an area learns (aliases, catalog items,
   prices) is that client's only (invariant 1).
5. **When a use case needs new storage.** Data used only within one run stays in step outputs. Data
   that lives in the client's tool is synced into raw data and changed through the tool. Data that
   must last, be searched or be joined across a whole domain becomes an area: a new pack, or the
   next version of an existing one. A few fields or a small list for one client are client extras.
6. **An area's version moves with the platform.** Its migrations join the one shared sequence, in
   their own PR, additive only, keeping the previous Worker working.

**The areas.**

| Area | Status | Built on | Its own data | Agents on it |
|---|---|---|---|---|
| **Purchasing** | **In v1 now (v0.15).** The shared records are built; the Materials pack is ported from its M8 branches (M34) | `vendor`, `transaction`, `document`, QuickBooks, upload and email | The Materials pack (§12.2–§12.4): `catalog_item` (the master list of what the company buys), `item_alias` (each vendor's name or SKU for it), `item_match` (each invoice line's decision), `price_observation` (price per item, vendor and date, in a standard unit). The shared `alert` table (§5.2) arrives with it | Invoice intake, the Bill clerk, price watch, purchasing (built in the Agent lab); later reorder and vendor comparison |
| **Sales** | Designed for, not built | The directory's organizations and people, a CRM connector (Zoho CRM and Podio built, HubSpot next) | Deals and their stages, activities, the rep who owns an account, territories; what only we know (follow-up due, score, next step), fed from the CRM's raw records | Lead follow-up, pipeline hygiene, rep coaching. Agents change the CRM through its connector's tools, behind approval |
| **Receivables** | Partly built (`receivable`, v0.12) | QuickBooks invoices, customers and payments | Collection attempts and promises to pay, when a collections use case needs them | Collections (Cole) |
| **Marketing** | **Being built (owner, 2026-11-08; outside the v1 scope below until v0.16).** Measurement first (M43, `docs/plan.md` §1.72); plan in `docs/marketing-plan.md`. Mezonas is its first client | A client's website (first-party, cookie-free measurement), later Search Console and Bing | The Marketing pack: `site`, `site_event`, `site_visit`, daily totals; later search figures, content and the claims list | Weekly site report, titles and descriptions, article drafts, forum watch, social posts (templates the pack ships) |

**Finding the same thing across sources.** Matching is deterministic first, model second, person
last (invariant 7): normalise, look up known aliases, parse attributes by category, gather
candidates (same key attributes, then similar text with `pg_trgm`, then similar meaning with
`pgvector` when an embedding exists), let a small model choose among a few candidates, and send
anything unsure to a person, whose answer becomes an alias. The search lives in our Postgres; there
is no separate vector database. Embeddings stay optional in v1 (§20): when they are added, the
provider (Anthropic has none: OpenAI or Voyage) is a vendor named in `packages/core/src/compliance`
(invariant 14).

**Access to an area (designed for, not built).** Today an agent reaches an area when its skills or
`extraTools` include the area's tools, and a template that needs an area declares it
(`requiresPacks`), so it can't be forked into a client without the area enabled. The next step is
an **area grant** like a connection's (§6.9): per agent, `read` and `write` per area and per entity,
with the strictest of the grant, the step and the mode winning, and the client admin able to tighten
it. Tools would declare their area and entity (`ToolSpec.area`, `ToolSpec.entity`), and the gate
would check them like a connection's matrix.

**Client extras (designed for, not built).** For data too small to be an area: `schema_extension`
(a JSON Schema per client and target, versioned like a skill) checks the `ext` fields of a record or
a `custom_record` collection. Templates would declare the collections they need, forking creates
them in the client, template updates merge schema changes, and agents reach them through generic
`records.*` tools that check the schema and the client. Not in v1 (§1 "Out").

### 12.1 Pack contract

```ts
const PackManifest = z.object({
  id: z.string(), name: z.string(), version: z.string(), description: z.string(),
  requiresConnectors: z.array(z.string()).default([]),
  events: z.array(EventTypeSpec),           // sense types it emits, with payload schemas
  tools: z.array(ToolSpec),
  skills: z.array(SkillDefinition),
  templates: z.object({ agents: z.array(AgentDefinition), workflows: z.array(Workflow) }),
  screens: z.array(z.object({ route: z.string(), title: z.string(), roles: z.array(z.string()) })),
});
```
A pack is a package exporting its manifest, tool handlers, Drizzle schema and API routes. `apps/api`
registers it; `apps/web` has its screens under `src/packs/<id>/`: client reports in the portal, and
operator views in the back office. Installing a pack adds its templates (agents with their workflows) once,
as template v1 rows the operator edits like any other. Enabling it for a client inserts `tenant_pack`
(its tables start holding that client's data) and allows forking its templates into that client.

### 12.2 Materials pack

Tables:
```
catalog_item(id, tenant_id, category, canonical_name, attributes jsonb, standard_uom,
             embedding vector(1024) null, created_by, merged_into_id null, created_at, ext jsonb)

item_alias(id, tenant_id, vendor_id, vendor_sku null, description_hash null, catalog_item_id,
           source /*auto|human*/, created_at)
  unique(tenant_id, vendor_id, coalesce(vendor_sku,''), coalesce(description_hash,''))

item_match(id, tenant_id, doc_line_id, catalog_item_id null, decision /*matched|new_item|unsure*/,
           confidence, method /*alias|rules|llm|human*/, hinge_attribute, candidates jsonb,
           decided_by /*agent_version_id or user_id*/, decided_at)

price_observation(id, tenant_id, catalog_item_id, vendor_id, observed_on, unit_price_std, qty_std,
                  standard_uom, doc_line_id, transaction_id)
  index(tenant_id, catalog_item_id, vendor_id, observed_on desc)
```

Tools: `materials.catalog.search` (none), `materials.catalog.create_item` (internal),
`materials.match_line` (internal), `materials.prices.record` (internal), `materials.prices.history`
(none), `materials.prices.compare_vendors` (none).

Skills: `materials.match-lines` (tool mode, over a document's lines; settings `match_confidence_auto` 0.90),
`materials.review-merge`, `materials.record-prices` (tool mode), `materials.price-check` (agent mode;
settings `price_change_pct` 5, `vendor_spread_pct`, `creep_pct`; produces alerts),
`materials.vendor-compare`, `materials.materials-list`, `materials.weekly-digest`.

Events: `materials.line.matched`, `materials.line.needs_review`, `materials.match.decided`,
`materials.price.observed`, `materials.price.changed`.

Purchasing (pack 0.2.0, docs/plan.md §1.67): requests to buy, quotes and purchase orders.
```
purchase_request(id, tenant_id, requested_by_contact_id | requested_by_user_id, channel
                 /*email|sms|whatsapp|portal|agent*/, raw_record_id, status
                 /*open|quoting|quoted|ordered|cancelled|closed*/, needed_by, fulfillment
                 /*delivery|pickup*/, deliver_to, notes, order_connector, order_external_id,
                 ordered_at, run_id, agent_version_id, created_at, updated_at)
purchase_request_line(id, tenant_id, purchase_request_id, line_no, catalog_item_id null,
                      description, qty, unit, notes, match_method /*alias|rules|chosen*/, candidates)
quote_request(id, tenant_id, purchase_request_id, vendor_id, status
              /*draft|sent|received|declined|expired*/, sent_at, sent_via, due_at, received_at,
              answer_raw_record_id, answer_document_id, currency)  unique(purchase_request_id, vendor_id)
quote_line(id, tenant_id, quote_request_id, purchase_request_line_id, catalog_item_id, description,
           qty, unit, unit_price, currency, unit_price_std null, standard_uom null, lead_time_days,
           available)
price_observation + raw_record_id, raw_line_id   (a QuickBooks bill line as a price's source)
```
Tools (all `none` or `internal`): `materials.request.{create,get,list,update,add-lines,match-lines}`,
`materials.catalog.match-text`, `materials.vendors-for-items`, `materials.frequent-items`,
`materials.quote.{create,mark-sent,get,record,compare}`, `materials.po.document` (a PDF stored as
the client's document, source `generated`), `materials.backfill-from-bills`. Skills: a tool skill
over each the agent uses directly, and two `task` skills on the small model, `materials.read-request`
and `materials.read-quote`. Report: `requests`.

Reports (portal): Price watch (`/reports/materials/prices`), Catalog (`/reports/materials/catalog`),
with CSV export. Match review in the Inbox (`review` kind). Back office: the same views for any client,
plus catalog merge.

Template **Pia** (`purchasing`, functional; default portal service name "Material cost monitoring"): skills `docs.find-support`, `docs.extract`,
`materials.match-lines`, `materials.record-prices`, `materials.price-check`, `materials.vendor-compare`,
`materials.weekly-digest`; extra tools `qbo.attachable.upload`, `gmail.draft.create`, `gmail.label.apply`
(all approval).

Template workflows (step lists in Pia's bundle; each client's fork can change them):

**purchase-intake** (trigger: event `transaction.created`)
1. skill `docs.find-support` (QBO attachments, then forwarded email and uploads; Gmail once connected)
2. fork "No document": person ask (client admin: forward or upload the invoice; remind 2d; timeout 5d →
   notify the operator) and action `gmail.draft.create` to the purchaser when Gmail is connected
3. skill `docs.extract`
4. fork "Totals don't add up": person approve (extraction review)
5. skill `materials.match-lines` (auto-match ≥ `match_confidence_auto`)
6. fork "Any line below threshold": person ask (match review for those lines)
7. skill `materials.record-prices`
8. skill `materials.price-check` (raise alerts with evidence)
9. action `qbo.bill.update_lines` / `qbo.purchase.update_lines` (itemize; approval on)
10. fork "Document not yet attached in QBO": action `qbo.attachable.upload` (approval on)
11. fork "Document from Gmail" (after the MVP): action `gmail.label.apply` "Processed"

**weekly-price-review** (trigger: schedule Mondays 7:00 client timezone)
1. skill `materials.weekly-digest` (changes, creep, vendor spread, new surcharges, dollar impact)
2. person approve (the operator reviews the digest)
3. notify digest to the client (email + portal report)

### 12.3 Item matching

Deterministic first, model second, human last.

1. **Normalize** `raw_description`: uppercase, strip punctuation noise, expand abbreviations from a
   global dictionary plus per-tenant/per-vendor learned abbreviations (`BB`→`BALTIC BIRCH`,
   `MEL`→`MELAMINE`, `PLY`→`PLYWOOD`, `S2S`, `FAS`).
2. **Alias lookup**: `item_alias` by (vendor, vendor_sku) then (vendor, description_hash). Hit → matched,
   method `alias`, confidence 1.0.
3. **Parse attributes** with category parsers (regex + unit tables), falling back to an LLM parse with a
   strict schema:
   - Sheet goods: material, face/species, core, thickness (`3/4"`, `.75`, `18MM`, `23/32` → nominal
     `3/4in` with actual mm kept), width×length (`4X8`, `48X96`, `4'X8'` → `48x96in`), grade (`B/BB`,
     `BB/BB`, `CP`, `A1`), finish.
   - Hardwood: species, thickness quarters (`4/4`, `8/4`), grade, surfacing, UOM board foot.
   - Mouldings/edgebanding: profile or species, width, thickness, length or roll size, UOM linear foot.
   - Hardware: brand, model/SKU, finish, pack size.
   - Finishes/adhesives: brand, product line, sheen, container size.
4. **Candidates**: catalog items in the same category whose **key attributes** are equal; then top-k by
   trigram (+ embedding when present) as a backstop.
5. **Adjudicate** (Haiku): line + parsed attributes + top 5 candidates → `{ decision, catalog_item_id?,
   confidence, hinge_attribute }`.
6. **Route**: confidence ≥ `match_confidence_auto` → matched; `new_item` with high confidence → create
   catalog item; else match review in the inbox. Human decisions write `item_alias(source='human')`.
7. **Hard rules** (code, not model): never match when any key attribute differs; never compare prices
   across different `standard_uom` without a conversion rule.

UOM conversion table in `packages/core/units`: sheet, each, box(n), board foot, linear foot, roll(n ft),
gallon, quart. Pack sizes parsed from description (`BX/10`, `100PK`).

Golden tests: `fixtures/matching/*.json` with line pairs labeled same/different. Target ≥ 95% precision
on "same" at the auto threshold.

Text with no document line (a request line as asked, a QuickBooks bill line) is matched by steps 1–4
and 7 only: an alias (with no vendor, every vendor's description alias when they agree), then exactly
one candidate equal on every key attribute. Anything else keeps its candidates for a person; no model
adjudicates it. Only the bill backfill creates new items (step 6's rule).

### 12.4 Pricing and alerts

- `materials.prices.record`: `unit_price_std = unit_price / conversion(uom_raw → standard_uom)`; freight
  and surcharges are not folded into unit price (landed cost computed separately: allocate freight by
  line amount share).
- Alert rules (thresholds from the skill settings on the agent version):
  | kind | rule |
  | --- | --- |
  | `price_jump` | change vs last observation for same item+vendor > `price_change_pct` |
  | `price_vs_avg` | vs trailing 90-day average > `price_change_pct` |
  | `vendor_spread` | same item, same month, another vendor cheaper by > `vendor_spread_pct` |
  | `price_creep` | cumulative change over 90 days > `creep_pct` with no single jump |
  | `new_fee` | surcharge type not seen on prior invoices from that vendor |
  | `outlier` | qty or unit price > 3 MAD from item history |
- `dollar_impact` = change × trailing 90-day quantity.
- Deduplicate: one open alert per (kind, item, vendor).
- Quotes are not prices: price history stays what was paid. `materials.quote.compare` compares a
  request's quotes in code: per line in the item's standard unit through a conversion rule (an
  offer with no rule compares only with offers in its own unit, never across currencies), totals per
  vendor for the lines as asked, lead times against needed-by, and a suggested vendor or split with
  its reasons and sources.
- `materials.backfill-from-bills` turns synced QuickBooks bill lines into prices, one per bill line
  (raw record and line id), idempotent, per the item's standard unit (bill lines carry no unit).

---

## 13. Usage, cost and observability

- Every model call records tokens and cost on its `step_run` (cost computed at write time, including
  failures and retries); runs roll up cost; `usage_daily` rolls up per client and client agent, and the
  back office can also roll up per template (across its forks).
- **Cost is operator-only.** The back office shows model cost and usage per client, per client agent and
  per template over time, to price the service; the portal shows activity and outcomes, never cost.
- Budgets: per agent version (`maxSteps`, `maxCostUsd` per skill invocation) and per thread
  (`step_budget`). Hitting one escalates to the operator inbox rather than failing silently.
- Every run, step, tool call and external action is queryable from the back office run view; nothing an
  agent did is visible only in logs.
- **Reading no agent asked for (v0.12 fix).** Uploads and forwarded mail are read in the background
  with no agent, so their model cost reached neither usage nor credits. Decision: that reading is the
  **client's** usage, not an agent's. Each `doc_extraction` records its tokens and cost at insert; the
  rollup puts background readings (no `agent_version_id`) into `usage_platform_daily` (§5.5), and the
  credit conversion counts that table's measures like `usage_daily`'s. An agent's own `docs.extract`
  stays on its step as today. An agent's `documents` count becomes the documents its live runs read or
  cited (`docs.*` sources), so an agent working on a document read in the background counts it.

### 13.1 The command center (v0.12)

`GET /api/ops/command-center?client=` over the clients served, and `GET /api/ops/feed?since=&client=`
(polled every 5 seconds):

| Figure | Definition |
|---|---|
| Agents live | Active client agents (not test copies), with their clients |
| Running now | Runs `queued` or `running`, and their steps in flight |
| Need us | Escalations (below), and how many have been blocked over 6 hours |
| Waiting on clients | Open client-assigned items, and the oldest's age |
| Runs today | Live runs created today (UTC), and the share **clean**: succeeded with no step retried |
| Model spend today | Sum of `step_run.cost_usd` and background readings today (UTC), and per run |
| Escalations | Open items assigned to the operator or the lead, failed live runs not retried or cancelled, connections in `error` that an agent uses, and low-confidence readings, each with **blocked since** (oldest cause), sorted by how long the client has been blocked |
| Low confidence | Extractions today under `ops.lowConfidence` (default 0.80), grouped by client agent and template version |
| Client health | Over 7 days: clean-run share, the client's median response time (item created → resolved, client-assigned items), and open escalations. **Good** when clean ≥ 95%, response ≤ 24 h and no escalation; **bad** when clean < 85%, response > 72 h or 3+ escalations; else **watch** |
| Live feed | Client-visible step summaries, writes done, signatures, failures and Sloan's drafted changes, newest first, across clients served |

All figures are computed from existing rows in the request's scope; no table is added. The agents table
groups by client, template or status and shows each agent's state now, its last 24 runs and its cost
over 7 days.

---

## 14. API (Hono routes under `/api`)

Two route families. `/api/ops/*` is the back office (role `operator`, scoped to the clients they serve,
`app.operator` on). `/api/*` is the portal (client roles, one client). The OAuth callbacks, the QBO
webhook are shared.

```
Back office (operator)
  Clients      GET  /api/ops/overview                     (needs attention across clients)
               GET  /api/ops/clients                      POST /api/ops/clients
               GET  /api/ops/clients/:id                  PATCH /api/ops/clients/:id/settings
               POST /api/ops/clients/:id/invites          PUT  /api/ops/clients/:id/connectors {offered: [...]}
               POST /api/ops/clients/:id/connectors/:connector/remind   (email: "connect X" → portal page)
               POST /api/ops/clients/:id/packs/:pack/enable
  Connections  GET  /api/ops/clients/:id/connections      PATCH /api/ops/connections/:id {config, permissions}
               POST /api/ops/connections/:id/sync
  Skills       GET/POST /api/ops/skills                   POST /api/ops/skills/:id/versions
               POST /api/ops/skills/:id/versions/:vid/publish
  Agents       (templates: GET/POST /api/ops/templates; client agents: GET/POST /api/ops/clients/:id/agents;
                both then addressed as /api/ops/agents/:id)
               POST /api/ops/agents/draft {description, clientId?}
               GET  /api/ops/agents/:id (+ versions, lineage)   POST /api/ops/agents/:id/versions (save draft)
               POST /api/ops/agents/:id/versions/:vid/publish   POST /api/ops/agents/:id/rollback {versionId}
               POST /api/ops/agents/:id/revise {instruction, fromVersionId}
               POST /api/ops/workflows/validate {workflow}   GET  /api/ops/catalog/events
               POST /api/ops/agents/:id/versions/:vid/test-run {workflow, payload, clientId?}
  Lineage      POST /api/ops/templates/:id/fork {clientId, version?, slug?}
               GET  /api/ops/templates/:id/used-by        (client agents, base versions, behind, customizations)
               GET  /api/ops/agents/:id/customizations    (diff: live vs base template version)
               GET  /api/ops/agents/:id/update-preview {toVersion}   (three-way merge result + conflicts)
               POST /api/ops/agents/:id/update {toVersion, resolutions}  (creates the merge draft)
               POST /api/ops/agents/:id/promote {changes?, resolutions}  (creates a template draft)
               POST /api/ops/agents/:id/detach            POST /api/ops/agents/:id/relink {templateVersion}
  Operation    PATCH /api/ops/agents/:id/operation {bindings?, approver?, serviceName?, serviceDescription?}
               POST /api/ops/agents/:id/activate|pause|retire
               POST /api/ops/agents/:id/run {workflow, input}   (manual trigger)
  Runs         GET  /api/ops/runs?client=&status=&agent=&since=   GET /api/ops/runs/:id (steps, tool calls, cost)
  Inbox        GET  /api/ops/inbox                        POST /api/ops/inbox/:id/resolve
               POST /api/ops/clients/:id/inbox/:itemId/step-in {action, reason, ...}   (P-6)
               POST /api/ops/clients/:id/runs/:runId/conversations/:stepRunId {take_over|end, reason}
  Requests     GET  /api/ops/requests                     POST /api/ops/requests/:id/resolve {links}
  Usage        GET  /api/ops/usage?client=&agent=&template=&from=&to=

Portal (client)
  Overview     GET  /api/overview                         GET  /api/services (active client agents as services)
  Reports      GET  /api/reports/activity?from=&to=       GET  /api/reports/:pack/:report (+ .csv)
  Runs         GET  /api/runs?service=&status=            GET  /api/runs/:id (client timeline)
  Inbox        GET  /api/inbox?kind=&status=              POST /api/inbox/:id/resolve
               POST /api/runs/:id/conversations/:stepRunId {take_over|end, reason?}   (P-6: its approver)
  Connections  GET  /api/connections (offered connectors, status, permissions, used by, forwarding address)
               PUT  /api/connections/upload/senders {allowed: [...]}   (who may forward)
               POST /api/connections/:connector/authorize (client admin signs in)   DELETE /api/connections/:id
               PATCH /api/connections/:id/permissions (tighten only)
  Documents    POST /api/uploads (multipart)              GET  /api/documents/:id (signed URL)
  Requests     GET/POST /api/requests {subject?, text}
  Settings     GET/POST /api/users (invite)               PATCH /api/settings/notifications

Shared         GET  /api/connections/qbo/callback         GET  /api/connections/gmail/callback
               POST /api/connections/qbo/webhook      (Intuit's webhook; plan §1.30)

MCP (operators; plan §1.34; outside /api)
               POST /mcp                             (Streamable HTTP; bearer token from WorkOS AuthKit)
               GET  /.well-known/oauth-protected-resource[/mcp]   GET /.well-known/oauth-authorization-server
```

**v0.12 routes** (each stream's own contract file `packages/core/src/api/<area>.ts`; `docs/plan.md` §8):

```
Back office (operator)
  Lifecycle    POST /api/ops/agents/:id/stage {to, reason?}       PUT /api/ops/agents/:id/trial {minDays, minRuns}
               POST /api/ops/agents/:id/run-event {eventId}       (run live on a past event, writes behind approval)
               POST /api/ops/agents/:id/resume                    (any side's pause)
  Notify       POST /api/ops/connections/:id/remind               (ask the client to reconnect)
  Weekly       GET  /api/ops/clients/:id/weekly                   PUT /api/ops/clients/:id/weekly/:weekStart {note, decisions, nextWeek}
  Threads      GET  /api/ops/clients/:id/threads?subject=         GET/POST /api/ops/threads/:id/messages
               PUT  /api/ops/clients/:id/lead {userId}
  Runs         GET  /api/ops/runs?<RunFilter>&groupBy=error       GET /api/ops/runs.csv?<RunFilter>
               POST /api/ops/runs/:id/retry   POST /api/ops/runs/:id/cancel   POST /api/ops/runs/:id/replay
               GET  /api/ops/runs/:id/model-calls                 GET /api/ops/model-calls/:id (body)
               GET/POST /api/ops/saved-views                      DELETE /api/ops/saved-views/:id
  Connectors   GET  /api/ops/connectors                           PUT /api/ops/connectors/:id {status, defaultPermissions, note}
  Automations  GET/POST /api/ops/automations   POST /api/ops/automations/:id/versions   POST …/versions/:vid/publish
               POST /api/ops/automations/from-steps {agentId, versionId, stepIds, slug, name}
  Tests        GET/POST /api/ops/tests?target=   PUT/DELETE /api/ops/tests/:id   POST /api/ops/tests/run {targetKind, targetId, versionId}
               GET  /api/ops/tests/runs/:id                       GET /api/ops/lab
  Triggers     GET  /api/ops/agents/:id/triggers                  (each trigger, guards, last fired)
  Command      GET  /api/ops/command-center   GET /api/ops/feed?since=   GET /api/ops/search?q=   POST /api/ops/runs/ask {text}
  Client view  GET  /api/ops/agents/:id/client-view               (the client's KPIs and panels, as the portal shows them)
  Builder      POST /api/ops/builder/sessions {kind, agentId?, skillId?, clientId?}   GET /api/ops/builder/sessions/:id
               POST /api/ops/builder/sessions/:id/turns {text}    POST …/turns/:turnId/changes/:changeId/undo
               POST /api/ops/builder/sessions/:id/save
  Platform     POST /api/ops/platform-templates/:slug/install {version}   (installs a seeded platform template version)

Portal (client)
  Table        GET  /api/table                                    GET /api/weekly?week=   GET /api/weekly/:weekStart/pdf
  Desk         POST /api/inbox/:id/snooze {until}   POST /api/inbox/:id/undo   PUT /api/inbox/:id/edit {input}
               POST /api/inbox/batch/resolve {batchKey, approve, reject, note?}   GET /api/team (who signs what)
  Threads      GET  /api/threads?subject=   POST /api/threads {subject: 'account'}   GET/POST /api/threads/:id/messages
               POST /api/threads/:id/read
  Controls     POST /api/services/:id/pause {reason, until?}   POST /api/services/:id/resume   POST /api/services/pause-all
               GET  /api/services/:id/run-forms                   POST /api/services/:id/workflows/:slug/run {input}
               GET  /api/services/:id/view                        (KPIs and panels)
  Runs         GET  /api/runs?<RunFilter>   POST /api/runs/ask {text}   GET /api/runs/:id/audit
  Records      GET  /api/records?kind=&q=&offset=&limit=          (the client's records list, v0.12 fix)
  Search       GET  /api/search?q=
  Settings     PUT  /api/settings/my-notifications {email, sms}   PUT /api/billing/credits-out {onCreditsOut}
               GET  /api/audit/export.csv?from=&to=
```

**v0.13 routes** (operator only; `packages/core/src/api/oversight.ts`):
```
  Runs         GET  /api/ops/runs/:id gains `oversight` (decisions per step: action, note, input change,
               model, cost)
  Oversight    GET  /api/ops/oversight?agent=&client=&since=&action=   (decisions and open proposals,
               with counts by action and by step, for the agent lab)
```
Oversight settings and a step's `model` and `review` change through the existing bundle edits (a new
version, like every edit). The portal's run timeline shows only the platform's words for a decision.

**v0.14 routes** (WhatsApp capture, §6.12; `packages/core/src/api/conversations.ts`):
```
Back office (operator)
  Capture      GET  /api/ops/clients/:id/conversations          GET/PUT /api/ops/clients/:id/conversations/default
               PUT  /api/ops/clients/:id/conversations/:conversationId/capture {capture, reason?}
               GET  /api/ops/clients/:id/conversations/:conversationId/changes
               GET  /api/ops/clients/:id/conversations/:conversationId/messages
               POST /api/ops/clients/:id/conversations/:conversationId/messages/:rawRecordId/download
Portal (client admin)
  Capture      GET  /api/conversations          PUT /api/conversations/:id/capture {archive?, attachments?}
               GET  /api/conversations/:id/changes    GET /api/conversations/:id/messages
               POST /api/conversations/:id/messages/:rawRecordId/download
```
A capture save over a newer `updatedAt` is 409 `stale`; an `agentId` that isn't this client's agent
with a `whatsapp` message trigger is 422 `invalid_agent`; download now on a conversation whose
setting refuses the attachment is 409 `capture_off`. The portal's answers carry no agent bundle,
prompt, cost or Twilio link.

The MCP server's tools read through the back office's own route handlers, scoped to the clients the
operator serves; its one write (`feedback_resolve`) takes a preview call and a confirm call.
All bodies validated with Zod. The route contract declares each route's roles; middleware sets
`app.tenant_ids` (and `app.operator` for operator sessions) from the session (§4). No portal route
returns an agent bundle, instructions, prompts, model output outside `summary`, or cost; a contract test
enforces both.

---

## 15. Screens → routes

**Back office** (`/ops`, role `operator`)

| Screen | Route |
| --- | --- |
| Overview: needs attention across clients (failed runs, operator inbox, requests, connections to fix, template updates waiting), usage this month | `/ops` |
| Clients: list with health; new client (onboarding) | `/ops/clients`, `/ops/clients/new` |
| Client: agents (status, based on, customizations, update available), connectors offered and their health, permissions and configuration (incl. Gmail query), users, packs, settings, runs, usage | `/ops/clients/[id]` |
| Client agent: editor, versions, customizations vs template, update/merge, promote, bindings, approver, test runs, activate/pause | `/ops/clients/[id]/agents/[slug]` |
| Client agent workflow builder | `/ops/clients/[id]/agents/[slug]/workflows/[workflow]` |
| Templates: list; new (scratch or Builder); editor, versions with release notes, "Used by" | `/ops/templates`, `/ops/templates/new`, `/ops/templates/[slug]` |
| Template workflow builder | `/ops/templates/[slug]/workflows/[workflow]` |
| Merge view (update or promotion) | `/ops/agents/[id]/merge?from=&to=` |
| Skills library | `/ops/skills`, `/ops/skills/[id]` |
| Packs | `/ops/packs` |
| Runs across clients; run view | `/ops/runs`, `/ops/runs/[id]` |
| Requests queue; operator inbox | `/ops/requests`, `/ops/inbox` |
| Usage and cost | `/ops/usage` |

**Client portal** (`/`, client roles)

| Screen | Route | Role |
| --- | --- | --- |
| Overview: your services, what they did this period, what needs you | `/` | all |
| Service: what it does (plain language), recent runs, related reports | `/services/[id]` | all |
| Reports: activity, plus pack reports (Materials: Price watch, Catalog), CSV export | `/reports`, `/reports/materials/prices`, `/reports/materials/catalog` | all |
| Runs: timeline list and detail | `/runs`, `/runs/[id]` | all |
| Inbox: approvals, reviews, requests | `/inbox` | all (filtered) |
| Connections (owner's design, screen 2): offered tools, sign in, reconnect, disconnect; what agents may do in each tool (view; tighten only); used by | `/connections` | client_admin (sign in, change), client_user (view) |
| Requests: ask the operator | `/requests` | all |
| Settings: users, notifications | `/settings` | client_admin |

Match review (Materials, in the Inbox): invoice line with page thumbnail, parsed attributes, top
candidates side by side with attribute diffs highlighted; actions Match / New item / Skip.

**v0.12: the owner's prototype.** The owner redoes the screens from the prototype separately; v0.12
builds the API each screen needs and keeps today's screens working. Where each prototype screen gets its
data:

| Prototype screen | API |
|---|---|
| The Table (client home) | `/api/table`, `/api/threads?subject=lead`, `/api/search` |
| Agent page (Pia) | `/api/services/:id`, `/api/services/:id/view`, `/api/runs?agent=`, `/api/access`, `/api/people` |
| Your Desk | `/api/inbox` (+ snooze, undo, edit, batch), `/api/threads` |
| Accounts and vault | `/api/connections` (entity matrix), `/api/access` |
| People | `/api/directory`, `/api/contacts` (autonomy), QuickBooks import |
| Sloan | `/api/threads?subject=account` |
| Settings and billing | `/api/billing`, `/api/team`, `/api/settings/*`, `/api/audit/export.csv` |
| Weekly Table | `/api/weekly`, its PDF |
| Runs, run detail (client) | `/api/runs`, `/api/runs/ask`, `/api/runs/:id`, `/api/runs/:id/audit` |
| Command center | `/api/ops/command-center`, `/api/ops/feed` |
| Agent lab | `/api/ops/lab`, `/api/ops/tests*`, used-by, promote |
| Connectors | `/api/ops/connectors` |
| Skills and automations | `/api/ops/skills`, `/api/ops/automations` |
| New agent, workflow builder, new skill (by conversation) | `/api/ops/builder/sessions*` |
| Triggers | `/api/ops/agents/:id/triggers`, the bundle's triggers |
| Runs, run detail (back office) | `/api/ops/runs*`, model calls, saved views |
| (v0.14) Conversations: capture per WhatsApp chat | `/api/conversations*` (portal `/conversations`), `/api/ops/clients/:id/conversations*` (the client's messaging page) |

---

## 16. Security and audit

- Secrets in env; signed URLs for documents (5 min).
- **Access (v0.10, §6.9, §6.10):** connection secrets (OAuth tokens, API keys, browser logins and
  sessions) are encrypted with the client's own data key, itself wrapped by `ENCRYPTION_KEY`; each
  ciphertext is bound to its client and connection. Secrets are write-only; the operator never sees
  them; agents never hold them (tool code gets them for one step; the model sees only tool results).
  Agents reach only the connections bound to them, within their grants. Second factors live in the
  separate code service and are handed out once, to a login in progress. Browser sign-in is done by
  code on pinned login origins, on sites the operator allows by risk tier; banks, payments, email
  accounts and identity providers are never signed in to by an agent.
- RLS on every tenant table, keyed on `app.tenant_ids` (§4). Workflows, cron and the senses dispatcher
  run with no request session and set exactly one client id. Operator sessions get only the clients
  they serve.
- **Client isolation of what agents learn:** memory notes, aliases, catalogs and every other learned
  record are per client; nothing a client agent learns is used for another client or a template.
- **The operator's work stays the operator's:** agent bundles (templates and client agents),
  instructions, prompts and costs are never returned to client roles (contract test, §14).
- Forking or promoting never carries a client's memory, aliases, records or connection ids into a
  template or another client.
- **Writes to connected systems:** only through `external` tools; every one is an `external_action`,
  executed once (idempotency key), with prior state and result recorded. **Approval is on by default for
  every write step**; a step runs without approval only if the operator set it so and the client's
  connection allows it; delete is off. Only the operator loosens a matrix or a step; the client can
  tighten its matrix at any time, which overrides steps at once. Every change is logged. Agents, the
  Builder and custom skills cannot change permissions or approvals.
- Immutable `agent_version`, `skill_version`, `raw_record`, `doc_extraction` (trigger
  blocks UPDATE except status columns).
- Email: only messages matching the connection's query are synced; bodies are fetched on demand, not
  stored in bulk; disconnecting revokes the token and stops sync. Gmail writes are drafts and labels
  only in v1, each approved.
- **Compliance (owner, 2026-11-05; `docs/plan.md` §1.35):** every request to a session route,
  sign-in, sign-out and refusal writes an `audit_event` row (who, what, which client, ids, IP,
  user agent; never content), append-only and kept 6 years; operators read it and an access review
  at `/ops/audit`. Sessions end after 30 minutes without the person's own activity and 12 hours
  after sign-in; MFA is required in WorkOS. Every response carries security headers (`no-store`,
  CSP, HSTS, no framing). A client in **HIPAA mode** sends data only to vendors listed in
  `BAA_PROCESSORS`: offering a connector, a tool call and a model call that need any other vendor
  are refused. Card numbers are replaced with `[card ending 1234]` before documents, texts or error
  reports are stored; Mezonas never takes card data (Stripe-hosted invoices). Retiring a client
  ends its access at once; its files are deleted 30 days later and its rows by the owner's
  `db:purge-client`. CI never copies client data.
- Prompt-injection hygiene: email bodies, document text and vendor descriptions are passed as data in tool results,
  never concatenated into instructions. Operator-written skill instructions run only with the tools the
  skill lists. Agents cannot change their own permissions.
- **v0.12:** Sloan sees only what the portal shows its client, writes only through internal tools
  attributed to the person asking, never loosens a rule and has no connection (§9.8). The trial and
  sign-off stages force a signature on every write; the undo window and edits before signing stay
  inside the external-action path, and an edit is re-checked and re-routed (§11.1). Notifications carry
  counts and a link, never record content, and signing needs a signed-in session (§11.3). Messages to
  an agent (email, text, thread) are data for its first step, from People only (§10.8). Test cases from
  a client's records stay in that client (§9.10). Model-call bodies are stored under the client's
  prefix with card numbers redacted, for operators only (§10.10). Search and plain-words questions run
  inside the request's scope and never become SQL (§11.6).

---

## 17. Configuration (env)

```
HYPERDRIVE (binding → Neon), DIRECT_DATABASE_URL (migrations)
ANTHROPIC_API_KEY
RUN_WORKFLOW, QBO_SYNC (Workflow bindings), ARTIFACTS (R2 binding)
STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY   # R2 S3 API, for signed URLs
ENCRYPTION_KEY                         # 32 bytes base64; wraps each client's data key (§6.9)
BAA_PROCESSORS                         # vendors with a signed BAA (HIPAA mode, §16); wrangler.jsonc
BROWSER (Browser Run binding), CODES (service binding → apps/mfa)   # v0.10
AGENT_EMAIL_DOMAIN                     # e.g. agents.<domain>, routed to apps/mfa by Email Routing
# apps/mfa only: MFA_ENCRYPTION_KEY (32 bytes base64), MFA_TWILIO_ACCOUNT_SID, MFA_TWILIO_AUTH_TOKEN,
#   IDENTITY and DIRECTORY (Durable Object bindings), AGENT_EMAIL_DOMAIN, MFA_ORIGIN, MFA_DAILY_CAP
QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI, QBO_ENV=sandbox|production, QBO_WEBHOOK_VERIFIER
EMAIL_FORWARDING_DOMAIN                # e.g. in.<domain>, routed to the Worker by Cloudflare Email Routing
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI   # after the MVP (Gmail)
WORKOS_CLIENT_ID, WORKOS_API_KEY, WORKOS_COOKIE_PASSWORD
RESEND_API_KEY (optional)
RESEND_FALLBACK_DOMAIN                 # v0.12: also the sender of notifications (notify@…)
# v0.12 adds no secret. New connectors (§6.11) read their own keys when the owner creates the apps:
#   OUTLOOK_CLIENT_ID/SECRET, RAMP_CLIENT_ID/SECRET, HUBSPOT_CLIENT_ID/SECRET (unset: "not available yet")
```

---

## 18. Build plan (ordered; each milestone ends green)

Platform first; the Materials template, forked and customized for the millwork shop, proves it.

| # | Milestone | Done when |
| --- | --- | --- |
| M0 | Monorepo, Vite app + Hono Worker, Drizzle, Postgres + pgvector, Cloudflare Workflows, WorkOS auth with a seeded operator and one client | `pnpm dev` runs the Worker (API + Workflows) and the app; the operator and a client user can sign in |
| M1 | Platform schema (§5): skills, templates and client agents with bundle versions and lineage, runs, inbox, usage; RLS on `app.tenant_ids` + `app.operator`; immutability triggers; core Zod schemas (bundle, workflow, …), workflow validation, **bundle diff and three-way merge**; seed (operator, sandbox client, platform templates) | Migrations apply; RLS holds for client and operator sessions; validation and merge unit tests pass |
| M2 | Connector framework, upload connector with email forwarding, documents capability (store, extract, validate) | Upload 3 fixture invoices → extractions match expected JSON within tolerance |
| M3 | Tool + skill registries, agent runtime on client agent versions, permission gate, external actions, run/step/tool logging, usage rollup | A client agent in the sandbox client runs `docs.extract` end to end and logs cost; an external tool call creates an approval and executes once when approved |
| M4 | Workflow executor, triggers per client agent (event, schedule in client timezone, manual, command), senses outbox, test runs | A workflow with a fork, a for_each and an approval runs to the end for one client's agent and never starts for another client; a test run proposes but never executes external actions |
| M5 | Back office shell (overview, clients, onboarding, offering connectors, operator inbox, requests queue); client portal shell (overview, inbox, **connections**, requests, settings); inbox resolution resumes runs | The operator creates a client, offers it the upload connector and invites its admin; the admin signs in to the portal, sees the offered connectors, approves an item that resumes a run, and raises a request the operator sees |
| M6 | Templates and client agents: editor, skills, Builder; fork, customize, versions and rollback, customizations view, bindings and activation; template updates (preview, conflicts, merge draft) and promotion; "Used by" | The operator builds a template, forks it into two clients, customizes each differently, publishes template v2, and merges it into both (one clean, one with a resolved conflict) while keeping each client's customizations; promotes one client's change into template v3; rolls one client back |
| M7 | Workflow builder (templates and client agents): steps, forks, drag and drop, inspector, validation; merge view; run view; client run timeline | The operator customizes a client's workflow in the builder (adds a step, adds a fork path), test-runs it on that client's data, resolves a conflict from a template update in the merge view, publishes; watches the live run in the run view while the client sees the timeline without internals or cost |
| M8 | Materials pack: tables, matching (golden tests), pricing and alert rules, the Pia template forked and customized for the millwork client; client reports (activity, Price watch, Catalog, CSV) | Golden tests ≥ 95% precision; Baltic birch matches across 3 vendors; an uploaded invoice runs the millwork shop's purchase-intake to priced lines with a `price_jump` alert; the client sees it in Price watch |
| M9 | QBO connector: OAuth, sync, CDC, attachables, webhooks, read tools, the MVP write tools (itemize lines, attach invoice) with per-step approval | Sandbox company syncs; a Bill flows through intake; approving in the portal itemizes its lines (total unchanged) and attaches the invoice in the sandbox; **MVP done** when the same works on the shop's production QuickBooks |
| M10 | (after the MVP) Gmail connector: OAuth, scoped sync (query + history), attachments as documents, read tools, draft and label tools behind approval; Gmail step in `docs.find-support` | A test mailbox connects; an emailed invoice is found for its QBO transaction and flows through intake; an approved `gmail.draft.create` appears in the mailbox's drafts |
| M11 | Usage and cost views (per client, agent, template), activity report, notification emails, polish, Playwright e2e | e2e: the operator forks Pia into a new client and customizes her, the client connects and uploads an invoice, approves in the portal, sees the report; the operator publishes a Pia template update and merges it into that client |
| M12 | Access (v0.10): client data keys and write-only secrets; grants per binding and the portal's Access page; the code service (`apps/mfa`); browser connections with the site catalogue and risk tiers, sign-in by code, read and download tools | An agent with a read-only grant signs in to a low-tier fixture site as its agent account, with a code from the code service, downloads an invoice as a document and signs out; the model never sees the password or the code; a second agent without the binding cannot reach the site |

| M13 | (v0.12) Go-live stages and client controls; running a client agent live on a past event | An agent forked into a client goes bench → trial (every write signed even with a step set to run without approval) → signoff after 14 days and 25 runs (shortened in the test) → live on the client admin's approval; the operator skips a stage with a logged reason; the client admin pauses all with a reason and resumes; Run now starts a client-runnable workflow from its form; the operator runs the agent live on the invoice that arrived while it was off |
| M14 | Notifications, the Table and the Weekly Table | Items waiting send one email an hour with a count and a link; a connection in error emails the admin; the Weekly Table drafts on Friday, takes the lead's note, sends on Monday 7:00 in the client's zone, and downloads as a PDF |
| M15 | Threads, the lead and `/commands` | A client member and the lead talk in the lead thread with read state; a lead check goes to the lead's user; `/remy` in a thread posts a command message and emits `thread.message_posted` |
| M16 | The Desk, sign-off and viewers | A question answered with one tap; an item snoozed; an email's subject edited before signing (both versions kept) and sent once with the edit; 2 of 3 signed; an approval undone inside 60 s writes nothing, and one not undone writes once after the window; a viewer can't sign |
| M17 | Run controls and model calls | A run that failed at its send step is retried from it and sends the already-signed email once without asking again; a waiting run is cancelled; a replay is a test run in the same client; failures group by error; model calls show on the run |
| M18 | QuickBooks: accounts receivable and create bill | A fake company's invoices, customers and payments sync; the aging report reads; a note is added to an invoice's private note only; a bill is created once after approval and refused as a duplicate |
| M19 | People and voice samples | Categories, tags, notes and autonomy per channel; a person's email set to off refuses a reach-out by email; vendors and customers import from QuickBooks; a forwarded `+voice` email becomes a sample a skill reads |
| M20 | Platform fixes from the API end-to-end test | Events dispatch right after commit; background readings count in the client's usage and credits; the portal lists records; "sync now" right after connecting starts or queues a sync |
| M21 | Permissions per record type and the connectors catalog | QuickBooks' matrix allows invoices "notes only": `qbo.invoice.add_note` is allowed and another invoice update is off; an old matrix still applies to every entity; the catalog shows status, errors and default access |
| M22 | Automations | An automation used in two agents runs expanded in their runs with stable node ids; a template update and a client change to the use step merge; inner write steps keep approval on |
| M23 | Test bench, skill tests and the agent lab | A skill's 8 cases run on its draft (fixtures only, no writes), report pass rate and precision, and block publishing while one required case fails |
| M24 | Sloan, the account agent | In an account thread, Sloan explains why an item waits, pauses an agent until Monday, drafts "add Lisa as a signer under $2,000" that applies only when the admin signs, refuses a loosening and passes it to the lead |
| M25 | Triggers: six kinds | A schedule skips a holiday; a webhook delivery filtered, deduplicated and rate-limited; a manual run from the client's form; an email to the agent's address from a cardholder starts a run and a stranger's doesn't; a handoff starts the next agent with sources |
| M26 | Command center, search and plain-words questions | The command center's figures match a seeded fixture; ⌘K finds a run, a vendor, a person and a document; "bills Iris entered over $5,000" becomes the expected `RunFilter` |
| M27 | KPIs and the client view, credits, the client's audit export | A template's KPIs show on its client agent's page and in the Weekly Table; credits running out with `pause` pauses billable agents and tells the admin; the admin downloads the audit export |
| M28 | The Builder as a conversation | A three-turn session drafts an agent, one change is undone alone, `/skill` changes one setting, a new skill is drafted with tests from examples, and two steps are saved as an automation |
| M29 | New connectors | Google Drive files a document by month and Outlook sends an approved email, both against fakes; Ramp and HubSpot after them |
| M30 | (v0.13) Task skills and a model per step | One workflow reads an invoice with a `task` skill on Haiku (no agent instructions or memory in its prompt) and drafts an email with an `agent` skill on the agent's Sonnet; a step override moves the draft to Opus; model calls show each model and per-step cost; a `task` skill without a model fails validation |
| M31 | Run oversight on failures | A lookup that fails on a vendor name with a trailing space is corrected and the run finishes, with one decision row and one proposal for the operator; a write that reached the client's tool is never retried; past the limit the step fails as before; the portal shows only "Corrected and tried again" |
| M32 | Checkpoint reviews | An extraction that feeds a create-bill step is reviewed; a wrong total is corrected before the bill is proposed and the approver sees the corrected input; with `review: 'failures'` a clean run makes no oversight call |
| M33 | (v0.14) WhatsApp passive capture | A WhatsApp photo from a contact whose conversation has attachments on becomes one document, extracted, linked to its message; with it off, only the attachment's existence is kept; a retried webhook makes nothing twice; the client admin toggles it and the change is logged |
| M34 | (v0.15) The Purchasing area: the Materials pack ported | On staging, the Materials pack is enabled for the Sandbox; three invoices from different vendors for the same sheet good are matched to one catalog item (the second and third by alias or rules, not the model); the Price watch report shows that item's price per vendor and date; a key attribute that differs is never matched; golden matching tests ≥ 95% precision on "same" |
| M37 | (P-4) Conversations | A three-turn WhatsApp clarification ends with a confirmed, typed result; a limit hands over to a person with the transcript; a replay sends nothing twice; a contact on "needs approval" makes each message wait |
| M40 | (P-7) Message translation | An English WhatsApp reply to a Spanish-working client is stored with its Spanish translation beside the untouched original; an approver's Spanish words to an English-speaking vendor are translated, signed with both texts in view and sent once exactly as signed; a client without the setting works as before |

**MVP** (§1): M0–M4 in full; M5 without client requests; M6 without the Builder, operator-written skills, template updates and
promotion; M7 without the merge view; M8; M9 with the two MVP write tools; plus email forwarding (§6.5)
in M2. Gmail (M10), the deferred parts and M11's extras follow (`docs/plan.md` §3).

---

## 19. Testing

- Unit: workflow validation (every rule, with step/field error locations), template typing, rule
  compilation to JSONLogic, normalizer,
  attribute parsers, UOM conversion, alert rules, Zod schemas, version immutability, permission gate.
- Layering: platform packages never import packs (`scripts/check-deps.mjs`).
- Golden: extraction fixtures (`fixtures/invoices/*.pdf` + `*.expected.json`), matching pairs.
- Executor: a fake `StepRunner` for every step kind, fork path order and for_each; one Workers-pool test drives the real
  Workflow class through a wait, a resume and a timeout.
- LLM calls behind `packages/llm` with a record/replay mode so tests run offline.
- Builder: component tests for add, drag to reorder, move between fork paths, delete, undo, and
  validation markers; Playwright e2e (M11).
- Permissions: every verb × connection setting × agent setting gives the right outcome; `off` is caught
  at publish; automatic writes still record before state; tightening by a client takes effect at once.
- Isolation: RLS for single-client and operator sessions; portal routes never return agent bundles,
  prompts or cost (contract test); a client agent's memory never reaches another client or a template.
- Lineage: bundle diff and three-way merge golden cases (change on one side; same change both sides;
  conflicting field; delete vs edit; workflow added on both sides; step moved within and between fork
  paths; two different reorders); merges keep step ids; promotion strips client-specific values; fork → customize → update → rollback round trips.
- v0.12: the API end-to-end test (`apps/api/src/e2e.test.ts`, #102) is extended by each milestone that
  changes its path (go-live stages, the Desk, notifications); stage × matrix × entity × grant × step ×
  mode × person autonomy gives the strictest outcome; an undone approval never writes and a delivered
  one writes once; a retried run never writes an action twice; automations expand with stable node ids
  and merge by step id; skill tests never reach a connector; Sloan's tools return nothing a portal route
  wouldn't (the contract test's forbidden fields, walked over every tool result); a plain-words
  question can only produce a valid `RunFilter`; notifications carry no record content (a test walks
  every message for record fields); isolation tests for every new tenant table.

---

## 20. Decisions and open items

Decided:
- Auth: WorkOS (v0.2). Hosting: Cloudflare Workers + Neon + R2 (v0.2).
- Document requests are inbox-first, routed to a client admin (`docs/plan.md` §1.1).
- Embeddings: optional; trigram + attributes is enough for v1.
- Writes to client systems: governed by each connection's permission matrix, conservative by default
  (v0.7, replacing "always approved" from v0.3); approvals go to the client admin by default, or the
  operator when delegated (v0.4).
- Workflows are structured step lists with forks, edited in a sortable list builder (v0.7).
- Approvals are on by default and set per step; the connection matrix is the ceiling (v0.8).
- MVP: Pia live for the millwork shop on its own QuickBooks, with upload and email forwarding (v0.8).
- First QuickBooks writes: itemize a bill's or purchase's lines (total unchanged) and attach the
  invoice (v0.8).
- Slack later, not in v1 (owner, v0.8).
- v1 connectors: QuickBooks Online, Gmail, upload (v0.4).
- Managed-agents service: the operator builds and runs agents from a back office; clients get a portal
  for reports, runs, approvals, connections and requests (v0.5).
- Cost is operator-only; clients see activity and outcomes (v0.5).
- Templates and client agents: reusable agents are templates; each client gets its own fork, customized
  and versioned per client, linked to its template version; updates are reviewed three-way merges;
  promotion moves client changes back (v0.6).
- One version = the whole agent bundle (definition + workflows + settings) (v0.6).
- Access: a vault per client with its own key, grants per agent binding, a separate code service for
  second factors, and browser logins as dedicated agent accounts on operator-allowed sites by risk tier
  (v0.10, §6.9, §6.10).
- v0.12 (owner, 2026-11-06; may revisit): Gmail stays send-only with no CASA, reading by forwarding and
  voice from samples; QuickBooks adds create bill (behind approval) and accounts receivable (sync,
  aging report, private-note-only writes), delete off; billing stays Stripe invoices paid by link, card
  on file later; signing is never done by replying, a notification links to the Desk; go-live stages
  (test bench, trial with every write signed for about 14 days or 25 runs, whichever is later, client
  sign-off, live), per client agent, skippable by the operator with a logged reason.
- v0.12 (design): Sloan is the supervisor's client face (§9.8); viewers are client users with sign-off
  off (§4); automations are a `use_automation` step on a pinned version (§10.7); the undo window delays
  the run's event, not the write's path (§11.1); notifications send through Mezonas' own `resend` path
  (§11.3); the Weekly Table's PDF is rendered by `pdf-lib` on request (§11.4); replay is a test run in
  the same client (§10.10); background reading is the client's usage (§13).
- v0.13 (owner, 2026-11-06): the client agent oversees its runs on a model the operator picks, deciding
  within the plan (continue, retry, retry with a corrected input, ask a person, stop) and proposing
  lasting fixes; skills are `tool`, `task` (own default model, agent-independent) or `agent` (the
  agent's model, instructions and memory), and a step may override the model; we keep our executor on Cloudflare Workflows
  rather than adopting a graph library (LangGraph) (§10.11).
- v0.14 (owner, 2026-11-06): WhatsApp messages to a client's number are archived per conversation
  and, where the client turns it on, their attachments are filed as documents; nothing on that path
  replies; downloads are off by default; the client admin and the operator may both change it, and
  every change is logged; groups wait for Meta's connector (§6.12).
- v0.15 (owner, 2026-11-07): data is organised by business area, each a pack used by many agents
  through its tools; the platform's tables stay fixed and the client's tools stay the system of
  record; the Purchasing area (the Materials pack, ported from M8) is in v1; the Sales area, area
  grants and client extras are designed for, not built (§12.0).
- P-7 (owner, 2026-11-08): message translation is in v1: a working language per client, with a
  per-contact switch; translations are stored beside untouched originals, are data, and count as the
  client's usage under a daily limit (§10.13).

Open:
- v0.15, for the owner: embeddings for matching (when, and which provider: OpenAI or Voyage, named in
  the compliance list); generalising the Materials categories beyond millwork (more parsers in code,
  or embeddings for categories without one); the Sales area's first use case and CRM.
- v0.14, for the owner (`docs/plan.md` §1.55): whether to delete media at Twilio once it is filed;
  Twilio's media facts (auth, the redirect's host, retention) and Meta's groups requirements, to verify.
- v0.12, for the owner (`docs/plan.md` §7): the agent address domain (`<agent>@<client>.agents.mezonas.com`
  needs Email Routing per client subdomain); the bank and card aggregator (vendor, cost); developer apps
  for Outlook, Ramp and HubSpot; whether trial days are billed; whether a client may set a person's
  channel to "on its own" itself (v0.12: only the operator loosens); other holiday calendars.
- Gmail and Google's app verification: Gmail read scopes are restricted, so a public app needs Google's
  verification and a security assessment; an unverified app shows a warning and has a user cap, and in
  "testing" status its refresh tokens expire after 7 days. Check the current rules at M10 and choose:
  verify the app, or (for Google Workspace clients) domain-wide delegation granted by the client's admin.
- Whether to add sending email (approved) after drafts, and Gmail push notifications instead of polling.
- Billing: decided (`docs/plan.md` §1.32). Open: real prices, and whether a client agent's own test
  runs are billed.
- From the owner's design, not yet in scope: Google Drive (appears connected in the screens), Ramp,
  bank, Outlook, HubSpot (Slack: later, owner); a header command bar ("Ask an agent, or type / for a
  command"); the Invoice intake, Collections follow-up and Card receipts agents.
- Skills under lineage: v1 forks agents, not skills (a client-only skill is written for that client).
  Whether skills also need template/fork lineage depends on how often skills get customized per client.
