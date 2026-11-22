# Reporting: runs, agents and accounts, searched by their data (agreed, 2026-11-22)

Agreed by the owner on 2026-11-22 (§5). It extends the runs lists (ARCHITECTURE §10.10) and search
and plain-words questions (§11.6). R1 is `docs/plan.md` §1.188, migration 0077.

## 1. What we have

| Where | What it does |
|---|---|
| Runs lists, both surfaces | One typed filter, `RunFilter` (`packages/core/src/api/runs-filter.ts`): agent, status, dates, how it started, who signed, the tool a change was made in, attempts, an amount on a change, cost and error (back office only), and `text`. |
| `text` | Matches a short id (`R-1a2b3c`), an agent's or service's name. The back office also matches the workflow, the error's words and step summaries. |
| Plain-words questions | "Bills Iris entered over $5,000" becomes a `RunFilter` (`runs-ask.ts`). The model fills in a typed filter and never writes SQL. Whatever the filter can't express is listed as left out. |
| ⌘K search | Agents, documents, organizations, people, records (transactions, receivables, vendors) and runs (`apps/api/src/search/queries.ts`). |
| Saved views | Named filters, back office only (`saved_view`, `/api/ops/saved-views`). The `portal_runs` surface exists in the schema; no route or screen uses it. |
| A run's subject | Its title, worked out when a response is built (`apps/api/src/runs/subject.ts`): the document that started it, else its first change, else what started it. Not stored. |
| Reports | The portal's activity report (`/api/reports/activity`) and service page; the weekly Table with each agent's KPIs (`clientView`); pack reports with CSV; the back office's usage and tokens; a run's export and audit. |

## 2. What is missing

1. **Runs can't be found by what they were about.** For example: "the runs about Acme Supply",
   "the run that handled invoice 4471", "everything that touched PO-1032", "runs with a line for
   2x4 studs". The data is there, but only inside the JSON of step inputs and outputs, external
   actions and documents. Nothing indexes it or links it to the run. `text` doesn't reach it, and
   the portal matches even less.
2. **A record doesn't lead to its runs.** From a vendor, a transaction or a document there is no
   "what did our agents do with this?".
3. **No report per agent.** Its numbers for a period are spread over the service page, `runs7d`,
   `perDay` and the activity report. There is no single page with outcomes, time, approvals, money
   and errors.
4. **No report per account in the back office.** Nothing shows one client's month across all its
   agents, and nothing shows every client side by side to see which needs us.
5. **Figures don't open their runs.** A number on a report should open the runs list filtered to
   exactly the runs behind it.
6. **Clients can't save a view**, and nothing but the weekly Table is sent on a schedule.

## 3. The design

### R1. What a run is about, kept as it happens (migration, then code)

A new tenant table, `run_subject`: one row per thing a run read, decided on or changed.

| Column | What |
|---|---|
| `tenant_id`, `run_id`, `step_run_id` | Whose and where. Composite foreign keys, as `step_run`. |
| `kind` | `document`, `vendor`, `customer`, `organization`, `person`, `transaction`, `item`, `message`, `record`. |
| `role` | `read`, `decided` or `changed`. |
| `record_id` | Our record's id, when there is one. |
| `connector`, `external_id` | The client's tool and its id for the thing (a QuickBooks bill), when there is one. |
| `label` | The name a person reads (a vendor's name, a file's name). Data, never instructions (invariant 9). |
| `number` | The document's own number (an invoice or PO number). |
| `amount`, `currency` | `numeric(14,4)` and a currency, when it carries money (invariant 6). |
| `client_visible` | Whether the step is one the client's timeline shows. The portal reads only these. |
| `created_at` | |

RLS is forced on `app.tenant_ids` (invariant 1). Rows are insert only, like the run's history
(invariant 3). Indexes: `(tenant_id, kind, record_id)`, `(tenant_id, run_id)`, and trigram on
`label` and `number` (`pg_trgm`, already used by the Materials and Sales areas).

**Who writes it.** The step log, when a step finishes, from four places. No pack is special-cased
(invariant 2):

1. The step output's `sources` (record ids, invariant 10). Their kind comes from the record's own
   table.
2. A new optional `about` on `ToolSpec`, declared the way `amount` already is: which output fields
   name the record, its label, its number and its amount. Packs declare it on their own tools, so
   the purchasing request, the quote and the PO name themselves.
3. Each external action: its connector, entity, the fields its `display` names and its amount
   (`ToolSpec.amount`), with role `changed`.
4. The trigger: the document or message that started the run.

