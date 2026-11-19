# Builds that work first: decisions, the agent manual and governance (agreed 2026-11-19)

Owner, 2026-11-19: "Build something that works per the description before we start identifying all
the permutations it could take." And: "Plan, then we build. Don't modify the flow and UI materially
from where we are; just get it across the line." This page is the plan. It keeps the build's phases
and screens (`docs/plan.md` §1.108, §1.152, §1.153) and changes what happens inside them.

## 1. Why

The "Invoice and receipt intake to vendor items" build on staging (2026-11-18):

- Intake, fit-gap and five drafts before the agent touched one document.
- A missing piece ("is this a materials purchase?") became a second build with its own phases, and
  the template waited on it.
- The POC test was model-made inputs checked against model-made answers, field by field: 30 of 30
  template cases failed, 24 of 24 skill cases errored, and neither the operator nor the Builder
  could see why.
- Four tooling bugs on the way (a 500 on Agree, test cases cut off, no live results, no error text).
- Questions about the Purchasing area itself (what goes in the catalog, who owns line matching)
  were settled inside one agent's build.

## 2. Principles

1. **Works first.** The Builder drafts the happy path end to end, fixes the gaps on that path, and
   tries it on real examples before anyone lists what else could happen.
2. **The AI decides what it can.** To make the flow run, the Builder makes the decisions it needs and
   they become part of the process. No confirmation is asked, except for the **high-risk** ones
   (§4.2). Every decision is written down, so a person can ask about it and the agent knows it was
   never discussed.
3. **Decision points over exceptions.** Where the agent can't know, the process has a step where a
   person decides (a person step). That is the rule, not the exception.
4. **Client-specific means setup.** A decision that differs by client is a question on that client's
   setup checklist, answered once at onboarding, not a guess in the template.
5. **Clients improve their agents.** A client can give feedback and adjust the rules we let them
   adjust. Changes to steps go through the existing change flow.
6. **Governance in tiers.** Every agent reads the same charter, the policies for what it is doing, and
   its own manual, and can read other agents' manuals.

## 3. The flow (phases and screens unchanged)

| Phase | What changes inside it |
|---|---|
| Intake | Unchanged since §1.153: the normal case only, strict starting values. |
| Fit-gap | Unchanged since §1.153. The Builder starts its decisions list here (§4). |
| Draft | The draft's problems are shown as **gaps on the path** first (a missing step; two steps next to each other that don't fit, one's output against the next one's input), then the rest. The Builder fixes them and records each decision it makes on the way. A missing piece is a person step or a simple rule in the first version; a skill build of its own only when the piece will be reused. |
| POC test | **Try it on real examples.** Upload a document (or pick a Sandbox record), run it as a test run (writes nothing), mark the result right or wrong. Right: it is kept as a test case, its result as the expected answer. Wrong: say why in the conversation; the Builder proposes the fix. Model-made test cases stay as an option, never the default. The gate: the cases you kept pass on the latest draft, and no high-risk decision is unreviewed. |
| Client test | Unchanged, plus: the client's setup checklist (§6) has the items that guard the trial done. |
| QA and go / no-go | Unchanged, plus the manual (§5) is filled: every known risk accepted or fixed, every decision point owned. |

The build page keeps its cards. Two lists sit beside the issues: **Decisions** (§4) and **Known
risks** (§1.153, already there as put-off items). Nothing else moves.

## 4. Decisions

### 4.1 What is recorded

Every decision the Builder makes about the process, one row each:

| Field | What |
|---|---|
| What | "Freight, tax, deposits and fees stay out of the catalog." |
| Why | One sentence: what it rests on (the brief, the catalog, a document it read). |
| Value | When it is a number or a list: the starting value. |
| Kind | `assumption` (the AI decided; part of the process), `decision_point` (a person decides in each run: a person step), `client_setup` (differs by client: goes to the setup checklist, §6). |
| Risk | `high` or `normal` (§4.2). |
| Status | `never discussed`, `discussed`, `changed by {who}`, `confirmed by {who}`. |
| Where | The step it shapes, if one. |

The Builder adds rows in its turns (a `decisions` list in its answer, as `items` today). The
operator can ask about one (the conversation's "Talking about", as for issues), change it (an
`edit_draft` proposal), or mark it discussed.

### 4.2 High risk: the only ones we stop for

Worked out by code from the draft, with the Builder's flag on top. Proposed list, for the owner:

