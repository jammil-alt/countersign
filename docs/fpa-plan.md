# FP&A team: build plan (draft, 2026-11-16)

Plan for the brief "Mezonas FP&A Agents — Dev Brief" (2026-11-15). Nothing here is built. It is
outside ARCHITECTURE v0.18's §1 scope, so **step 0 is the owner's yes and an ARCHITECTURE v0.19
section** (as the Marketing and Bookkeeping areas were added), then a `docs/plan.md` §1 entry and
milestones. Everything below was checked against the code on 2026-11-16.

The hard part is not any one agent. It is running nine agents per client as **one team**: in order,
waiting on each other, fanning in, re-running when an input changes, and reaching the finance lead
only in batches. Section 1 is that design; the rest follows the brief's ask.

---

## 1. Running the agents as a team

### 1.1 What the platform already gives us

| Mechanism | What it does | Limit for a team |
|---|---|---|
| Handoff trigger (`run.succeeded`, ARCHITECTURE §10.8) | Starts agent B when agent A's live run succeeds, with A's `handoff.output` and `sources` | One to one. At most 3 deep (`MAX_HANDOFF_DEPTH`). No fan-in: B can't wait for A *and* C |
| Hand-off step (`docs/plan.md` §1.96) | Starts agent B at one of its steps, with mapped input | Fire and forget: the sender never gets B's result. Same depth limit |
| `agents.ask` (§1.28) | Runs another agent read-only on a question, answer as data | Read only, no writes, small budget; for questions, not work |
| Event trigger (§10.8) | Any platform, connector or pack event starts matching agents; run id = uuid v5 of event, agent, workflow, so one event starts a workflow once | No depth counter; loops must be prevented by design |
| Schedule trigger | Cron in the client's time zone, `skipHolidays` | No "business day 5" |
| Person, conversation, notify steps with deadlines (`ifNoAnswer`, business hours, escalate) | Durable waits on people for days | — |
| Sloan (supervisor), Weekly Table, Desk | Watching the account, the Monday digest, the client's one inbox | Sloan is `suggest_only`, sees only what the portal shows, no connector tools (invariant 11) |

So agents triggering agents works today for short chains. It does **not** give us a team: the monthly
cycle is Ledger → Variance → Collector → Variance again → Forecast → Performance → lead, which is
deeper than 3, needs fan-in (the pack waits for four analyzers), waits days on budget owners, and
must re-run downstream work when the trial balance is corrected.

### 1.2 Decision: the board routes, the lead conducts

The brief's own rule, "agents share tables, not messages", is the answer. A team is three things:

1. **A roster.** Each role (Ledger, Cash inputs, Metrics, Collector, Variance, Forecast, Cash,
   Performance, Lead) is an ordinary client agent forked from a template in a new **FP&A pack**, so
   versions, merges, stages, the test bench, run views and approvals all work per agent as today.
   A small table binds the client's agents to roles (`fpa_role`), so work is addressed to a role,
   never to an agent's slug or name.
2. **A board.** One `fpa_cycle` row per client, cadence and period ("monthly 2026-10"), and one
   `fpa_handoff` row per output per cycle per version: producer role, output kind, the record it
   points at (trial balance, variance run, forecast version), status `draft | ready | issue |
   superseded`, the handoff ids it was built from (`inputs`), notes and `sources`. This is the
   brief's `handoff` table, given a cycle to belong to.
3. **A dependency graph and a dispatcher.** The pack declares, per cadence, what each role
   **needs** and **produces** (data, versioned with the pack, validated as a DAG in core). Marking a
   handoff `ready` is an internal write tool (`fpa.handoff.mark`). In the same transaction a
   deterministic dispatcher works out which roles are now due for that cycle (every input `ready`)
   and emits one pack event, `fpa.role.due {cycleId, role, entry, inputs}`, at most once per
   (cycle, role, entry, set of input versions) by a unique key. Each agent's workflow has an event
   trigger on `fpa.role.due` filtered to its role.

