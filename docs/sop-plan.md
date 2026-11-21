# The agent's SOP: a standard operating procedure made from its setup

Owner, 2026-11-21: "a documented SOP for each of the agents. Basically a clickable, readable,
queryable SOP that clients can look at, print and share based on the current set up of their
agent… at the client agent side. Formalize it, including a process, owners, controls, systems,
data. Plan this and design this before building it."

This page is the plan and the design. The mock-up is [`docs/design/sop.html`](design/sop.html)
(open it in a browser; it prints). **S0, S1a and S1 are built** (owner, 2026-11-21: "Rename Manual
to SOP, yes; start building S0 and S1"): ARCHITECTURE v0.21 §10.17 describes them and
`docs/plan.md` §1.179 records each choice made while building, where some details below changed
(model names without their maker, a pause or a hold not in the SOP, a connection's errors not a
change, revisions recorded by `mount()` for the routes listed in `SOP_CHANGE_ROUTES`). What is left
is in `docs/open.md`, "The agent's SOP".

Last updated 2026-11-21.

## 1. What it is, in one paragraph

Every client agent gets an **SOP**: one formal document, made by code from what the agent is set up
to do right now, in the client's portal. It names the process step by step, who does, approves and
is told about each step, the controls that hold it, the systems it reaches and what it may do in
each, and the data it reads, saves and changes. Every line links to the things it names. It can be
searched, filtered, asked about, printed and shared. It carries its revision and the revision's date,
and every change to the setup makes a new revision with what changed, who changed it and when.
Nothing in it is written by a model, so it is always true to the setup, and nothing in it waits on
anyone: it says how the process runs, never what is still to do (owner, 2026-11-21).

## 2. What we already have, and what this adds

The **agent manual** (ARCHITECTURE §10.16, `docs/plan.md` §1.155 B3) is most of the way there. It is
a client-safe view made by code (`packages/core/src/manual/manual.ts`, `manualView`), on the portal's
Manual tab (`GET /api/services/:id/manual`), with "Ask about this" and "This is wrong" on every line.

| The SOP needs | Where it comes from today | Gap |
|---|---|---|
| Purpose | `definition.manual.whatItDoes`, else `agent.serviceDescription` | None |
| How it starts | Triggers (`TriggerOn`), `scheduleText` (core `triggers/schedule.ts`), the client's business hours | Not on the manual |
| The steps | `howItWorks` (names and kinds in words), `processStepWords` | Path rules in words (`ruleText`) live in the web (`apps/web/src/ops/workflow/describe.ts`); move to core |
| Who does, approves, is told | `decisionPointsOf`, `whoWords`, person steps' `assignee`, approval checks' `approvers`, `notify` checks, `tenant.settings.approver_rules`, `agent.approver`, `agent.people`, the lead (`leadOf`), the area owner (`area_owner.name`) | No people matrix; ids are never turned into names |
| Controls | The gate (`decideWrite`, `explainWrite` and its `WHY_CODES`), the connection matrix (`levelWords`), grants (`effectiveMatrix`), stage (`effectiveMode`), checks (`confer`, `approval`, `notify`), deadlines (`ifNoAnswer`, `escalate`), `OWNER_MAY` and `OWNER_NEVER`, `HOW_AGENTS_WORK`, compliance mode | Nothing lists them as controls |
| Systems | `agent.bindings`, `connection` (label, status, `permissions`), `agent_grant`, `connectorTitle`, `PortalConnectionState` | Not on the manual |
| Data | `processDataUse` (core `process/data-use.ts`: reads, saves, changes per entity, area, connector, pack); tool specs' `entity` and `area` | v4 processes only; not on the manual |
| Exceptions | Steps' `onError`, `onReject`, `ifNoAnswer`; known risks; `missing` steps | Scattered |
| Decisions and settings | The manual's decisions, setup, `definition.adjustable` | None |
| Measures | `clientView.kpis` (§9.9) | Not on the manual |
| References | `MANUAL_READS`, the charter, tagged policies (`governance/select.ts`), hand-offs | Policy titles not listed per step |
| Revision history | `agent_version` (immutable), `agent_change`, `connection_change`, `area_owner_version` | Nothing on the portal |
| Search, print, share, ask | ⌘K search, `window.print()` on one ops screen, pack preview's signed links, Sloan | None for the manual |

**Bug found while planning.** `GET /api/services/:id/manual` is missing from
`ASSIGNED_USER_ROUTES` (`packages/core/src/api/assigned.ts`), while the Manual tab shows for a
limited client user (`portal/screens/Agent.tsx`). They get 403 `not_assigned`. It is a one-line fix
with a test, in its own PR, whatever is decided here (S0 below).

## 3. Decisions

| Topic | Decision |
|---|---|
| One document, not two | The SOP **is** the client's manual, made formal. The portal's Manual tab becomes the **SOP** tab and keeps every manual section, "Ask about this" and "This is wrong". The back office keeps its Manual tab for building, plus "See the client's SOP". Agents keep reading the manual through `manual.read` (tier 3, §10.16): the SOP is a view, never what an agent reads. // DECISION |
| Made by code, never by a model | `sopView` in `packages/core/src/sop/` is pure, like `manualView`: same inputs, same SOP. The only text people wrote is what they already write (step names, "what it does", decisions, the operator's path descriptions) and each step's purpose (below). No model call when it is read, no cost, nothing to replay. // DECISION |
| Rules, AI or a person, on every step (owner, 2026-11-21) | Each step says how it works, so a reader sees where the process is deterministic and where AI decides: **Rules** (same input, same result: reads, writes, notices, waits, `if` steps that decide by rules, a skill whose method is `rules`, a tool with no `usesModel`); **AI** (a skill whose method is `ai`, an `if` or `repeat` the agent decides, a conversation, a tool that declares `usesModel`); **Rules, then AI** (`rules_then_ai`: the rules settle what they can and only the rest goes to the model); **A person** (person steps). A step's checks say the same of themselves (an AI check, a person's check), and the area owner's review is AI. Worked out by code from the skill's method (`skillMethod`) and the tools' specs. // DECISION |
| The model on each AI step (owner, 2026-11-21) | Each AI step names the model it runs on, resolved in the runtime's own order (the step's `model`, else its skill's, else the agent's), by one shared function the runtime and the SOP both call, so they can't disagree. The area owner's model is named in Roles and on its control. Shown by name and maker ("Claude Sonnet 5.5, Anthropic"; "GPT-5.5, OpenAI"), from a client-facing list beside `MODEL_LABELS` in `packages/llm`, passed into core by `apps/api` (core doesn't import `llm`). A model with no client-facing name reads "An AI model" rather than an id. Never its price, effort, tokens or prompt. Each maker is already on the public subprocessors list. // DECISION |
| The point of each step (owner, 2026-11-21) | Every step carries one sentence on why it is there ("Looks the vendor up in QuickBooks so the bill goes to the right vendor, not a duplicate"): a new optional `purpose` on core's step schemas (v3 and v4, at most 200 characters, no default, so stored bundles parse and hash as before). The Builder writes it when it drafts a step, the operator reads and edits it in the step panel, and it is versioned and merged with the step like its name. A step without one reads a plain line made by code from its kind, tool and data ("Reads vendors from QuickBooks Online."), never one made by a model when the SOP is read. // DECISION |
| People and agents told apart by icon (owner, 2026-11-21) | Every name in the SOP carries an icon: a person (the icon set's `mz-lead`, in copper), an agent (an agent icon, in ink), the client's team (`mz-team`, copper), Mezonas' people (copper). Rules and AI carry their own icons beside the step's method. The icon set has no agent, AI or rules icon yet: the mock-up draws provisional ones on the set's grid (24px, 1.5px stroke, square caps), and the owner asks the designer for `mz-agent`, `mz-ai` and `mz-rules` in the design system's next delivery (CLAUDE.md: the design system isn't edited here). // DECISION |
| The agent is named once (owner, 2026-11-21) | The whole SOP is one agent's, so its name isn't repeated on its steps: the procedure says once "Bills in does every step unless one names a person or another agent". A step names who does it only when that isn't this agent: a person (a person step's assignee, in place of the method), another agent (a skill step run by another agent, `SkillStep.agent`; a hand-off), and, in its facts, who approves and who is told. The people table has no column for the agent itself (its answer would be "Does" on every row) and is titled "Who else takes part". // DECISION |
| Steps read as a list, not cards | The procedure is one list: a line per step with its number, name, how it works (Rules, AI with its model) or, for a person step, the person; under it the step's purpose; under that one line of facts (approvers and by when, the system and what it may do, data, controls). Nested steps are indented under their path's condition. What happens on an error or a rejection is one short clause on the step, with the detail in Exceptions. // DECISION |
| "Current set up" means the setup that runs | The **live version** of the agent (else the latest, as the manual does), plus what is set outside the version and changes what happens: the agent row (`bindings`, `people`, `channels`, `approver`, `stage`, `pause`, `hold`, `area`), each bound connection's permissions and the agent's grant, the client's approver rules, business hours and compliance mode, the area owner's name and the lead. Changing any of them changes the SOP. // DECISION |
| Controls say what happens now | A write step's control line is worked out by the **gate's own code** (`decideWrite` with the agent's mode, stage, matrix and grant), never a copy of its logic, so the SOP can't say "runs on its own" where the gate would ask. What only a run knows (an amount over an approver rule, a person who asked to see changes first, a hold) is shown as a condition: "Ada approves when the bill is over $5,000". // DECISION |
| No open items (owner, 2026-11-21) | The SOP states how the process runs. Nothing in it waits on anyone: no "Waiting on you", no pending approval of the SOP, no "never discussed", no setup still to answer, no gold. A decision shows what was decided and who set it ("Us, 4 Nov 2026", "Confirmed with you", "Ada Ruiz, 15 Nov 2026"). What is still open stays where it is worked on: the back office's Manual tab and build page, the setup checklist, the agent's Settings and the Desk. A person step in the process ("Cara reviews the price alert") is part of how it runs, not an open item. // DECISION |
| Names, not ids | The client's own people and contacts are named (the portal already shows them on Team and People). Ours: the lead by name (as the audit export does), everyone else as "Mezonas". An id that no longer resolves reads "A person no longer on your team", in plain ink; fixing it is the Settings page's, not the SOP's. Area owners are agents: ink, with the agent marker, never copper. // DECISION |
| What is never in it | The bundle, instructions, prompts, skill internals, budgets and cost (invariant 11); a model's price, effort or tokens (its name is shown, above); tool ids (a tool reads by its connector and what it does); another client's anything; what the agent learned, except for the client admin, as on the manual today. `FORBIDDEN_PORTAL_FIELD` and the contract tests cover the new routes as they do the manual's. // DECISION |
| Numbering | Sections are fixed and numbered 1 to 13 (§4). Steps are numbered by run order with nesting (5, 5.1, 5.2); controls `C1…`, systems `S1…`, data `D1…`, all by order in the document. Links use stable anchors from ids (`#step-<stepId>`, `#control-<key>`, `#system-<connectionId>`), so a printed number can change between revisions but a link never breaks. // DECISION |
| Revisions, in the first build (owner, 2026-11-21) | Every SOP shows its **revision** and the **revision date**, the previous revision, and **what changed in this revision**; section 13 is the whole **revision history**, newest first. A revision is a stored, immutable row (`sop_revision`, §6), so S1 starts with its migration. Numbered by the agent's version and a count of setup changes since it (7.0 when version 7 goes live, 7.1 and 7.2 for later changes to its people, approvals, connections or settings), so the number says whether we changed the agent or its setup changed. // DECISION |
| Languages | Section titles, labels, control and platform text in the portal's six languages; what people wrote stays as written, as the manual does (`docs/open.md` G9 covers the copy review). // DECISION |
| Older processes | v3 workflows get their data from their action steps' tools and their skills' tools: `stepDataUse` gains a v3 walk. Where a skill isn't known the step reads "Data not listed" rather than guessing. // DECISION |
| Pack controls | The Materials hard veto, price alerts and booking rules are real controls, but the platform never imports a pack (invariant 2). A pack declares its controls as data (`SkillDefinition.controls?: {name, kind, how}[]`, localized, in the pack's manifest) and core renders them on the steps that use the skill. S3. // DECISION |

## 4. The document

Fixed sections, in this order. Each says where its content comes from. The mock-up shows each one
for a sample agent ("Bills in" at a sample client).

**Document control** (the header, first on a print): the SOP's title ("Bills in: standard operating
procedure"), its code (`SOP-PUR-03`: the area's three letters and the agent's place in that area),
the client, the area and its owner (Pia, Purchasing), the **revision** and the **revision date**, the
previous revision (a link to section 13), the stage (Bench, Trial, Sign-off, Live, Paused), the
accountable person (§7, question 2), the lead, and when it was read or printed ("As of"). Under them,
**what changed in this revision**: each change with its old value, the steps and controls it touched,
who made it, where (approval rules, connections, this agent's settings, a new version of the agent)
and when. Plain ink on a subtle surface, never gold: it reports, it asks nothing.

| # | Section | What it holds | From |
|---|---|---|---|
| 1 | Purpose | What it does and what done well means | The manual's `whatItDoes` |
| 2 | Scope | What starts it, what it covers, what it never does (from the guardrails: never deletes, never moves money, never changes its own permissions), what is out of scope (known risks, steps not built yet) | Triggers, known risks, `missing` steps, `HOW_AGENTS_WORK` |
| 3 | Roles | Each role, who holds it and what they do: the agent (does the work), the area owner (watches, may retry or correct, never changes the plan), the accountable person, approvers, people who answer, people told, your admin (connections, settings), your Mezonas lead (escalations), Mezonas (builds and changes it). Then **the people matrix**: steps down the side, people across, cells Does, Approves, Checks or Told | Person steps, approval checks, approver rules, `notify`, `agent.people`, area owner, lead, `OWNER_MAY` and `OWNER_NEVER` |
| 4 | How it starts | Each trigger in words, the schedule and business hours, who may run it by hand | Triggers, `scheduleText`, business hours, `manual.client` |
| 5 | Procedure | The steps in run order, numbered and nested, as a list. Each step: its name; how it works (Rules, AI with its model, Rules then AI, or a person) and who, with their icons; its purpose in one sentence; one line of facts: approvers and by when, the system and what the agent may do there, data, controls, and a short clause for an error or a rejection. Paths show their rules in words. Each fact links to its role, control, system and data | `howItWorks`, step fields and `purpose`, `skillMethod`, the model resolver, `ruleText` (moved to core), `stepDataUse`, the gate |
| 6 | Controls | The control register. Each control: number, name, what it prevents or catches, kind (Prevents or Catches), how (automatic or by a person), the steps it covers, who owns it, and where the evidence is (a run's audit trail, the changes to your tools with their before state, the audit export) | §5 below |
| 7 | Systems | Each connection the agent uses: the tool and account, connected or not, who connected it, and for read, create, update and delete what the agent may do there in the client's words (Off, Ask me first, On its own), the strictest of the connection and the agent's grant. The steps that use it | Bindings, `connection`, `agent_grant`, `levelWords` |
| 8 | Data | Each kind of record: what it is, where it lives (your QuickBooks, your Mezonas records in Purchasing, your documents), whether the agent reads, saves or changes it, in which steps, who can see it, how long it is kept, and whether an AI model reads it to do a step (with the link to our subprocessors). Then what it learned (the client admin only) | `stepDataUse`, the business area (§12.0), `docs/policies/data-retention.md`, the site's subprocessors page |
| 9 | Exceptions | What happens when something goes wrong: errors, no answer, a rejection, a known risk, a step not built yet, a hold or a pause, and who can pause it | Steps' `onError`, `onReject`, `ifNoAnswer`, known risks, `missing`, `pause`, `hold` |
| 10 | Decisions and settings | The manual's decisions, each with who set it and when (no status), what we set up with you (answered items only), what you can adjust and its limits | The manual, `definition.setup`, `definition.adjustable` |
| 11 | Measures | The agent's KPIs, what each counts and over what period, with this period's value | `clientView.kpis` (§9.9) |
| 12 | References | What it reads (the guardrails as "How Mezonas agents work", your charter, the policies that apply to its steps by title, your knowledge base) and the agents it hands over to or from | `MANUAL_READS`, `governance/select.ts`, hand-offs |
| 13 | Revision history | Every revision, newest first: its number, its date, what changed (old and new values, linked to the steps, controls and systems), who changed it and where | `sop_revision` (§6) |

## 5. Controls

The register is made by code from three sources. Platform controls are fixed text in core (beside
`HOW_AGENTS_WORK`), so every SOP carries the same words for the same control.

| Control | Kind | How | Where it comes from | Evidence |
|---|---|---|---|---|
| A person approves before each change to your tools | Prevents | By a person | Each write step whose gate result is "ask", with its approvers, rules and deadline | The approval in the run's audit trail; the change with its before state |
| What the agent may do in each system | Prevents | Automatic | The connection matrix and the agent's grant, per verb | The connection's change history |
| Nothing is ever deleted | Prevents | Automatic | Delete is off everywhere (invariant 8) | Platform |
| Every change is made once, with its before state | Prevents | Automatic | `external_action` (idempotency key) | The changes to your tools |
| Every change is signed in trial and sign-off | Prevents | By a person | The stage (§10.9); shown while the agent is in either | The run's audit trail |
| Checks on a step | Catches | By a person or by AI | `checks.confer` | The step's check in the run |
| Rules that choose a path | Prevents | Automatic | `if` steps that decide by rules (an agent's choice is listed, labelled as the AI's) | The run timeline |
| Deadlines and escalation | Catches | Automatic | Deadlines, reminders, `ifNoAnswer`, `escalate` | The inbox item's history |
| The area owner watches each run | Catches | By AI | The owner's review settings; what it may and never may do | The run's owner decisions |
| Text in documents and email is data, never instructions | Prevents | Automatic | Guardrails (invariant 9) | Platform |
| Agents can't change their own permissions or plan | Prevents | Automatic | Guardrails (invariant 9) | Platform |
| Everything a person does is logged | Catches | Automatic | `audit_event` (invariant 14) | Your audit export |
| Only HIPAA-ready vendors | Prevents | Automatic | Shown when the client's compliance mode is HIPAA | Platform |
| A pack's own checks (S3) | Either | Automatic | `SkillDefinition.controls` (§3) | The pack's records (alerts, matches) |

The register lists a control once with every step it covers; the procedure shows a step's controls
on the step. Each control's owner is a role from §3 (an approval's is its approver; a connection's,
the client admin; a platform control's, Mezonas).

## 6. Clickable, queryable, printable, shareable

**Clickable.** Every name in the SOP is a link inside it: a step to its roles, controls, systems and
data; a person to every step they are in; a system to its steps and its page on Connectors; a
control to the steps it covers and to where its evidence is (the agent's runs, the audit export).
Out of the SOP, links go only to portal pages the reader can already open.

**Queryable.**
- **Find and filter** (S1, in the page): a search box over the whole SOP that highlights matches and
  hides sections without one, and filters by person, system, data and control kind ("show me every
  step Ben approves"). All in the browser, over the view already loaded.
- **Ask** (S2): "Ask about this SOP" opens Sloan with the agent in context, and Sloan gets an
  `sop.read` tool returning the same client-safe view, so "who approves bills over $5,000?" is
  answered from the SOP with the section it came from. Sloan already sees only what the portal shows;
  this is one more portal view. Its fixtures are re-recorded (`LLM_MODE=record`).
- **Across agents** (S2): a **Procedures** page in the portal lists every agent's SOP with its stage,
  revision, revision date and what changed last, with the same filters across all of them ("which
  agents change QuickBooks?").

**Printable** (S1). A "Print or save as PDF" button and a print layout: document control on the first
page, every section open, links shown as section numbers, buttons and filters hidden, a footer with
the code, revision and page (`@page`, where the browser supports it), A4 or Letter by the client's
country as the Weekly Table's PDF chooses (`paperFor`). The browser's own "Save as PDF" makes the
file. A PDF made on the server is not planned until someone asks: the shared page (below) prints the
same way.

**Shareable.**
- Inside the client's team (S1): the SOP has its own portal address (`/agents/:id/sop`, and
  `#step-…` for a line); anyone who can see the agent can open it.
- Outside the team (S3, owner to agree, §7): the client admin makes a **share link** for an auditor,
  an insurer or a new hire: read-only, for one revision as it was when shared, expiring (7 days by
  default, 30 at most), revocable, never showing what the agent learned, with an option to show roles
  instead of people's names. Every open is in the client's audit log. The page is `noindex`, outside
  the app's shell, and drawn by the same React components from a public read of the frozen revision,
  so there is one renderer.

**Revisions** (S1). `sop_revision` (tenant, RLS forced): `agent_id`, `number` (7.2), `agent_version_id`,
`fingerprint` (a hash of the SOP's content), `view` (the SOP as it was, JSON), `changes` (what changed
from the revision before, worked out by code: `sopChanges(before, after)`, each change a section, the
step, control or system it touches, the old and new value in words), `changed_by` (a person, or
Mezonas), `where` (approval rules, connections, the agent's settings, a new version, the stage),
`created_at`. Never updated or deleted (invariant 3's rule, applied here).
- **Recorded at the change**, in the same transaction, with who made it: one function,
  `recordSopRevision(tx, agentIds, {by, where})`, called where the setup changes (a version goes
  live or is rolled back; the agent's people, bindings, approver, area or stage; a connection's
  permissions; a grant; the client's approver rules or business hours; an area owner's name; a client
  adjustment). It makes the SOP, compares its fingerprint with the last revision's and adds a row only
  when they differ, so a change that alters nothing in the SOP makes no revision.
- **A safety net, not a source**: the hourly pass compares each live agent's SOP with its last
  revision. A difference means a change site doesn't call `recordSopRevision`; it records the
  revision as "Recorded by our hourly check" and reports the gap to Sentry, so we fix the call site.
- **The first revision**: when S1 ships, each agent's SOP is recorded as its first revision ("First
  revision of this SOP"), dated that day. Earlier history isn't rebuilt: older settings changes have no
  SOP to compare with.
- **Printing and sharing name a revision**: a print says "Revision 7.2 of 18 Nov 2026" on every page,
  and a share link (S3) shows the revision it was made from.

## 7. Questions for the owner

Answered (owner, 2026-11-21): **no open items in an SOP, and no sign-off of revisions**; an SOP
carries its revision, the revision's date and its history instead (§3, §6). **The tab is "SOP"**, in
the Manual tab's place. Still open:

1. **An accountable person per agent.** A formal SOP names one person who answers for the process.
   Recommended: the client admin picks one of their own people per agent (a field on the agent row,
   like renaming the area owner: it changes nothing the agent does). Until then it reads the agent's
   approver ("Your admins: Ada Ruiz, Ben Ortiz"). CLAUDE.md says clients never edit agents except to
   rename an owner, so this needs the owner's yes.
2. **Share links outside the client's team.** Yes or no, the default expiry, and whether names show
   by default. They hold no client records, only the setup, but they are the first client page
   anyone without a sign-in can open.
3. **The back office.** Show the client's SOP on the agent's page (recommended), and a template's
   sample SOP for sales, with "the person you name" in place of people (later).

## 8. The build, in streams

Each ends green (`pnpm check`). Migrations go in their own PR and keep the previous Worker working.

| Stream | What | Migration |
|---|---|---|
| **S0** (built, PR #510) | Fix: the manual's route on `ASSIGNED_USER_ROUTES`, with a test that a limited client user opens their agent's manual and gets 404 for another's | None |
| **S1a: revisions' table** (built, PR #511) | `sop_revision` (§6): tenant, RLS forced, never updated or deleted. Nothing reads or writes it yet, so the Worker before it keeps working. | `sop_revision`, own PR |
| **S1: the SOP** (built, PR #508) | ARCHITECTURE v0.21 §10.17 and a `docs/plan.md` §1 entry. Core `sop/`: `SopView` (Zod), `sopView()` and its parts (`sopRoles`, `sopSteps` with each step's method and model, `sopControls`, `sopSystems`, `sopData`, `sopExceptions`), `sopChanges()`, paths in plain words in core (`pathWords`; the builder keeps its `ruleText`), v3 steps read for their tools as v4's are. The step's `purpose` in core's schemas and a box for it in the builder's step panel (the Builder writing it is SOP-B). Revisions: `recordSopRevision` at every change site with a test listing them, the hourly check, each agent's first revision. API: `GET /api/services/:id/sop` (portal, on `ASSIGNED_USER_ROUTES`) and `GET /api/ops/agents/:id/sop`, gathering the inputs in one transaction inside `withTenant()`, names resolved within the client. Web: `apps/web/src/sop/` (shared sections, from `ManualSections`), the portal's SOP tab in place of Manual, the revision header and history, find and filter, the print layout. Six languages. Contract tests for both routes. | None beyond S1a |
| **S2: ask, across agents** | Sloan's `sop.read` (its fixtures re-recorded). The Procedures page with filters across every agent's SOP. | None |
| **S3: share, owners, pack controls** | `sop_share` (token hash, revision, expiry, revoked, who made it, names on or off) and its public page, with a security review and a row in `docs/security.md`; the accountable person on the agent row; `SkillDefinition.controls` and the Materials and Bookkeeping packs' controls. Only what the owner agrees in §7. No sign-off of revisions (owner, 2026-11-21). | One per table, own PRs |

**Done when (S1).** At a sample client with "Bills in" live: a client user opens the SOP tab and sees
all thirteen sections with nothing waiting on anyone; every write step's control line matches what
the gate decides (a test runs the gate and the SOP on the same setup, for each mode, stage, matrix
level and grant); every step says whether it runs on rules, AI or a person, and each AI step names the
model the runtime would call (a test resolves both the same way); turning a connection's create from
Ask me first to On its own, on a step set to not required, changes that step's line and makes revision
7.1 dated today, "Changed by" the person who did it, with the old and new value; filtering by Ben shows
only his steps; the printed page carries the code, revision and revision date on every page; the
portal route's response has no forbidden field; a limited user sees only their agents' SOPs.

**Invariants held.** 1: one client per request, names resolved within it, learned notes per client.
2: core computes; packs reach the SOP only through their manifests' data. 3: revisions are
immutable; a step's `purpose` is part of the version, changed only by a new version. 4: the SOP reads version rows and settings, never
code. 8 and 13: controls are read from the gate and the grants, never restated. 9: no untrusted text
becomes an instruction; nothing a model writes at view time is shown (a step's purpose is written
when the step is built and the operator reviews it, like its name). 11: no bundle, instructions, prompts or cost (the
owner chose to show each AI step's model, 2026-11-21); contract tests. 14: every route is `mount()`ed; share-link opens write their own audit rows.
