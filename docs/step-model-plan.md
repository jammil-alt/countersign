# Steps, skills and loops: the new step model

Owner, 2026-11-25: "It is really hard to be able to add a step manually... we should be able to
understand what the step does, provide the input and then dictate the output... I have not been
able to run an agent yet, after weeks of trying, because I can't add a step that is not dependent
on the builder." Then: "ok to purge.. we can start from scratch... we need to get it right this
time... lets go item by item first."

This page is the plan we agree on before anything is built. It is a living document: each section
says whether it is **Agreed** or **Open**, and the decision log at the end records every change with
its date. Nothing here is built yet. Where this page and the working spreadsheet (the inventory of
every skill and tool, kept outside the repo) disagree, this page wins.

Last updated 2026-11-25.

## 1. Why

- A workflow a person designs in ten lines took 28 steps to build. The Invoice item matcher (Demo
  client, staging) needed five steps to read one invoice, a check step after every AI step, and
  glue steps only because one tool's "lines" differ from the next tool's.
- Inputs are wired as `{{steps.<uuid>.output.extraction.header.vendorName}}`. A step added by hand
  has nothing to pick from, which is why a hand-added "Check matches" step blocked publishing.
- A skill step could carry 38 settings, some in two places (`settings` and `customize.settings`,
  `model` and `customize.model`; a skill's `settings` and `parameters`).
- 164 skills were registered, 117 of them only a tool under a second name.

## 2. Principles (Agreed)

1. **Purge and start from scratch.** No agent is live. Every agent, version, run and build is
   deleted once, and the templates are rebuilt in the new model. Nothing is kept only because
   something uses it today (owner, 2026-11-25: "Now is the time to release what will become tech
   debt"). See §12.
2. **The builders stay.** Both the Builder (the AI that drafts agents with you) and the workflow
   builder (the canvas) stay. The aim is that a person can read and change anything the Builder
   drafts, without going back to it.
3. **Use the words everyone uses**, except where ours are already clear (§3).
4. **Deterministic first, model second, person last** (invariant 7), visible on every step.
5. **Triggers stay as they are today.** They work and are well thought out.

## 3. Terms (Agreed)

| Term | Meaning |
|---|---|
| **Agent** | The worker for a client. It has one or more workflows. |
| **Workflow** | An agent's triggers, its steps, and its declared outputs. |
| **Trigger** | What starts a run, as today. A trigger that needs work before the main line (the daily QuickBooks check finds the bills first) has its own steps on a branch that joins the main line. |
| **Step** | One unit of work or flow with one goal. Eight kinds (§4). |
| **Done by** | Who does a Do step: Rules, a model (AI), or a Person. |
| **Tool** | Code that gets, saves or sends, with no judgement: OCR, browser, email, QuickBooks, catalog search. Built by developers; a new one is a Dev queue request. |
| **Skill** | A prepackaged step: a saved Do (rules, or one AI answer) or a saved Loop, with its instructions or rules, input, output, tools and model. Versioned, testable on its own, reusable across agents. One client's, or shared with every client. A skill is to a step what an agent template is to an agent. |
| **Instructions** | How a step does its work: rule rows and values for Rules, prose for AI, the question for a Person. |
| **Checks** | Switches on a step, never steps of their own: **Approver**, **Confer** (a second opinion), **Review**, **Tell after**. |
| **Loop** | A model working toward a goal, choosing its read tools, until done or at its limit (standard agent language). |
| **For each / Repeat** | Run the steps inside once per item / again until done. Fixed steps, predictable. |
| **Automation** | Several steps saved to reuse as one step. |
| **Match** | Exact match, Semantic match, or Hybrid (exact first, then semantic). |
| **Confidence threshold** | The confidence at or above which a semantic match is accepted. |
| **Match profile** | What one kind of record is matched on (§7). |
| **Workflow output** | A declared result of a workflow: a report, a write to a tool, a record saved, a hand off, or "Nothing to do" (§9). |

Kept from ours (owner, 2026-11-25: "I generally like ours"): Do, Loop, Fork, End, Automation,
Approver, Confer, Shortlist. Taken from common use: Workflow, Trigger, Done by, Exact match /
Semantic match / Hybrid, Confidence threshold.

## 4. Step kinds (Agreed)

| Kind | What it is |
|---|---|
| **Do** | One piece of work, done by Rules, AI (one answer) or a Person. Covers reading data, saving and changing records, telling someone, asking someone, and using a skill or an automation. |
| **Loop** | A model works toward a goal with read tools until done or at its limit (§8). |
| **Fork** | Take one of several paths. Rules decide, or a model chooses among the paths the operator built. |
| **For each** | Run the steps inside once per item of a list. |
| **Repeat** | Run the steps inside again until a rule, or a model judging a goal, says stop. |
| **Wait** | Pause the run. |
| **Hand off** | Start another agent's run, or another workflow of this agent, at a chosen step. |
| **End** | Where a path finishes, delivering one or more of the workflow's declared outputs (§9). |

A step that needs code that doesn't exist yet stays in place as "Not built yet" and can file a Dev
queue request (today's `missing` step).

**The eight kinds are stored as they are** (owner, 2026-11-25), not translated into today's fifteen
stored kinds: with the purge nothing old has to keep running, and a hidden translation layer would be
the next tech debt.

**How a Do step runs.** Nine of today's kinds become Do. A Do step is stored once, with its **Done
by** and its **Uses**, and those two pick the engine that runs it. Every engine already exists in the
executor (`packages/workflows/src/executor.ts`); what changes is that one Do step chooses among them,
instead of each being a kind of its own.

| Done by | Uses | Runs as (today's kind and engine) | Checks it can carry |
|---|---|---|---|
| Rules | A Get tool | `read`: calls the tool | Confer, Review, Tell after |
| Rules | A Save-to-records or Change tool | `write`: an external action, once, with its before state and the approval gate (invariant 8) | Approver (on by default for a Change), Confer, Review, Tell after |
| Rules | A send tool (inbox, email, text) | `notify`: tells the client's team or ours | Tell after |
| Rules | Rule rows or a data job written in the step, or a rules skill | `skill` (rules): evaluated in code | Confer, Review, Tell after |
| AI | Instructions written in the step, or an AI skill | `skill` (task): one model call, its answer checked against the output fields | Confer, Review, Tell after |
| Person | Nothing, or "Collect reports" | `person` (approve or ask, with a deadline), or `collect` (several people, follow-ups, escalation) | Tell after |
| Outside contact | Nothing | `conversation`: a back-and-forth until the goal is met; each message an approved send | Tell after |
| (the automation's own steps) | An automation | `process`: its steps run in place | Approvers set per inner write |
| Not chosen yet | Nothing | `missing`: never runs; blocks publishing | None |

Combinations not in the table can't be saved: an AI or a Person never uses a write tool (skills and
models never write; the Rules step after them does), and only a Change to a client's tool carries an
approver. Three things are keyed by kind today and move to Done by and Uses with the collapse: what
a step's **outcome** can be (what a Fork routes on: done, empty, rejected, no answer...), the line the
**client's timeline and SOP** print for it, and how **merges and diffs** name it. Step ids stay as
they are.

## 5. The Do step (Agreed)

What a person fills in:

| Box | What goes in it |
|---|---|
| **Goal** | What it does, one sentence. |
| **Done by** | Rules, AI, or a Person (or an outside contact). |
| **Uses** (optional) | A tool, a skill, or an automation. |
| **Input** | Picked as "step name › field"; translated automatically when the fields differ (§6). |
| **Instructions** | Rule rows and values; or prose; or the question and the answers offered. |
| **Output** | The fields it hands on. |
| **Checks** (optional) | Approver (on by default for every change to a client's tool, invariant 8), Confer, Review, Tell after. |

Folded under **More**, with defaults: model, if it fails, whether the client sees it, run by
another agent, deadline, channel. The main form shows only the boxes above; if more fields creep
onto it, we are back where we started.

**The Data tab** (owner, 2026-11-25: "inside a step we should have a visual JSON of what the data
that is coming in looks like and what the data that will go out will look like... This will help
humans understand the flow better"; "this is simply to understand as we are managing it. Make it
work, that is the priority"). Every step in a workflow has a **Data** tab next to its settings, in
three parts: **Coming in** (the data as the step before hands it over, as JSON), **Changed** (what
the incoming side translated and what the step did with it), and **Going out** (its output, as
JSON). The values come from the step's last test run, otherwise from sample data made from the
fields' types (plan §1.185, as built). It is for understanding, not a check, and it is in the back
office only.

**Suggest** (owner, 2026-11-25: "Many fields will be irrelevant to the end user as long as the flow
works, I don't want to force them to have to think about every one, but have the option of changing
them"). A **Suggest** button with the AI icon (the one the SOP already uses) sits at the top of every
step's form, and beside every field. It opens a small pop-up with three choices:

- **Tell it what you need**, in your own words ("only lines over $500", "ask Maria, not the admin").
- **Use the default.**
- **Resolve**: fix whatever is flagged (a field that doesn't fit, a required field left empty).

At the top of the form it works on the whole step, from the step's goal and the workflow around it;
beside a field, on that field only. What it suggests is applied straight away, and Undo takes it
back. The Builder's AI does the work, held to the same rules as a person: it can't save a combination
the form refuses.

**What a person can't change on a step** (shown, so the step reads in full):
- the step's id;
- the fields a tool or a saved skill takes and gives (the skill itself is changed in the skill
  editor, as a new version);
- a match profile's allowed keys and "never the same if" rules (set by the area that owns the
  records);
- anything looser than the client allows: an approver can be switched off only where the client's
  connection allows it to run on its own, and delete stays off (invariant 8);
- a Loop's tools beyond reads, and an End's existence (it can be filled, not removed).

**Rules and AI written in the step.** A deterministic Do is a tool call, rule rows (when these
conditions hold, set or work out these fields), or a data job (reshape, filter and total, read or
write a table). Rules or instructions are written in the step itself. **Save as skill** turns them
into a skill in the library (name, description, this client only or shared), and the step then uses
it. Anything beyond rules and data jobs is new code: a tool, through the Dev queue.

**Writes to our database** are a Do step done by Rules, using a "Save to our records" tool. There is
no raw "save this to a table": every write goes through a tool owned by a business area, which
checks the data, keeps clients apart, records the agent version and the evidence, and never saves
twice. A model, a Loop or a person decides; the save step after it writes. Several parts are saved
by one tool that writes them together, or by a chain of saves where each picks up the ids of the
one before. Prefer to decide first and save once.

## 6. Data: inputs and outputs

**Agreed:**
- Inside a workflow, everything moving between steps is structured data (JSON underneath, never
  seen). Format (CSV, XLSX, PDF, email) matters only at the edges: a file comes in as a Document and
  a reader turns it into fields; a writer turns fields into a file going out.
- **Each step defines what it needs** (owner, 2026-11-25: "Steps can define what they need, we
  should not have the concept of a named field unless there is a strong benefit"). There are no
  named, shared data shapes and no extra terms for inputs and outputs. A step's fields are its own:
  a name, a type and whether it is required.
- A step's input and output fields always come from one of three places, never from a model at run
  time: the tool or skill it uses; the setting that picks a profile or record type (Match to, Save
  to); or what the person writes in the step (rules, instructions, Read table's columns, a
  mapping).
- **One skill, different data.** A skill meant for reuse names its input fields for the job, not for
  one kind of data (Classify takes a name, a description and an amount). Each agent's Input box maps
  its own data onto those fields. Two skills are needed only when the action itself differs, not the
  data. No extra "works on" setting (owner, 2026-11-25: "only if we need it, I don't want to
  convolute").

**Agreed: translation is part of the step's incoming side** (owner, 2026-11-25: "if a step requires
input in a certain shape and the previous step has a different shape, then we would automatically
modify it as part of the step... as part of the incoming part of the step"). There is no separate
step for it. Every connection into a step is in one of three states:

| State | What it means | What happens |
|---|---|---|
| **Fits** | The step before hands on every field this step needs. | Nothing to do. |
| **Translated** | The fields differ, but every field this step needs can be filled from what came before: copied, renamed, converted or worked out. | The builder writes the translation automatically into the step's incoming side, where it can be seen and changed. |
| **Doesn't fit** | The data just isn't the same: a field this step requires has no source. | Flagged as an issue. The workflow can't go live until it's resolved. |

The translation is worked out when the workflow is built, saved with the step, and runs as code:
no model at run time, so the same data always translates the same way, and money stays decimal. It
uses Reshape's mapping and calculations as built (2026-11-11): matching by name, spelling, common
synonyms and type first, and AI suggestions only for what is left.

Nothing the builder translates needs confirming or marking (owner, 2026-11-25: "lets not
overvalidate things, assumptions are ok and tweaks will come after"). Only "doesn't fit" blocks
going live.

## 7. Match (Agreed)

One **Match** step serves every kind of record. Its first setting is **Match to** (vendors,
clients, master items, CRM records), which picks a **match profile**. The profile is defined once
by the area that owns the records: the fields matched on, the keys allowed for an exact match, the
text used for a semantic match, the "never the same if" rules, and where the records and their
learned names live. The profile sets the step's input and output; the output is always a **Match
result** (what came in, the matched record or none, how it was matched, the confidence, the
candidates). The code is already most of the way there: the matching engine in
`packages/core/src/matching` (plan §1.215) runs on a configuration per pair of lists.

Settings on the step:

| Setting | Meaning |
|---|---|
| **Match type** | Exact match (keys only, never a near match) · Semantic match · Hybrid (exact first, then semantic for what's left). Exact match is offered for every kind of record. |
| **Keys, in order** | From the keys the profile allows. |
| **Confidence threshold** | At or above it a semantic match is accepted (default 90%, to be set from the goldens). An exact match is 100%. |
| **Second opinion from / by** | Between this level (default 70%) and the threshold, each line gets a second opinion: AI (a different model by default), a person, or AI then a person if they disagree. |
| **Below the floor** | A person decides, or it is no match, or it is new. |
| **Search too weak** (optional) | If even the best candidate scores under this, the model is skipped. |
| **Shortlist the model sees** | Default 20, cap 50; the right default is measured on the matching goldens at 5, 10, 20 and 30 (precision on "same" stays at 95% or more). |
| **Shortlist a person sees** | Default 5, with the model's pick and reason. |
| **No match means** | Not found, new, or ask a person. |

**Where matching happens** (owner, 2026-11-25: "if we need to match it has to be in our system,
otherwise we need the ID to do a lookup"):

- **Matching is always against our records**, kept in sync from the client's tools. An outside id
  (the QuickBooks vendor id) is a field on our record. A match can then use what only we hold (other
  names, past wording, people's corrections), it is fast and the same every time, and one profile
  works whichever accounting tool the client uses.
- **No table per matchable type.** Anything a connector syncs is kept as raw copies in one table
  (`raw_record`). A profile can match those directly, with a small index of their keys (how Sales
  matches CRM records today). A table of its own is built only when an area owns and adds to the
  record beyond matching (vendors, transactions, catalog items; ARCHITECTURE §5.2).
- **Outside a sync, it's a lookup by id, not a match.** With the outside id in hand, a Do step done
  by Rules gets the record by id: exact, no AI, no profile. Where the id is sometimes there, it is a
  profile's first key ("Vendors: QuickBooks id, then tax id, then name"), so it hits at once when
  present and falls through when not.

**Vendor items** (owner, 2026-11-25): a SKU match or nothing. "I don't want it finding a near match
and then calling it the same. In some cases a near match is not a match."

**Open:** who adds a profile (proposed: developers, because it touches where records live; the
person sets keys and thresholds on the step). Whether a vendor's exact past wording (a line confirmed
before, word for word) counts as a key next to SKU: it is exact, not near, and without it a vendor
whose invoices print no SKU makes a new vendor item every time.

## 8. Loop (Agreed)

A Loop is a model working toward a goal: it chooses which read tools to call, looks at what comes
back and decides the next call, until the goal is met or it reaches its limit. It is built and
tested in the Agent lab's **Loop designer** (laid out like the skill builder), saved as a skill, and
used as one step in a workflow, or as the whole workflow (a trigger, the Loop, then an End). It is
used only where the path can't be known ahead (investigating, researching, sorting out leftovers);
fixed steps are used where it can.

It has a goal, an input, an output, its tools (read tools only), instructions, a maximum number of
turns, what happens at the limit (stop, or hand back what it has), and Confer and Review. It never
writes: what it decides is delivered by an End or saved by a Do after it, with the approver check.
It can't be published until its test set passes in the lab, and its test view shows every turn: the
tool called, what came back, what it decided next.

This brings back agent-mode skills, retired for new steps on 2026-11-10 because they could propose
writes; a Loop reads only, which answers that reason.

## 9. Workflow outputs and End (Agreed)

A workflow declares its outputs, next to its triggers: triggers are the declared ways in, outputs
the declared ways out. Each output has a name, a kind (report, write to a tool, save to records,
hand off, or Nothing to do with a reason), where it goes, and its fields. The list is what the
workflow promises, so it belongs in the agent's description and the client's view.

Every path that doesn't rejoin the main line finishes on an **End** card, which the builder adds
itself (as the trigger is always first); it can't be deleted, only filled. Each End selects one or
more of the declared outputs and does the delivery itself, each delivery with its own checks. One
End can deliver several outputs, such as writing the matches to QuickBooks (approval on), emailing
an exception report to AP when there are exceptions, and saving the purchase. A run that fails on an
error ends as Failed by itself and goes to the supervisor; End cards are for the outcomes planned.

Publishing is refused when an End selects no output, when it delivers something not on the list,
or when a declared output is never selected by any End (owner, 2026-11-25: "Block publishing, lets
make sure we don't have silent deaths"). This replaces the 2026-11-23 decision to work the ending
out from the steps.

## 10. The Builder and skills (Agreed in outline)

The Builder drafts in the same model a person uses, so its drafts read like something built by
hand. It reuses library skills first; writes rules or instructions in the step when nothing fits;
suggests **Save as skill** when the same instructions turn up in a second agent; puts a "Not built
yet" step and a Dev queue request where code is missing; and drafts Loops with a goal, read tools and
a limit. Reuse first and "Not built yet" work today.

## 10a. Skills rebuilt after the purge (Agreed)

Of the 164 skills registered today, the 117 that are tools under a second name go. Of the rest, by
area (owner, 2026-11-25, agreeing the list as suggested):

- **Documents:** Read document (AI), with Check totals folded in as its rules; Prepare bill (AI),
  with Check bill folded in, using Choose account.
- **Data jobs:** Filter, group and total; Read table; Write table. Reshape stays as the engine behind
  the automatic translation, not a step to pick.
- **Writing and forms:** Draft in their voice (one AI answer, no longer agent mode); Draft a form.
- **Purchasing:** Read a request to buy; Read a vendor's quote (the "with the document" copy merged
  in); Read a vendor contract; Compare to historicals; Review notes for AP; Choose items to merge.
  Match vendor, Match by SKU and Master item manager become the match profiles Vendors, Vendor items
  (exact match only) and Master items. Dropped: Semantic match (vendor), Look up existing, Match the
  unmatched, Find duplicate catalog items. Check matches folds into the Match step.
- **QuickBooks and AP:** Choose items and accounts (the agent-mode twin dropped).
- **Bookkeeping:** Read a statement (the "document" copy merged in); Suggest matches for what's
  left; and **the leftovers investigation rebuilt as the first Loop**.
- **One "Choose account"** replaces Suggest accounts (AP), Propose accounts (Bookkeeping) and the
  account choice inside Prepare bill; Categorize bank transactions (its agent-mode twin) is dropped.
- **Marketing:** Write the weekly report, Write titles and descriptions, Write an article, Write a
  forum reply, Write a LinkedIn post; the five agent-mode twins dropped.
- **The platform's own, not in the library:** Look into a problem (a Loop), Explain a problem, and
  Sloan's account conversation.

## 10b. The owner and the supervisor (as built; unchanged)

Two different things watch an agent, and both stay:

- **The owner** (one per business area per client; ARCHITECTURE §10.11, §10.14, §10.15) watches every
  step of a run. A cheap check (no model) looks at every step's result; a model looks only at a step
  that failed, a result that looks off, or a step whose output feeds a write. It may let it go on,
  retry, retry with a corrected input (the gate decides any write again), ask the lead, or stop. It
  never changes the plan, an approval or a permission (invariant 9). New agents start with failures
  reviewed and writes verified; at most 2 reviews a step, 3 a run, $0.25 a run by default. A step's
  **Review** setting (owner decides, always, off) is this.
- **The supervisor** (Sloan's side for us, one per client) works at the level of the account: a daily
  health check, and **Look into a problem** (a Loop) and **Explain a problem** when a run failed that
  the owner couldn't fix, or a connection needs a person.

## 11. The Invoice item matcher (acceptance test)

The matcher is not a build of its own: it is rebuilt by hand in the new builder, and the build is
done when that works.

- **Trigger 1:** a document is read.
- **Trigger 2:** every day at 7:00; find the last 7 days of bills; get each bill's invoice; for
  each, hand off to the main line.
- **Main line:** Read the invoice (AI, OCR) · Match vendor (Match to vendors, hybrid) · Fork: vendor
  not found → End (Vendor not found) · Match lines to the vendor's items (Match to vendor items,
  exact match on SKU) · Match new lines to master items (Match to master items, hybrid, Confer on) ·
  Fork: unsure lines → Do (Person: client admin decides) · End (Purchase saved; Exception report).
- **Declared outputs:** Purchase saved (records; Purchasing report), Exception report (email to
  AP), Vendor not found (email to bill-questions), Nothing to do.
- "Already reviewed?" comes back as a rules Fork once a tool answers whether a document has been
  through this agent (Dev queue).

## 12. Release: what the purge removes (to review item by item)

| # | What goes | Why |
|---|---|---|
| R0 | Every agent, version, run, build and test copy on staging and production; templates re-seeded in the new model | Approved by the owner, 2026-11-25. Invariants 3 and 14 say versions and audit events are never deleted; this one reset is recorded in `docs/plan.md` and run as a dated step. |
| R1 | The 117 tool-only skills, the code that makes them (`connectorReadSkills`) and the code that hides them (`isToolWrapper`) | A tool is a step on its own. |
| R2 | Version 3 workflows, the v3-to-v4 converter (`process/convert.ts`), version 1 automations and `use_automation` | Only the new model is built. |
| R3 | The skill's `mode` field (tool, task, agent) | Replaced by Rules, AI, Loop. |
| R4 | "Rules then AI" as a skill method | Replaced by chained Do steps and Hybrid match. |
| R5 | Two places for one setting (settings and parameters; settings and `customize.settings`; `model` and `customize.model`) | One of each. |
| R6 | Twin skills (agent-mode copies; "with the document" readers) | One skill per job. |
| R7 | Overlapping Materials matchers (`match-unmatched`, `lookup-existing`, `vendor_items.similar`, `semantic-match-vendor`) | One Match step with profiles; vendor items exact only. |
| R8 | Check skills as their own steps (`docs.check-totals`, `docs.check-bill`, `materials.check-matches`) | They become the rules part of the step they check. |
| R9 | The packs' "superseded" map | Only exists for steps still using a replaced skill. |
| R10 | Templates seeded in the old model | Rebuilt in the new builder; they join the acceptance tests. |

The purge also lets the eight step kinds be stored directly, replacing today's fifteen (§4).

## 13. Build list (draft; reordered once §6, §9 and §12 are settled)

| # | What |
|---|---|
| 1 | The purge (R0) and the release items R1–R10. |
| 2 | The step model: the eight kinds, the Do form, checks, More. |
| 3 | Input picker; automatic translation on each step's incoming side (fits, translated, doesn't fit); "doesn't fit" blocks going live. The Data tab on every step: coming in, changed, going out. |
| 4 | Rules and AI written in the step; Save as skill; Suggest on every step and every field. |
| 5 | Workflow outputs and End cards; the publish checks. |
| 6 | Match step with profiles: match type, keys, confidence threshold, second opinion per line, shortlists; exact match on every profile. |
| 7 | Loop designer in the Agent lab, with the turn-by-turn test and the test-set gate. |
| 8 | Builder: write in the step, suggest Save as skill, draft Loops. |
| 9 | Dev queue: a tool that says whether a document has been through an agent. |
| — | Acceptance: the Invoice item matcher and the rebuilt templates, built by hand. |

## 14. Where we are in the review

Going tab by tab through the working spreadsheet: **Terms**, **Step kinds** and
**Forms** and **Skills** agreed. Next: Tools, Where it's built, Invoice
matcher, Build list, Release.

## Decision log

- 2026-11-25 · The step model is redesigned so a person can build and change any step by hand.
- 2026-11-25 · Purge and start from scratch; no code kept only for old agents.
- 2026-11-25 · Terms: Workflow, Trigger, Done by, Exact match / Semantic match / Hybrid, Confidence
  threshold from common use; Do, Loop, Fork, End, Automation, Approver, Confer, Shortlist kept.
- 2026-11-25 · Triggers unchanged.
- 2026-11-25 · Skill = a prepackaged step; Save as skill on any Do or Loop.
- 2026-11-25 · Loop = agent loop, read-only, built in the Agent lab, a step or the whole workflow.
- 2026-11-25 · Vendor items: SKU match or nothing. Exact match offered for every kind of record.
- 2026-11-25 · Matches: confidence threshold, a second-opinion band (AI, person, or AI then
  person), a model shortlist longer than 5 set by measurement.
- 2026-11-25 · One Match step with match profiles owned by areas.
- 2026-11-25 · JSON is the internal conduit; format only at the edges.
- 2026-11-25 · Reused skills name their fields for the job; no "works on" setting.
- 2026-11-25 · Workflows declare their outputs; every End delivers one or more of them; End cards
  are required and added by the builder; one End may deliver several outputs.
- 2026-11-25 · A declared output that no End selects blocks publishing: no silent deaths.
- 2026-11-25 · No named data shapes and no extra terms: each step defines the fields it needs.
- 2026-11-25 · Every step has a Data tab: coming in, changed, going out. For understanding, not a check.
- 2026-11-25 · Translations are applied without confirming or marking; only "doesn't fit" blocks.
- 2026-11-25 · Matching is always against our synced records (raw copies with a key index, or an
  area's own table); outside ids are fields on our records; without a sync it's a lookup by id.
- 2026-11-25 · Skills list agreed by area; the leftovers investigation becomes the first Loop; one
  Choose account replaces three.
- 2026-11-25 · Forms agreed. Suggest (AI icon) on every step and every field: tell it what you need,
  use the default, or resolve; applied at once, with Undo.
- 2026-11-25 · The eight kinds are stored directly; nine of today's kinds collapse into Do, run by
  Done by and Uses.
- 2026-11-25 · Translation between steps is automatic, on the receiving step's incoming side, worked
  out when building and run as code; steps whose data doesn't fit block going live.