```
          schedule / accounting.period.closed
                         │
                    Lead (conductor) ── opens fpa_cycle ──► fpa.cycle.opened
                         │                                       │
   ┌─────────────────────┴──── the board (fpa_handoff) ◄─────────┴───────────────┐
   │ trial_balance  ready ─┐                                                     │
   │ plan           ready ─┴─► dispatcher ─► fpa.role.due{variance, compare} ─► Variance
   │ variance_questions ready ─► dispatcher ─► fpa.role.due{collector} ─────────► Collector
   │ owner_answers  ready ───► dispatcher ─► fpa.role.due{variance, report} ────► Variance
   │ variance_report ready ──► dispatcher ─► Forecast, Performance (in parallel)
   │ forecast, kpi_commentary, cash_outlook ready ─► dispatcher ─► Lead {assemble}
   │ any `issue` ────────────► Lead's batch (never straight to a person)          │
   └─────────────────────────────────────────────────────────────────────────────┘
```

**The Lead conducts; it does not route.** It opens and closes cycles from the client's calendar,
watches each expected output's deadline on the board (late or `issue` → its batch), batches what
reaches the finance lead into one Desk item, one pack or one approval, and assembles the brief and
the pack when its own inputs are due. Who runs next is decided by the graph, in code.

Why not let the Lead route work with hand-off steps (an orchestrator agent)?

- Hand-off steps are fire and forget, so the Lead would need a new "wait for another agent" step
  to collect results. The brief asks for no new building blocks.
- The depth limit (3) and the days-long waits on budget owners break a single orchestrating run.
- A model deciding sequencing breaks invariant 7 (deterministic first). Sequencing is a fact about
  the data: the inputs are ready or they are not.
- Re-runs fall out of the board for free (1.4); an orchestrator would have to rebuild that.

Why not one big agent with an automation per role? One agent has one owner, one budget, one
version and one approver; doers would stop being cheap, separately testable and reusable; a
month-long run with waits would push Cloudflare's 1,024 durable steps; and §10.14's own split
signals (over 20 steps, different approvers, money-moving beside read-only) all fire.

### 1.3 Doers, analyzers, the lead: how each is represented

| Tier | Platform shape | Model | Oversight (`owner`) | Bindings |
|---|---|---|---|---|
| Doer | Client agent; deterministic skills only; last step a write step `fpa.handoff.mark` (`ready` or `issue`) behind an `if` on the tie-out result | None | `failures` | The accounting connection (read), sheets/upload |
| Analyzer | Client agent; deterministic skill (compare, project) then AI skill (explain, draft) per the v0.16 skill model; reads only through `fpa.*` read tools that return records of `ready` handoffs | Task skills on a cheap model; drafting on the agent's | `checkpoints` | **No connector bindings.** That is how "never on raw data" is enforced: publish refuses a connector tool on an analyzer template |
| Lead | Client agent; schedule + `fpa.role.due{lead}` + `fpa.handoff.issue` triggers; person steps to the finance lead; send email / post to Slack as external writes (approval on) | Agent's model for the brief and pack narrative | `checkpoints` | Email channel, Slack |

Two-phase roles (Variance: `compare` then `report`) keep one agent and one workflow: an `if` on
`{{trigger.entry}}` as the first step. Every agent stays a normal agent the operator can open,
test, pause and version, and the client sees each as a service in the portal.

### 1.4 Re-runs, loops and limits

- **Corrections.** A doer that re-pulls (a late journal entry) inserts a new handoff version; the
  old one and everything built from it (`inputs` contains it) go `superseded`; the dispatcher emits
  `due` again for the new input set. The analyzers' outputs are versioned the same way, so the pack
  always shows which trial balance it rests on.