1. Writing into a client's tool (when writes start, which verbs, which records).
2. Money: amounts, limits, anything that changes a balance or a payment.
3. Contacting people outside the client (vendors, customers): who, how, how often.
4. Data leaving to a vendor of ours (`packages/core/src/compliance`), and HIPAA mode.
5. Approvals, permissions, grants and who signs (invariant 8: these only ever start strict).
6. Overwriting or removing a client's records.

A high-risk decision must be reviewed (discussed or confirmed) before the client test. Everything
else is part of the process and never holds a phase.

### 4.3 Where they live

On the build while it is open; on the agent's manual (§5) once it is drafted, so they travel with
the agent and outlive the build.

## 5. The agent manual (tier 3)

One structured document per agent: the agent's knowledge base. Kept in the agent's version
(`definition.manual`), so it is versioned with the agent (invariant 3), travels with a template and
its copies, and merges like the rest of the bundle. What an agent learns is never in it: that part
is read live, per client (invariant 1).

| Section | Written by | Client sees |
|---|---|---|
| What it does | The Builder, from the brief | Yes |
| How it works | Code, from the process: its steps in words, never prompts | Yes |
| Decisions | §4: each with its kind, risk and status; "never discussed" shown as such | Yes |
| Decision points | The person steps: who decides what, and by when | Yes |
| Known risks | The put-off gaps, with how often runs hit each (§1.153) | Yes |
| What we set up with you | The client's setup answers (§6) | Yes, their own |
| What it learned | The agent's memory notes for this client (`memory_note`), reviewable and deletable | Yes, their own |
| What it reads | Policies (§8), the client's knowledge base, other agents' manuals | Yes |

- **Back office:** a Manual tab on the agent's page.
- **Portal:** a Manual tab on the agent's page, read only. A client-safe view built by code: never
  the bundle, instructions, prompts or cost (invariant 11, with a contract test). "Ask about this" on
  any line opens the area owner's chat about it.
- **The agent knows what was never discussed.** At a step, the decisions that shape it and are still
  `never discussed` go in its notes (data, invariant 9). When its output rests on one, the approval
  card says so: "Based on a decision nobody has discussed yet: freight stays out of the catalog."

## 6. Client-specific decisions become the setup checklist

- A template build's client intake form (§1.108, "Client intake form") already lists what we ask
  each client. Every `client_setup` decision joins it.