**Backfill.** A one-off job, batched per client, over the last 90 days of runs. It reads external
actions, triggers and step outputs' `sources`. The run subject (`runs/subject.ts`) then reads
`run_subject` first and falls back to what it does today.

### R2. Search runs by it

- `RunFilter` gets `about`: up to 20 entries, each a record (`kind` and `id`) or words matched
  against `label` and `number`. It is a filter key on both surfaces. The portal matches only
  `client_visible` rows.
- `text` also matches subject labels and numbers, on both surfaces.
- **Plain-words questions** return `aboutText` ("Acme"). Code resolves it to records with the
  search queries we already have and shows them as chips the person can correct. The model is
  never handed the client's vendor list.
- **⌘K**: a record hit says how many runs are about it, and opens the runs list filtered to them.
- The ops MCP server's `runs_list` and Sloan's run questions get the same filter. Sloan still sees
  only what the portal shows (invariant 11).

### R3. From a record to its runs

Record pages on both surfaces get a **Runs** panel: vendor, customer, transaction, document,
organization and person. It lists the runs about the record, newest first, each with its role
("read", "matched", "changed in QuickBooks") and the step's summary.

### R4. A report per agent

- Back office: `GET /api/ops/agents/:id/report?from&to`. Portal: `GET /api/services/:id/report`.
- Default period: this month, compared with last month.
- Every figure carries the `RunFilter` that produces it, so a click opens exactly those runs.

| Figure | Notes |
|---|---|
| Runs by outcome, per day | Done, waiting, failed, stopped. |
| Time to finish | Median and 90th percentile, live runs only. |
| Time waiting on people | From each item's creation to its answer. Both surfaces; it is the client's own time. |
| Approvals | Signed as shown, edited before signing, turned down; by person. |
| Changes | By tool and record type, with amounts totalled per currency (decimal). |
| What it handled | Documents read, records matched, people messaged, from `run_subject`. |
| The agent's own KPIs | The `clientView` KPIs over the period. |
| Errors | The five most frequent, with counts. Back office only. |
| Cost and tokens per run | Back office only (invariant 11). |

CSV on both surfaces.

### R5. A report per account, and every account side by side

- **One client** (`GET /api/ops/clients/:id/report`; portal `GET /api/reports/account`):
  - one line per agent with R4's headline figures;
  - what is waiting now, and the oldest wait;
  - failed runs nobody has looked at;
  - connections that need attention, `refresh_failing` included (C4.2);
  - usage against the allowance;
  - this month against last.
- **Every client** (`/ops/accounts`): one row per client the operator serves, with the same figures,
  sortable. "Needs us" comes first: something waiting past a day, a failed run nobody has looked at,
  a broken connection or an allowance nearly used. Each figure opens what is behind it.

### R6. Saved views for clients

- The portal gets saved views (`portal_runs` already exists in the schema). A view belongs to its
  person; a client admin can share one with the client's team.
- Reports by email: not now (§5, answer 5). Built per agent as they come up.

### Later, not in R1 to R6

Filtering runs by a value inside a step's output ("the extracted total over 1,000"). The KPIs
already name a step and a dotted path into its output (`clientView`), so a filter on a KPI's value
is the safe way to do it. It is not a free-form JSON path.

## 4. Order and PRs

| Step | PR | Size |
|---|---|---|
| R1a | Migration: `run_subject`. | S |
| R1b | `ToolSpec.about`, the step log's writer, `about` on the tools that keep records (platform and packs), the backfill job, `runs/subject.ts` reading it. | L |
| R2 | `RunFilter.about`, `text` over subjects, plain-words `aboutText`, ⌘K counts, MCP and Sloan. | M |
| R3 | The Runs panel on record pages, both surfaces. | M |
| R4 | The agent report: routes, screens, CSV. | L |
| R5 | The account report and `/ops/accounts`. | L |
| R6 | Portal saved views. Migration if a view gets shared. | M |

Contract tests for every portal route here: no cost, no bundle, no instructions, nothing from a
step the client's timeline doesn't show, and only one client (invariants 1 and 11).

## 5. The owner's answers (2026-11-22)

1. **Clients search their runs by vendor, customer and document number: yes**, limited to what
   their timeline already shows (`client_visible`).
2. **The agent report is the same on both surfaces**, apart from cost and errors: yes.
3. **"Needs us" on `/ops/accounts`** (owner: we decide): something waiting more than a day, a
   failed run nobody has looked at, a connection that needs attention (`error` or
   `refresh_failing`), or an allowance over 80% used. // DECISION
4. **Money totals on the client's agent report: yes**, per currency.
5. **Reports by email: not yet.** We build them per agent as they come up. R6 is the portal's saved
   views only.