- **No loops.** The graph is a DAG (core validates it when the pack's team definition is saved);
  `due` is emitted once per input set by a unique key; at most 5 versions of one output per cycle,
  then an `issue` to the Lead. Event triggers carry no depth, so these rules, not
  `MAX_HANDOFF_DEPTH`, are what bound the team.
- **Stalls.** Each output in the graph has an expected-by offset (business days from cycle open);
  the Lead's daily pass turns a missing one into an `issue`. Sloan's daily check already reports
  failed runs; it sees the team's runs like any others.
- **Test runs** mark nothing and emit nothing (as hand-off steps in test runs start nothing), so a
  test of the Variance agent can't start the Forecast agent. A team test runs the whole graph
  against the Sandbox with the fakes (section 6).

### 1.5 One correction to the brief

Step 3 of the first slice sends low-confidence mappings "to the finance lead as a question" from the
Ledger doer, which breaks rule 5 (only the Lead reaches the finance lead, batched). Proposal: the
Ledger marks `trial_balance` as `issue: unmapped` with the accounts; the Lead puts every open
question for the cycle on **one Desk card** (the materials request-lines card is the pattern); the
answers are saved as `account_mapping` rows with `source: human`; the Lead calls
`fpa.handoff.recheck`, which re-runs the deterministic mapping check and marks `ready`. Next month
the saved mapping answers it (acceptance 3).

### 1.6 Platform changes this needs (all small, all general)

| Change | Why | Size |
|---|---|---|
| Pack-declared team: roles, graph, templates (`PackManifest.team?`) and "Add the team" in the back office (and Reggie's `agent_add` card) forking every role's template in one go | The roster | M |
| Billing: agents of one team billed as one service | Today the base fee is per active client agent (`docs/plan.md` §1.17): nine fees for one FP&A service | S, owner's pricing call |
| Business-day calendar helper in core (`nthBusinessDay`, client holidays, already half there in `holidays/us.ts`) | "Business day 5", reminders at 2 and 4 business days | S |
| Move the MAD outlier rule from `packs/materials/src/pricing/rules.ts` to core | Performance reuses it; packs don't import packs | S |

Nothing in the executor, the router or the gate changes.

### 1.7 Open naming problem

"Lead" already means the operator person each client sees as "your Mezonas lead" (§11.2), and the
brief adds "finance lead" (the client's person) and "Lead (Sloan)" (the agent). Three leads will
confuse screens and code. Proposal: the agent is **not** Sloan (1.8) and gets its own identity name
(owner picks); in code the role is `conductor` or `fpa_lead`.

### 1.8 Sloan or a new agent?

A new agent from the FP&A pack, not Sloan with an FP&A role. Sloan is free, `suggest_only`, sees only
what the portal shows, has no connector bindings and writes only internal records for the person
asking (§9.8, invariant 11). The FP&A lead needs schedules, external sends, a real model budget and
pack-specific tools. Folding that into Sloan would loosen Sloan for every client. Sloan still
answers "where is October's pack?" from what the portal shows, and the weekly one-paragraph brief
should ride the **Weekly Table** (the Monday digest that already exists) rather than a new email.

---

## 2. Phases and order

The brief's order puts the lead last, but the first slice ends in the lead's approval and delivery,
and the team runtime is the riskiest part. Proposed order: prove the team on the thinnest slice
first, then widen.

| Phase | What | Done when |
|---|---|---|
| **0** | Owner decisions (section 8), ARCHITECTURE v0.19 "FP&A area" section, `docs/plan.md` §1 entry and milestones | Owner signs off |
| **1. Ledger model and the team runtime** | Platform: `accounting_period`, `trial_balance` + `trial_balance_line`, dimension kinds widened; the accounting contract (section 4) implemented for QuickBooks. Pack skeleton `packs/fpa`: `fpa_role`, `fpa_cycle`, `fpa_handoff`, the graph, dispatcher, `fpa.handoff.mark`, `fpa.role.due`; "Add the team" | QuickBooks trial balance (fake, then sandbox) ties to its own report to the cent; a two-role toy graph runs end to end on the Sandbox |
| **2. Budget vs. actual, end to end** | Forms F-1 to F-3 first (`docs/forms-plan.md`); budgets by upload / Sheets; `map-accounts`; Variance (compare, explain, report); Collector; a minimal Lead (cycle from the calendar, issue batching, one Desk card, approval, delivery); the second accounting connector | The four acceptance checks of the brief, the first one on two connectors with byte-identical bundles |
| **3. Forecast** | Drivers, `plan_amount` versions, roll-forward from explained variances, "what changed" | October's forecast version built from October's explained variances, with the diff |
| **4. Cash** | Cash inputs doer (bank feed, open bills and invoices, payroll schedule by upload), 13-week projection, runway, floor alert (daily exception path) | A cash floor breach reaches the finance lead once, within a day, with sources |
| **5. Metrics and Performance** | KPI definitions per client, refresh from accounting / CRM / Sheets, MAD anomalies, ties to variances | A KPI outlier is linked to its variance line in the pack |
| **6. Lead in full** | Weekly brief in the Weekly Table, monthly pack (portal report + PDF), quarterly scenarios and board pack | A quarter's board pack approved and delivered |

Why Forecast before Cash: it reads the tables phase 2 builds (variances, `plan_amount`) and needs no
new connector reads. Cash needs open items from a second system and a payroll schedule nobody syncs
(no payroll connector exists). If the first clients care most about cash, swap 3 and 4: nothing in
phase 3 depends on phase 4 or back.

---

## 3. What exists vs. what's new

### 3.1 Data

| Brief's table | Here | Status |
|---|---|---|
| account | `ledger_account` (platform, `packages/db/src/schema.ts`): per connection, `kind` already income / COGS / expense / asset / liability / equity in finer words, parent, active | **Exists** (QuickBooks sync only). Other connectors add their sync |
| dimension | `ledger_dimension`: kinds `class`, `location` | **Exists, widen**: add `department`, `project`, `property`, `tracking`, plus `group` (the system's own category name) |
| trial_balance_line | — | **New, platform** (the client's tool's numbers, read by Bookkeeping's reconciliation too) |
| period | — (QuickBooks' close date not read; enterprise-readiness E2) | **New, platform** `accounting_period`; shared with E2's lock date |
| open items | `transaction` (bills, synced), `receivable` (invoices), bank feed (`packs/bookkeeping`) | **Partly exists**; payroll schedule **new** (pack, uploaded) |
| budget_line, plan_amount, account_mapping, variance, driver, kpi_value | — | **New, FP&A pack** |
| handoff | — | **New, FP&A pack**, plus `fpa_cycle` and `fpa_role` |

### 3.2 Skills

Under the v0.16 skill model a skill is deterministic **or** AI, never both, so every "code + model"
row is two skills chained. Skills never write: each save is a write step on an internal tool.

| Skill | Here | Status |
|---|---|---|
| pull-trial-balance | QuickBooks already reads `/reports/GeneralLedger` (`qbo/register.ts`) | **New** (`accounting.trial_balance.read`), reusing the report client |
| tie-out | Reconciliation engine's decimal compare and residual (`packs/bookkeeping/src/reconcile/engine.ts`) | **New**, simpler (per account); the residual helpers move to core |
| map-accounts | Item matching's order (rules → known aliases → model → person, answer becomes an alias) | **New, two skills**: `fpa.map-accounts` (rules + saved mappings) then `fpa.map-accounts-ai` (model proposals with confidence) |
| pull-cash-inputs | Bank feed, `receivable`, `transaction`, QuickBooks AR aging (`qbo/ar.ts`) | **New** composition; payroll by upload |
| refresh-kpis | CRM connectors (HubSpot, Zoho CRM, Podio), Sheets | **New** |
| request-explanation | The brief says "reuse the Collections follow-up pattern": **Collections (Cole) is named in ARCHITECTURE but not built**. What exists: the `conversation` step (§10.12), person steps with deadlines and business hours, reach out | **Reuse the steps**, plus the new forms step (`docs/forms-plan.md`), new template |
| compare-to-plan | Price check (`packs/materials/src/pricing/check.ts`): % and absolute thresholds, severity, dedupe, evidence | **New**, same shape |
| explain-variance | — | **New**, AI task skill over GL detail of the line's accounts |
| roll-forecast | — | **New, two skills** (deterministic roll, AI adjustments with reasons) |
| project-cash | — | **New**, deterministic |
| detect-anomaly | MAD rule in `packs/materials/src/pricing/rules.ts` | **Reuse**, moved to core |
| assemble-pack | Weekly Table PDF (`pdf-lib`), pack reports in the portal | **New** |
| summary, send-email, post-to-slack | `threads.summarize`, Gmail / Resend send, Slack post | **Reuse** |

---

## 4. Connector contract

Agents never call a vendor. The FP&A tools are platform tools whose handler dispatches to the
client's bound **accounting connection** through an adapter, the way reach out picks the bound email
channel. A connector implements:

```ts
interface AccountingAdapter {
  periods(): Promise<{ start: string; end: string; closed: boolean; closedAt?: string }[]>; // from lock/close dates
  accounts(): Promise<NormalizedAccount[]>;        // → ledger_account
  dimensions(): Promise<NormalizedDimension[]>;    // → ledger_dimension
  trialBalance(p: { start: string; end: string }): Promise<{
    lines: { account: string; dims: Record<DimensionKind, string>; debit: string; credit: string; closing: string }[];
    currency: string;
  }>;                                              // built from GL detail, by account × dimensions
  reportTotals(p: { end: string }): Promise<{ account: string; balance: string }[]>; // the system's own TB report
  openBills(asOf: string): Promise<OpenItem[]>;
  openInvoices(asOf: string): Promise<OpenItem[]>;
}
```

Tools: `accounting.period.read`, `accounting.trial_balance.read`, `accounting.accounts.read`,
`accounting.dimensions.read`, `accounting.bills.read`, `accounting.invoices.read`. Event
`accounting.period.closed` where the sync can see a close or lock date move; otherwise the Lead's
calendar opens the cycle.

**Tie-out is two independent reads compared:** the trial balance built from GL detail, against the
system's own trial balance report, per account, in decimal, to the cent; plus debits = credits,
and dimension slices summing to the account total (an explicit "no dimension" bucket, never a
dropped remainder).

**Dimensions, normalised per system.** A fixed vocabulary plus the system's own group name, and a
per-client mapping ("our Xero tracking category *Region* is our location"):

| System | Native | Normalised |
|---|---|---|
| QuickBooks | Class, Department | `class`, `location` (as today) |
| Xero | Up to 2 tracking categories | `tracking` with `group`, mapped by the client |
| NetSuite | Department, class, location, subsidiary, custom segments | `department`, `class`, `location`; subsidiary is an **entity** (out of v1) |
| Odoo | Analytic plans and accounts; a line's `analytic_distribution` splits it by percent | `project` / `department` by plan; split lines allocated in decimal, remainder to the largest share |
| Yardi | Property, unit | `property` |
| Zoho Books | Reporting tags | `tracking` with `group` |

Periods: QuickBooks has no period object (calendar months plus `BookCloseDate`, unchecked whether
CDC sees it); Xero lock dates; NetSuite accounting periods; Odoo lock dates. The client's fiscal
calendar is a client setting; "closed" comes from the system.

---

## 5. Data migrations

Each in its own PR, additive, every table `tenant_id` with forced RLS on `app.tenant_ids`, money
`numeric(14,4)` plus currency. Numbers are the next free ones at the time (0055 on `main` today; the
merge backlog may take some).

| Migration | Contents |
|---|---|
| A (phase 1) | `ledger_dimension` kind check widened and `group` column (a wider check keeps the old Worker working); `accounting_period` (connection, start, end, status, closed_at); `trial_balance` (connection, period, pulled_at, raw_record ids, tie-out status and residuals) and `trial_balance_line` (account, `dims` jsonb, `dims_key` for uniqueness, debit, credit, net, closing, currency) |
| B (phase 1) | `fpa_role` (role → agent), `fpa_cycle` (cadence, period, status, opened_at, closed_at), `fpa_handoff` (cycle, role, output, record ref, version, status, inputs, notes, sources, `agent_version_id`), `fpa_due` (the dispatcher's once-only key) |
| C (phase 2) | `budget_line` (name, owner → directory person, dims, category), `plan_amount` (line, period, amount, version kind, version id), `account_mapping` (account, dims pattern, budget line, confidence, source, inbox item), `variance` (run, line, period, actual, plan, diff, diff %, YTD, severity, explanation, explained_by, confirmed, sources) |
| D (phase 3) | `driver`, `forecast_version` |
| E (phase 4) | `payroll_schedule`, `cash_projection` |
| F (phase 5) | `kpi_definition`, `kpi_value` |

---

## 6. Tests and fixtures

- **Sample books**, `fixtures/books/<system>/`: one small company (about 40 accounts, 3 classes or
  departments, 12 closed months, a budget, a few deliberate variances and one new account in month
  2), written once as the system-neutral truth, then rendered into each connector's payload shapes
  for its fake. The expected trial balance per month is in the fixture.
- **Tie-out test per connector**: the fake answers GL detail and the TB report from the sample
  books; the tie-out balances to the cent; a broken fixture (one cent off, a missing dimension)
  raises an `issue`, never `ready`.
- **One live tie-out**: Odoo Community runs in Docker, so the second connector can be tested
  against a real instance in CI, not only a fake. QuickBooks needs the sandbox keys (`docs/open.md`
  P3) for its live check.
- **Graph tests** (core): DAG validation, the dispatcher's once-only `due`, superseding, the
  5-version cap.
- **Team end to end** (like `apps/api/src/purchasing-email.test.ts`): open a cycle → Ledger →
  mapping question on one card → Variance → Collector (one owner answers by email, one goes silent
  and escalates) → report → Lead's approval → delivery. Run it twice, on QuickBooks' fake and the
  second connector's, with the same bundles (acceptance 1). Run month 2 and assert no mapping
  question (acceptance 3) and the report's confirmed / drafted split (acceptance 4).
- **Recorded model fixtures** (`LLM_MODE=replay`) for explain-variance, the mapping proposals and
  the narrative; a goldens set for mapping precision like matching's (≥ 95% on "same").
- **Contract tests**: no portal route returns a bundle, prompt or cost from the team's runs; analyzer
  templates hold no connector tool.

---

## 7. Estimates and risks

Sizes assume the pace of recent milestones; the calendar time that matters most is outside our
hands (partner and sandbox access).

| Phase | Size | Main risks |
|---|---|---|
| 0 | Days | Scope: FP&A is outside v0.18; the naming of "lead" |
| 1 | 2–3 weeks | QuickBooks report shapes are unchecked (all providers are fakes today); class / department columns on the TB report are unchecked, hence building from GL detail; the team runtime is new ground |
| 2 | 3–4 weeks | Second connector access; mapping accuracy on messy charts; owners not replying (rules 4 and 5 keep it from becoming noise); timing and accruals (section 8) |
| 3 | 2 weeks | Forecast method per client varies a lot; keep v1 to roll-forward plus driver lines |
| 4 | 2 weeks | Payroll has no connector; bank feed needs Plaid live (`docs/open.md` K1–K3) |
| 5 | 2–3 weeks | KPI definitions are client-specific; CRM connectors are unchecked against live services |
| 6 | 2–3 weeks | Board pack format expectations; PDF layout |

Cross-cutting risks: nine agents per client in billing and in the client's portal (they should read
as one service with roles); run volume and cost of daily doers across many clients (doers have no
model, so cost is mostly sync); the team runtime staying in the pack until a second team (sales)
shows what should move to the platform.

---

## 8. Open questions, with a proposal for each

| Question | Proposal |
|---|---|
| Second accounting connector: Xero, NetSuite or Yardi? | **Odoo first for the acceptance gate** (the connector exists, and Odoo Community runs in Docker for a real tie-out), **Xero next** (free developer app and demo company, quick). Start NetSuite and Yardi partner access now; both take weeks. If a signed pilot is on one of them, it goes first instead |
| Can budget owners reply by Slack or text? | **A form link by email or text** (`docs/forms-plan.md`): typed answers per flagged line, support files, dictation or talking it through. Our Slack connector only posts to picked channels; Slack replies need its events API (later) |
| Accruals and timing adjustments before comparison | v1 compares as booked. An owner's explanation can be tagged "timing" with the period it reverses in; Forecast reads it. No journal entries proposed in v1 (a write to the books, approval-heavy, out of scope) |
| Is the lead a new agent or Sloan? | New agent (1.8) |
| Multi-entity and FX in v1? | Later. `ledger_account` is already per connection (the owner's 2026-11-08 decision), so a second entity brings its own chart; consolidation and FX translation are their own phase. v1: one entity, one currency per client, refused otherwise |
| Billing for a team | One service, not nine agents (1.6). Owner's pricing call |
| Reminder at 2 business days | Check whether the deadline model's reminder covers it; else a `repeat` with `between`, which is clock time today (`docs/plan.md` §1.99 leaves business hours there open) |