- When a template is copied to a client (onboarding's Invite, or the lab), the copy gets a **setup
  checklist**: connect a tool, answer a question, upload a file, confirm a decision point ("When do we
  start writing into QuickBooks?", "Who signs bills over $5,000?"). It shows in the portal's Getting
  started (§1.149) and on the copy's page in the back office.
- Answers become the copy's settings by code, as a new version (the "client settings" class,
  ARCHITECTURE §10.15).
- Each item says which stage it guards: setup, the trial (the writing and approval items), or
  go-live. The stage doesn't move until those are done.

## 7. Clients adjust and give feedback

Already built: "Tell" on a run step (the area owner's chat), rejection reasons, and the owner's
suggestions from repeated corrections and edits (§1.117, O8).

Added:

1. **Rules a client may adjust.** The operator marks a setting as client-adjustable, with bounds
   (a tolerance between 0% and 5%; a list of categories; a schedule; who is contacted). The client
   admin changes it on the agent's Settings in the portal.
   - Tightening, or a change within the bounds: applied at once, as a new version by code.
   - Beyond the bounds: a request to us.
   - Never: approvals, permissions, new writes or new steps (the "never" class, §10.15).
2. **Feedback on a decision.** "This is wrong because…" on any line of the manual files a change
   request linked to that decision. The owner turns it into a suggestion; a step change goes
   through the existing flow (owner suggests, operator applies).
3. **Every change is written in the manual** with who made it and when, so the next person (and the
   agent) can see the rule was set on purpose.

## 8. Governance in three tiers

| Tier | What | Read |
|---|---|---|
| 1. Charter | **The client's charter**: who the business is, how it speaks, what matters to it, what it never does. Drafted by us from the onboarding facts (the client file, §1.149) and confirmed or edited by the client admin; it shows in the portal's Knowledge. Under it, in the background, **the Mezonas guardrails**: how the platform works and what goes on behind the scenes (tools only, evidence, data is data, approval stays on, never move money, privacy, what each kind of step can and can't do). Today's `PLATFORM_PREAMBLE`, grown into a short document. Clients never edit it; the portal shows it only as "How Mezonas agents work". | Every model call, first |
| 2. Policies | Tagged by what they cover: security, writing into tools, money, contacting people, data handling, people and roles, and each business area. **Mezonas' standard policies** (from `docs/policies/`, rewritten for agents) and **the client's own policies** (`knowledge_entry` kind `policy`, already built, plus tags). | When a step does what the tag covers: a write step reads "writing into tools"; a message step reads "contacting people"; every step reads its area's |
| 3. Manuals | Each agent's manual (§5). An agent can read another agent's manual for the same client with a read tool (`manual.read`): AP Invoice Review reads what the intake agent records. | When needed |

- **Order:** the Mezonas guardrails win, then the client's charter, then policies, then the manual.
- **What a client's text can do:** add rules and tighten. It can never loosen an approval, change a
  permission or change the plan (invariants 8, 9).
- **Updates keep everyone informed:** each document is versioned; agents read the current version at
  run start and the run pins the versions it read (as `run.owner_version_id` does), so a replay
  reads the same. A change to a policy is noted in the manuals that use it.
- **Cost:** tier 1 is short and cached; tier 2 only by tag; tier 3 only on request.
- **Where kept:** the Mezonas guardrails and standard policies are platform text, like today's
  `PLATFORM_PREAMBLE`: Markdown in `packages/core/src/governance/`, versioned with the code, each
  with a version id a run records. // DECISION (2026-11-19): not database rows; they describe how the
  platform itself behaves, change only with the code, and no client or operator edits them. The
  client's charter and policies are the client's knowledge base entries (`knowledge_entry`, kind
  `policy`, with their tier and tags in the version's `meta`), per client under RLS (invariant 1).

## 9. Milestones

In order; each ends green.

| # | What | Size |
|---|---|---|
| B0 | **Across the line.** Merge #433 (Agree on "run the tests"; test cases cut off). A failing case says why (its error, or the fields that differed) on the page and to the Builder. Test results refresh while a run is going. | Small, no migration |
| B1 | **Try it on real examples.** In the POC: upload a document, run it as a test run, mark it right (kept as a case, its result the expected answer) or wrong (to the Builder). The gate counts the kept cases. A missing piece is a person step or rule in the first version. | Medium, no migration |
| B2 | **Decisions on the build.** The Builder's `decisions` list; the high-risk check by code; the Decisions card; the client-test gate on reviewed high-risk ones. | Medium, no migration (the fit-gap record) |
| B3 | **The agent manual.** `definition.manual`; the back-office and portal Manual tabs; the client-safe view and its contract test; never-discussed decisions in the step's notes and on the approval card. | Large, no migration (bundle JSON) |
| B4 | **Setup checklist.** `client_setup` decisions and the intake form become the copy's checklist; Getting started shows it; answers become settings by code; stages wait on their items. | Medium, no migration |
| B5 | **Client adjustments and feedback.** Client-adjustable settings with bounds; the portal's Settings; feedback on a manual line as a change request; changes written in the manual. | Medium |
| B6 | **Governance tiers.** The Mezonas guardrails and standard policies as platform text; the client's charter drafted from onboarding facts and confirmed; policy tags; the runtime reads tier 1 always, tier 2 by tag, tier 3 by tool; runs record what they read. | Large, no migration |

After B1 we run the expense agent (Nexonia) and the invoice intake builds again on staging, and count
the operator's actions from New to a running trial. Target: under 15 for a flow that simple.

## 10. Agreed (owner, 2026-11-19)

The plan as written, with:

1. **High-risk list (§4.2):** as listed.
2. **Client-adjustable bounds:** set by us on the template; a client copy keeps them unless we change
   them for that client.
3. **The client's charter:** drafted by us from the onboarding facts, confirmed or edited by the
   client admin. The Mezonas guardrails are a background document, not the client's to edit.
4. **Child skill builds:** for reusable pieces only.
5. **ARCHITECTURE:** a new version section once built, and each milestone's decisions in
   `docs/plan.md` §1.

**No migrations in this sprint.** Each record has a home that exists: decisions in the build's
fit-gap record (as the intake form is), the manual and the checklist's items in the agent's
definition, a client's answers as a new version of its copy (the "client settings" class), the
confirmations that guard a stage in the copy's `agent.stage_state`, client charters and policies in
the knowledge base.
