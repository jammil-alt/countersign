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

1. **Purge and start from scratch.** No agent is live. Every agent, version, run, build and template
   is deleted once; templates are then built again one by one, by hand, not as part of this work. Nothing is kept only because
   something uses it today (owner, 2026-11-25: "Now is the time to release what will become tech
   debt"). See §12.
2. **The builders stay.** Both the Builder (the AI that drafts agents with you) and the workflow
   builder (the canvas) stay. The aim is that a person can read and change anything the Builder
   drafts, without going back to it.
3. **Use the words everyone uses**, except where ours are already clear (§3).
4. **Deterministic first, model second, person last** (invariant 7), visible on every step.
5. **Triggers stay as they are today.** They work and are well thought out.
6. **Same product, new structure underneath** (owner, 2026-11-25: "Keep the build and manage as it
   is today, don't change flows or UI except where needed to adjust to forms and groupings. This is
   not a new tool"). Screens, navigation and flows stay; only the step forms, the groupings in the
   pickers and what the new structure needs (End cards, workflow outputs, the Data tab, Suggest) change.

## 3. Terms (Agreed)

| Term | Meaning |
|---|---|
| **Agent** | The worker for a client. It has one or more workflows. |
| **Workflow** | An agent's triggers, its steps, and its declared outputs. |
| **Trigger** | What starts a run, as today. A trigger that needs work before the main line (the daily QuickBooks check finds the bills first) has its own steps on a branch that joins the main line. |
| **Step** | One unit of work or flow with one goal. Eight kinds (§4). |
| **Done by** | Who does a Do step: Rules, a model (AI), or a Person. |
| **Connector** | A system outside Mezonas a step can use: a client's tool (QuickBooks, BILL, a CRM, Ramp, spreadsheets), a way to reach people (texts and calls, email, team chat), or outside information (browser, web). Its actions are **Get**, **Change** (in that system; approver on by default) and **Send**. Built by developers; a new action is a Dev queue request. |
| **Area** | Our own records in Mezonas, by business area (Purchasing, Bookkeeping, Sales, Marketing, with AP and month-end close inside them), plus **Shared** (documents, directory, knowledge, chart of accounts, inbox and threads, conversations, data jobs). Its actions are **Get** and **Save**; a Save never needs a client's approval. |
| **Action** | What a connector or an area can do, picked as "QuickBooks › Create bill" or "Purchasing › Register lines". Its kind sets the defaults and matches how the client grants permissions, per connector and per kind. "Tool" stays the word in the code, for one action as a model calls it. |
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
| **Uses** (optional) | A connector's action ("QuickBooks › Create bill"), an area's action ("Purchasing › Register lines"), a skill, or an automation. |
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

**SKU is the vendor item's unique id** (owner, 2026-11-25). The vendor's past wording is not a key
for vendor items.

**New kinds of record to match** (a match profile for, say, projects) are added by developers, because
a profile names where those records are kept and which of their fields are keys; the operator sets
the rest on each Match step.

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

## 10c. Connectors: how capabilities come in (Agreed)

- **The connector's page** in the back office (today's Connectors screen, `/ops/connectors`) is where
  a connector's capabilities live: what it syncs into our records; its actions by record type, each
  with its kind and on or off for agents; and the default access a new client's connection starts
  with (delete always off).
- **A new action** is built by a developer, appears on the connector's page off, and is turned on
  there; it is then available to every agent that can use the connector, within each client's own
  permissions.
- **Clients** see connectors only where they sign in and grant permissions, as today.
- **"Request an action"** can be made from a connector, an agent or the account (owner,
  2026-11-25). Whoever asks only describes what they need; a client never has to know it is a
  connector action. It becomes a Dev queue request, with the reuse check, and we resolve it.
- **Three merges, so a template works for any client** (owner, 2026-11-25): **Email** (Gmail,
  Outlook and our own email), **Team chat** (Slack, Teams, Google Chat) and **Spreadsheets** (Google
  Sheets, Excel). One action each ("Email › Send"), sent through whichever of them the client has
  connected; the code already lets one action stand for several connectors. Every other connector
  stays as it is.
- **Areas and templates are tool-neutral** (owner, 2026-11-25: "these should be generic and then tie
  to qbo or xero or whatever tool"). Our records hold an outside id per connector (a vendor's
  `external_refs`, ARCHITECTURE §5.2), so a profile's key is "accounting id", not "QuickBooks id", and
  an area's actions say "tie a vendor to the accounting system", not "to QuickBooks". Writes common
  to accounting tools are **Accounting** actions ("Accounting › Create bill") that run on whichever
  accounting connection the client has, as the four built today do (send email, send text, create
  bill, create vendor, resolving to QuickBooks or BILL; `process/actions.ts`). What only one tool
  has stays under that connector ("QuickBooks › Itemize a bill's lines"). Templates use Accounting
  actions wherever one exists. Only the Accounting actions the rebuilt agents need are added now; the
  rest come with Xero or the next accounting tool (owner, 2026-11-25).
- **QuickBooks stays as it is**: 34 actions, one per QuickBooks operation, nothing merged and
  nothing added until the rebuilt agents work (owner, 2026-11-25: "lets get this working and we can
  enhance later").

## 10d. Areas: Purchasing (Agreed)

Of Purchasing's 54 actions, 41 stay as they are (with "QuickBooks" in their words made "the
accounting system"), and 13 change (owner, 2026-11-25):

| Action today | Becomes |
|---|---|
| Match the vendor | Match profile **Vendors** (accounting id, tax id, email domain, name) |
| Look up by SKU in the vendor's catalog | Match profile **Vendor items**: exact match on SKU only |
| Find master item candidates | Match profile **Master items**: hybrid (the vendors' names and key attributes first, then semantic) |
| Match descriptions to the catalog | Match profile **Master items** (also for purchase requests) |
| Match a request's lines again | A Match step with the **Master items** profile |
| Check the model's answers | Folded into the Match step as its hard rules |
| Make search embeddings | Folded into Register lines and the other saves that add items |
| Record prices | Dropped: Register lines already records each line's price in the price history |
| Find the vendor's closest items | Dropped (vendor items are SKU or nothing) |
| Look up lines in the catalog (older) | Dropped |
| Match one line (older) | Dropped |
| Match every line (older) | Dropped |
| Record checked line decisions (older) | Dropped; **Register lines** is the one save for a document's decided lines (vendor item, master item, price, the vendor's wording) |

"Becomes a profile" means the code is reused as the profile's engine; it stops being an action in
the picker. Found in checking the list:

- **A person's answer is learned.** Whatever a person decides on a Match (this line is that item) is
  saved where the profile keeps its learned names, so the same wording is an exact hit next time.
  Register lines does this for documents today, and a request's re-match did it for requests; it
  becomes part of every match profile.
- **Vendor items no longer need embeddings** (nothing searches them by meaning); master items still
  do.
- **Backfill from bills** stays, rebuilt on the profiles, reading the accounting system's bills.
- **The two price actions stay as built:** Compare to historicals (Get: the alerts the six price rules
  would raise, with evidence and dollar impact; saves nothing) and Check prices (Save: raises them,
  one open alert per kind, item and vendor).
- **Price tolerances, as built, kept** (owner, 2026-11-25). Three exist: each vendor item's tolerance
  on its agreed price (an amount or a percent, set in the vendor catalog or from an imported price
  list), used by the contract check; the price rules' thresholds (a jump or a rise over the 90-day
  average above 5%, a vendor spread above 10%, creep above 8%), which are values in the Instructions
  of a Compare or Check prices step; and AP's tolerance of a bill's price over its purchase order
  (2%), a setting of the AP area.
- **Later, for a vendor agent:** our records have no "add a vendor" action of their own (a vendor is
  added by the sync or when an invoice makes its purchase).

## 10e. The other areas and Shared (Agreed)

Only what changes; everything not named stays as built. Throughout, "QuickBooks" in an area's
words becomes "the accounting system".

- **One chart of accounts.** Three actions list the client's accounts today (Bookkeeping, AP, and
  Shared's ledger). They become one: **Shared › Chart of accounts › Get accounts**, with filters for
  the account types an area wants and the notes on what each is for.
- **Bookkeeping (16):** unchanged apart from the wording. Its proposals (a booking, a reconciliation
  match) stay Saves that record what the AI skill decided, for the review card.
- **Month-end close (4):** unchanged apart from the wording.
- **AP (7):** its accounts list joins the one chart. Its "Suggest accounts" save records what Choose
  account decided. To check when the Bill clerk and AP templates are rebuilt: AP's "Prepare the bill"
  (our bill record, with its purchase order and the pay list) and Documents' bill-making actions
  overlap.
- **Sales (4):** "Match to CRM records" becomes the match profile **CRM records** (email, phone,
  website, then names and meaning). "Refresh the record keys" becomes part of the sync, which keeps
  every profile's key index up to date. "Look up records" and "Confirmed matches" stay.
- **Marketing (14):** unchanged.
- **Shared, Documents:** "Read and record a document", "Read a document once" and "Record a reading"
  become one **Read a document** (reads once, records the reading); its totals check and the bill
  check fold into the skills that use them.
- **Shared, the rest:** directory, knowledge, inbox and threads, memory, and data jobs stay as
  actions. Reach out, talk until a goal is met, request a form and ask a person become the engines
  behind a Do done by a Person or an Outside contact, not actions in the picker. Web search and
  reading a web page become the **Web** connector. The supervisor's, Sloan's and the agents' own
  actions (health, account, ask another agent, read an SOP) stay hidden: the platform's own.
- **Three "lay out for the accounting system" actions stay** (a booking, a journal entry, a purchase
  order): each decides what kind of entry to write, which is more than the automatic translation
  does.

## 10f. Data: record types, custom fields, data sets (Agreed)

Work crosses areas, and reads and writes where it needs to (margin and sales ROI: Sales and
Bookkeeping figures, a result saved somewhere of its own). The database is still not a tool: agents
never map to tables, and no model or person writes queries. Four parts give the flexibility instead,
each typed so steps wire and check themselves.

**1. Record type (the unit).** A kind of record: vendor, transaction, deal, invoice line, catalog
item, or a new "margin by job". Each is defined once, in code, by the area that owns it:
- its fields and keys, and its links to other record types (a transaction to its vendor, a deal to
  its customer);
- the operations it allows: get, create, update. Delete stays off;
- its own rules, run on every write wherever it comes from: the checks, keeping clients apart,
  recording which agent version wrote it, never saving twice.

A new record type, meaning a new table, is added by a developer (Request an action), one migration
each, under the usual migration rules.

**2. Standard actions on every record type.** Offered under the area, beside its own actions:
- **Find:** typed filters, grouping and totals, following declared links across record types and
  areas. Read only, one client's records. It works like today's "filter, group and total": plain
  words become a typed filter, never SQL.
- **Get by id.**
- **Create** and **Update:** typed, and through the record type's own rules.

Bespoke actions stay where the work is more than one save (Register lines writes several record
types together).

**3. Grants, the same model as connectors.** An agent's grant lists, per record type, what it may
read, create and update. Writing into another area is explicit, shown on the agent and reviewable;
an agent never widens it (invariant 9). Writes to our own records need no client approval and are
always logged with their evidence (invariant 10).

**4. Data set.** A named group of record types for one use case, granted together, across areas.
Example: **Margin and ROI** = Sales deals (read), Bookkeeping transactions (read), margin by job
(create, update). Data sets are back-office settings, no code: created, changed, and turned on or
off for an agent, saved with the agent's version and published like any change. They are what the
builder's pickers offer. A data set can't invent a field or a table.

**Custom fields: mapping, not schema changes** (owner, 2026-11-25: "as unique usecases come in, we
are mapping and adding custom fields as opposed to redefining the schema").
- **Defined in the back office:** record type, name, type (text, number, money, date, yes/no, list,
  group, link to a record), required or not, one line on what it means.
- **Two scopes:** this client only, or shared (offered to every client, as templates are).
- **Stored on the record** in its existing `ext` column, under the field's name; money as a decimal
  string. Tables with `ext` today: vendor and transaction (0004), receivable (0024), materials (0032),
  purchasing (0033), bookkeeping (0039), vendor catalog (0047), vendor contracts (0051). A record type
  without one gets it by migration when it first needs a custom field.
- **Checked on every write** by the record type's rules: a wrong type or a missing required value is
  refused wherever the write came from.
- **Used like built-in fields:** the Input picker and automatic translation (a client's extra
  spreadsheet column maps straight into one), the Data tab, Find, grants and data sets, reports;
  Match keys later.
- **Guardrails:** a field's type never changes once it holds data (add a new field instead);
  removing a field hides it and keeps its data; about 50 per record type per client; each client's
  fields are its own; card numbers never stored (invariant 14); counted as client data under HIPAA
  mode. A field searched heavily gets an index from a developer.
- **Promotion:** a custom field common across clients becomes a real column, same name, data copied
  across; steps using it keep working.

**Later, only when a use case needs it:** custom record types (a new kind of record defined in the
back office, kept in one shared table, with the same checks, grants and data sets).

## 11. The Invoice item matcher

Not part of this work (owner, 2026-11-25): it is built once these changes are made, as the first
agent in the new model.

## 12. Release: what the purge removes (to review)

| # | What goes | Why |
|---|---|---|
| R0 | Every agent, version, run, build, test copy and template, on staging and production; with them every row that can't exist without one (steps, model calls, builds' items, grants, daily usage and per-agent billing rows, marketing reports, forum replies, reach-outs, form requests, agent memory notes, invoice lines billed per agent). Kept, with only the link to the agent cleared: clients and people, connections and synced data, documents and readings, vendors, the catalog and prices, bookings, reconciliations, AP bills, purchase requests and quotes, the ledger, inbox items, external actions, alerts, and the audit log (owner confirmed the scope, 2026-11-25) | Approved by the owner, 2026-11-25. Invariants 3 and 14 say versions and audit events are never deleted; this one reset is recorded in `docs/plan.md` and run as a dated step. Templates are built again one by one, later. |
| R1 | The 117 tool-only skills, the code that makes them (`connectorReadSkills`) and the code that hides them (`isToolWrapper`) | An action is used directly. |
| R2 | Version 3 workflows, the v3-to-v4 converter (`process/convert.ts`), version 1 automations and `use_automation` | Only the new model is built. |
| R3 | Today's fifteen stored step kinds | Replaced by the eight, stored directly (§4). |
| R4 | The skill's `mode` field (tool, task, agent) and "rules then AI" | Replaced by Rules, AI and Loop. |
| R5 | Two places for one setting (settings and parameters; settings and `customize.settings`; `model` and `customize.model`) | One of each. |
| R6 | Dropped and merged skills (§10a): agent-mode twins, "with the document" readers, Purchasing's dropped matchers, check skills as their own skills | One skill per job; checks are the rules of the step they check. |
| R7 | Purchasing's 13 matching and price actions (§10d); Sales' matcher and key refresh; the three document readers; the three chart-of-accounts lists (§10e) | Match profiles, Register lines, one Read a document, one chart. |
| R8 | Working out how a workflow ends from its steps (2026-11-23) | Declared workflow outputs and End cards (§9). |
| R9 | The packs' "superseded" map | Only exists for steps still using a replaced skill. |
| R10 | Search embeddings for vendor items | Nothing searches them by meaning (master items keep theirs). |

## 13. Build list (to review)

In order; each ends green, as the milestones always have.

| # | What | Size |
|---|---|---|
| 1 | **Purge and release** (R0–R10). | M |
| 2 | **Stored format.** The eight kinds; Do with Done by and Uses; workflow outputs and End; the validator; the executor choosing the engine for a Do; outcomes, timeline and SOP lines, merges and diffs keyed by Done by and Uses. | L |
| 3 | **Builder, adjusted to the forms and groupings** (same screens and flows). The palette's eight kinds; the Uses picker (connector › action, area › action, skill, automation); the Do form, Checks and More; End cards added by the builder; workflow outputs next to the triggers; Suggest on every form and field; the Data tab. | L |
| 4 | **Automatic translation** on each step's incoming side; "doesn't fit" blocks going live. | M |
| 5 | **Rules and AI written in the step; Save as skill.** | M |
| 6 | **Match step and profiles** (Vendors, Vendor items, Master items, CRM records): match type, keys, confidence threshold, second opinion per line, shortlists, learned answers; exact match on every profile. | L |
| 7 | **Connectors and areas.** Actions on or off on the connector's page; Request an action from a connector, an agent or the account; Email, Team chat and Spreadsheets merged; tool-neutral wording; Register lines; one chart of accounts; one Read a document. | M |
| 8 | **Loop designer** in the Agent lab: read-only agent-mode skills again, the turn-by-turn test, the test-set gate; the leftovers investigation as the first Loop. | L |
| 9 | **The Builder (AI)** drafts in the new model: writes in the step, suggests Save as skill, drafts Loops. | M |
| 10 | **Measure** the shortlist size and the thresholds on the matching goldens; set the defaults. | S |
| 11 | **Rules documents.** A new ARCHITECTURE version for this model; CLAUDE.md: the one-off purge under invariants 3 and 14, the Loop under invariant 9. | S |
| 12 | **Data** (§10f): record types declared by areas; Find, Get by id, Create, Update on each; grants per record type; data sets in the back office; custom fields in `ext`, checked on every write. | L |

S = a day or less, M = a few days, L = a week or more.

## 13a. Stored format (draft for review)

What an agent version stores in the new model, as plain fields. Fields not named here stay as they
are today. Everything is checked by one schema and one validator in `packages/core`, shared by the
builder and the executor (invariant 4).

**Agent version**
- **Definition**, as today: name, role, mission, area, model, instructions, mode and default
  approver, budgets, memory, the owner's settings, what the client sees, manual, setup checklist,
  settings the client may adjust, and the skills it uses with its own values for each (the skill's
  `settings` folded into `parameters`, R5).
- **Workflows**, each: slug, name, on or off, **triggers** (as today), **outputs**, **steps**.

**Workflow output:** id · name · kind (report, write to a connector, save to our records, hand
off, nothing to do) · where it goes (people and channel; a connector action; an area action; an
agent and workflow) · its fields · one line on what it is.

**Every step:** id (permanent) · kind · goal (its name) · purpose (one sentence, optional) · client
sees it (yes or no, label) · review (owner decides, always, off) · if it fails (stop, go on) ·
**checks**: approver (who, when, in turn or any or all, deadline, if no answer), confer (AI or a
person, focus, when), tell after (who, channel, message, when).

**A field** (in an output, or a step's own input and output): name · type (text, number, money,
date, yes/no, a list of fields, a link to a record of a kind) · required or not · one line on what
it means.

| Kind | Stores |
|---|---|
| **Do** | **done by** (rules, AI, person, outside contact) · **uses**: a connector action, an area action, a skill, an automation, "collect reports", or nothing yet (not built yet: what's needed) · **input**: each field's source (the trigger, an earlier step's field, a fixed value) and the incoming translation the builder worked out · **instructions** by done by: rules (rule rows and values), AI (text; model under More), person (who, approve or ask, the question, answers offered, deadline, channel), outside contact (who, channel, goal, may share, most turns, message approvals) · **output** fields (written in the step, or the action's or skill's) · **match** (when uses is a Match): match to (profile), match type, keys, confidence threshold, second opinion (from, by), below the floor, search floor, shortlists (model, person), no match means |
| **Loop** | goal · input · output fields · the connectors and areas it may read · instructions · model · most turns · at the limit (stop, hand back what it has) |
| **Fork** | what it looks at · paths (each: id, name, rules, when to take it in words) · decided by (rules, AI) · if the AI is unsure (otherwise, ask a person) · otherwise |
| **For each** | the list · the steps inside · how many at once |
| **Repeat** | the steps inside · until (rules, or a goal the AI judges) · most times · wait between · at the limit |
| **Wait** | how long |
| **Hand off** | to (agent or this agent's workflow, and step) · input |
| **End** | the outputs it delivers (ids from the workflow's list), or nothing to do with its reason |

**Checked at publish** (each a plain message on the step): every path that doesn't rejoin ends on an
End; every End delivers at least one declared output; every declared output is delivered by an End;
every required input field has a source ("doesn't fit" otherwise); no "not built yet" step; a Do's
done by and uses are a combination the table in §4 allows; a Loop uses Get actions only; approvers
are on by default for every Change to a client's tool, and never looser than the client allows.

## 13b. What runs in parallel, and on which model (draft for review)

**Rule for splitting:** streams run in parallel only once the contracts they share are fixed, and
never two streams in the same files (the stored format, the API contract, the executor). At most four
streams at once; each its own branch and PR; workers don't edit this page (the coordinator does, per
wave, as CLAUDE.md asks).

**When a stream is done:** once its PR is merged, its session is archived (owner, 2026-11-25).

**Rule for the model:** Opus where a mistake is silent or breaks an invariant: the runtime and its
approvals (8, 9), matching precision (7), translation of money and data, the platform's own agents,
the Builder's prompts, and the rules documents. Sonnet where the spec is exact and the work follows a
pattern already in the code: screens, renames, connector merges on the existing multi-provider
pattern, deletions the compiler checks, measurement runs. Every Sonnet PR that touches the gate, the
executor or a pack's records gets an Opus review before merge.

| Wave | Stream | What | Needs | Model |
|---|---|---|---|---|
| 0 (sequential) | Contracts | Freeze the stored format (owner's review); the match profile shape; the action catalog the pickers read (connector or area, kind, fields); the engine boundary a Do step runs through; a one-off converter that rewrites today's test fixtures and seeds into the new format, deleted when wave 4 is done | — | Opus |
| 1 | A · Executor | Runs the new format: a Do picks its engine; Loop; Fork, For each, Repeat, Wait, Hand off; End delivers outputs with their checks; outcomes keyed by done by and uses | Wave 0 | Opus |
| 1 | B · Builder screens | Same screens, new forms and groupings: the eight kinds, the Uses picker, the Do form, Checks, More, End cards, workflow outputs, the Data tab, Suggest buttons | Wave 0 | Sonnet |
| 1 | D · Match | Profiles (Vendors, Vendor items, Master items, CRM records) on the shared engine; exact on every profile; thresholds and second opinion per line; learned answers | Wave 0 | Opus |
| 1 | E · Connectors and areas | Actions on or off; Request an action; Email, Team chat and Spreadsheets merged; tool-neutral wording; one chart of accounts; one Read a document; Register lines; the dropped actions | Wave 0 | Sonnet (Opus review: the merges touch the gate) |
| 2 | C · Platform agents | The Builder, Supervisor, Coordinator and clerks rewritten in the new format for the seed | A | Opus |
| 2 | G · Translation | Fits, translated, doesn't fit, worked out on each step's incoming side (core), shown in the Data tab | A, B | Opus (core), Sonnet (screens) |
| 2 | F · Written in the step | Rules and AI written in the step, saved behind it; Save as skill; Suggest's backend | B | Sonnet |
| 2 | H · Loop designer | The designer and its turn-by-turn test, on A's Loop runtime; the test-set gate | A, B | Sonnet (Opus review of the read-only rule) |
| 3 | I · Builder (AI) | Drafts in the new model: writes in the step, suggests Save as skill, drafts Loops; its guards and evals | A, C | Opus |
| 3 | K · Measure | Shortlist size and thresholds on the matching goldens; set the defaults | D | Sonnet |
| 3 | N · Data | §10f: record types and their standard actions, grants per record type (the gate), data sets, custom fields; a migration of its own for the definitions | A, B, E | Opus (core, gate), Sonnet (screens) |
| 4 (sequential) | J · Release | Delete v3, v4, the converters, the tool-only skills and the rest of §12, the compiler finding every use | A, B, C, I | Sonnet (Opus review) |
| 4 | L · Rules documents | A new ARCHITECTURE version; CLAUDE.md (the one-off purge, the Loop) | J | Opus |
| 4 | M · Ship | Deploy, `db:purge-agents` (dry run, then real) and `db:seed`, staging then production with the owner's approval | J, L | By hand |

Roughly: wave 0 two to three days, waves 1 and 2 about a week each, wave 3 three to four days, wave 4
three to four days: three and a half to four weeks, against about six one after another.

## 13c. Wave 0: the contracts (built)

What the parallel streams build on, in `packages/core/src/steps` (exported as the `steps` namespace
while v4 is still read). Changing one of these after wave 1 starts is a coordinator's decision, not a
stream's.

| Contract | File | What it fixes |
|---|---|---|
| Stored format | `schema.ts` | Workflow `schemaVersion: 5`: the eight kinds, Do's done by and uses, instructions by done by, Match settings, typed fields (text, number, money, date, yes/no, list, group, record), workflow outputs, End. Added in wave 0: **Tell** (a Do done by rules that tells the client's team or ours, today's notify) and the **group** field type. |
| Publish checks | `validate.ts` | Every path ends; every output delivered; Do combinations; Loops read only; inputs have a source; Match settings against their profile. |
| Match profiles | `match-profile.ts` | A profile's records, keys, semantic text, allowed match types, never-the-same rules, learning; the one Match result every profile gives. Areas declare their profiles (stream D). |
| Action catalog | `catalog.ts` | Every offered action under its connector or area, with its kind and fields; the merged Email, Team chat, Spreadsheets and Accounting, and which tool each runs on for a client. |
| Engine boundary | `engine.ts` | Which engine a Do step runs on, from done by and uses; an unknown action is a Change. |
| Converter (one-off) | `convert-v4.ts` | v3 and v4 workflows into the step model. Every seeded agent's workflows convert and pass the publish checks (`apps/api/src/steps-convert.test.ts`). Test fixtures written in TypeScript are moved by each stream as it moves the code they test. Deleted in wave 4. |

The stored format is **approved and frozen** (owner, 2026-11-25), Tell and the group type included.

**Wave 1 streams** (each its own session, branch and draft PR; based on this branch until it merges):

| Stream | Branch | Model | Owns |
|---|---|---|---|
| A · Executor | `claude/step-model-a-executor` | Opus | `packages/workflows`, the executor's adapters in `apps/api`, `packages/agents/src/runtime`, and the agent bundle accepting v5 workflows (`packages/core/src/schemas/agent.ts`, `packages/core/src/process/bundle.ts`) |
| B · Builder screens | `claude/step-model-b-builder` | Sonnet | `apps/web/src/ops/flow`, `apps/web/src/ops/builder`, the builder's API routes that serve the catalog |
| D · Match | `claude/step-model-d-match` | Opus | Match profiles and their engine: `packs/materials/src/vendor`, the catalog matching in `packs/materials`, `packs/sales/src/match`, `packages/core/src/matching` |
| E · Connectors and areas | `claude/step-model-e-connectors` | Sonnet | `packages/connectors`, the connector page (`apps/web/src/ops/screens/Connectors.tsx`), Request an action, tool-neutral wording outside what D owns, one chart of accounts, one Read a document |

**Wave 2 streams** (started 2026-11-25 while wave 1 merges; H waits for A's Loop runtime):

| Stream | Branch | Model | Starts from | Owns |
|---|---|---|---|---|
| C · Platform agents | `claude/step-model-c-platform-agents` | Opus | #671 (merges A's branch as it lands) | The platform's own agents in the seed, in the new format; the seed script |
| G · Automatic translation | `claude/step-model-g-translation` | Opus | B's branch (#672) | A new core module for Fits, Translated, Doesn't fit; the executor's translation hook; the Input box and the Data tab's "Changed" |
| F · Written in the step | `claude/step-model-f-in-step` | Sonnet | B's branch (#672) | Rules and AI written in the step, stored behind it as a skill; Save as skill; Suggest's backend; the Instructions box |
| H · Loop designer | `claude/step-model-h-loop-designer` | Sonnet | A's branch (#676) | The Loop designer in the Agent lab |

## 13d. Where the build stands (2026-11-25, evening)

**Merged to `main`** (and so on staging), with what each review found and fixed:

| PR | Stream | What it brought | Found in review or CI, fixed before merge |
|---|---|---|---|
| #671 | Wave 0 | This plan, `db:purge-agents`, the stored format and its publish checks | A flaky portal test (waited for the charter) |
| #672 | B · Builder screens | The eight kinds, the Do form, the Uses picker, outputs, End cards, the Data tab, Suggest buttons, in today's builder | — |
| #676 | A · Executor | v5 runs end to end: Do by engine, Loop, Fork and the containers, End delivering outputs; publishable versions only | — |
| #673 | D · Match | The Match engine; Vendors, Vendor items (SKU only), Master items, CRM records; second opinion; learned names | A slow regex on long quote runs (CodeQL); model calls missing from the HIPAA inventory |
| #678 | G · Translation | Fits, Translated, Doesn't fit, worked out when building and run as code | — |
| #674, #675 | E · Connectors and areas | Action switches (migration 0101), merged Email, Team chat, Spreadsheets, Accounting; Request an action; tool-neutral wording; one chart of accounts; one Read a document | `docs.read` could record a reading a model made up (invariant 9); Request an action lost the client, so HIPAA mode didn't hold (invariant 14); off actions still in the pickers |
| #681 | H · Loop designer | Loop skills (read-only at save and at run time), the designer, turn-by-turn tests, the test-set gate; the leftovers investigation as the first Loop | A pinned draft Loop version could run untested; an inline Loop had no gate; built-in Loops shipped without tests |
| #679 | C · Platform agents | The Builder, Sloan, the Coordinator, the Document clerk and the Bill clerk seeded as v5 | A client's people carried into a template on promotion (invariant 11); the Library answered 500 on a v5 template |
| #677 | F · Written in the step | Rules and AI written in the step, kept as the agent's own skill; Save as skill; Suggest | Suggest could loosen approvals the Builder guards (contact messages, an approver's deadline, all to any); step skills were shared between agents and changed the live agent on a draft save; a shared skill could carry a client's ids, people and values |

**Open:**

| Stream | PR | State |
|---|---|---|
| A · Wiring | #682 | The real Match port (HIPAA-guarded model, learned answers), Sloan's chat with its own tools, translation at run time, merged connectors from the agent's bindings and switches, the builder frame. Last: steps written in the step run through their pinned skill. Then a v5 agent runs end to end. |
| N · Data | — | §10f, on Opus; its gate changes get an Opus review |
| I · Builder (AI) | — | Item 9, on Opus |
| L · Rules documents | — | ARCHITECTURE v0.20 and the CLAUDE.md edits, for the owner's sign-off |
| C · follow-up | — | The Bill clerk's and Sloan's run tests move to the v5 seeds, after #682 |
| K · Measure | — | Needs an Anthropic API key in the cloud environment; until then a shortlist of 20 and a threshold of 90 |
| J, M · Release and ship | — | After I merges: delete v3, v4, the converters and the tool-only skills; then purge and seed on staging, and production with the owner's approval |

**For the owner:** the Bill clerk's vendor lookup stays a QuickBooks name search for now; it
becomes a Match on Vendors once N's Get by id gives a vendor's accounting id (recommended), unless
the owner picks one of the other two ways (the Match result carries the accounting ids; a shared
"vendor's accounting id" action).

## 14. Where we are in the review

Agreed and built: everything through §10f. Being built: N, I, L and A's wiring (§13d). Then
release (§12) and ship.

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
- 2026-11-25 · Connector and Action replace Tool in what people see. A connector is outside Mezonas
  (actions: Get, Change, Send); an area is our own records (actions: Get, Save).
- 2026-11-25 · Capabilities come in on the connector's page; Request an action from a connector, an
  agent or the account; QuickBooks unchanged for now.
- 2026-11-25 · Email, Team chat and Spreadsheets merged into one connector each; other connectors
  unchanged.
- 2026-11-25 · Areas and templates are tool-neutral: outside ids per connector; Accounting actions
  run on whichever accounting tool the client has.
- 2026-11-25 · Purchasing: 13 matching and price actions replaced by three match profiles and Register
  lines; a person's answer on any match is learned.
- 2026-11-25 · Both price actions and the three price tolerances kept as built; Accounting actions
  added only as the rebuilt agents need them.
- 2026-11-25 · The other areas and Shared agreed. SKU is the vendor item's unique id (past wording
  is not a key). Developers add match profiles.
- 2026-11-25 · Same product, new structure underneath: screens and flows stay; only forms, groupings
  and what the structure needs change. No templates rebuilt as part of this; the invoice matcher is
  built after.
- 2026-11-25 · Purge scope confirmed (§12, R0); `db:purge-agents` built; wave 0 started.
- 2026-11-25 · Wave 0 contracts built (§13c); Tell added to the Do step, and the group field type.
- 2026-11-25 · Stored format approved and frozen; wave 1 started (four sessions, §13c).
- 2026-11-25 · Screen changes approved (mock-up `docs/design/step-model.html`), with stream B's two choices: the rail stays as today and the eight kinds open from the chart's +; workflow outputs sit in a section above the chart.
- 2026-11-25 · Wave 2 started: C, G and F; H waits for stream A's Loop runtime.
- 2026-11-25 · Drafts parse as they are being built (a step with no goal yet, an End not filled in, an empty For each); the publish checks refuse them. A Do step may be run by another agent of the client (More). Stream B's PR #672 keeps 10 of its 12 differences from the mock-up (today's controls, editable Match settings, an input picker per field) and closes 2 (the sheet's eyebrow, the test run's time).
- 2026-11-25 · Data (§10f): the database is not a tool. Areas declare record types with Find, Get by
  id, Create and Update; agents are granted per record type; data sets group them across areas as
  back-office settings; custom fields are mapped in the back office and stored in `ext`, not added
  to the schema. Built in wave 3 (stream N).
- 2026-11-25 · Waves 1 and 2 merged (§13d). Each Sonnet stream that touched approvals or the gate
  had an Opus review; every finding was fixed before merge.
- 2026-11-25 · A Loop is published only as a saved Loop skill whose test set passes: a Loop written
  in a step may be drafted, but publishing the agent asks to save and test it first; a pinned
  draft version never runs; built-in and pack Loops ship with their test sets, run in CI.
- 2026-11-25 · Suggest never loosens an approval: it uses the Builder's own loosening checks. A
  Do moved to a Change or Send gets approval by default; a Save to our own records gets none.
- 2026-11-25 · Rules and AI written in a step are kept per agent and step
  (`custom:step-<agent id>-<step id>`), saved as drafts, and pinned in the agent version when it is
  published, so a decision's `agent_version_id` holds the text that ran. A skill shared with every
  client may not hold one client's ids, people or values.
- 2026-11-25 · Opening a step whose input doesn't fit asks the AI for what's left once, without
  confirming; it writes nothing until Save, so the screen walkthroughs allow it.
- 2026-11-25 · The Bill clerk's vendor lookup stays a QuickBooks Get until §10f's Get by id
  (recommended to the owner; not yet decided).
- 2026-11-25 · Forms agreed. Suggest (AI icon) on every step and every field: tell it what you need,
  use the default, or resolve; applied at once, with Undo.
- 2026-11-25 · The eight kinds are stored directly; nine of today's kinds collapse into Do, run by
  Done by and Uses.
- 2026-11-25 · Translation between steps is automatic, on the receiving step's incoming side, worked
  out when building and run as code; steps whose data doesn't fit block going live.
