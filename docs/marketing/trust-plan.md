# Trust claims: what we keep, what we change

Status: **draft for the owner's decisions**, 2026-11-09, refreshed 2026-11-20 · Owner: Jammil

The plan for 17 trust claims, grouped by the fear each answers ("they're training AI on my data",
"AI can see everything", and so on). For each: what is true on `main` today, whether to keep it as
it is or change it, and the claim we can make once it's done. Every claim still goes through
`docs/marketing/claims.md` before it appears in public; nothing here changes that list until the
owner decides.

The Security page (`apps/site/src/content/security.mjs`) already makes some of these claims. §6
checks each of its lines against this plan.

Masking (§3.3) and the data receipt (§3.4) are outside ARCHITECTURE v0.20's v1 scope. The owner
has kept the masking promise on the Security page (2026-11-16, `docs/merge-backlog.md`), so masking
is a promise to make true, not an option: it needs an ARCHITECTURE version and a milestone in
`docs/plan.md` before anyone builds it. The receipt still needs the owner's yes first.

## 1. In short

| | Items |
|---|---|
| **Keep as is**, with the claim worded to match | 5 tool access · 8 tenancy · 9 no cross-client learning · 10 least privilege · 11 approvals · 12 no money movement (a decision on BILL, §2) |
| **Keep the design, don't build the suggested version** | 2 via Bedrock or Vertex · 7 field-level scoping · 15 just-in-time access · 9 benchmarks |
| **Change: vendors and legal** (no code) | 1 terms on file · 2 zero retention · 3 ElevenLabs and Twilio · 4 the DPA · 17 SOC 2 (started: officer and two policies) |
| **Change: code**, in this order | 13 log every model call (runs done; the rest left) · 16 self-serve export and deletion on time · 6 masking (promise kept) · 14 the data receipt · 15 the client's view of our access (partly there) |

## 2. Keep as is

These are built and hold. The only change is wording: say what is true, not more.

| # | What is true today | Claim to make |
|---|---|---|
| 5 | Agents reach data only through registered tools; each model call gets what its step needs (invariant 2). No tool hands an agent a whole export. | "AI sees only what a task needs, never your whole books." |
| 8 | Row-level security on every client table, files under the client's own prefix, memory per client (invariant 1). The client's own key encrypts its logins and keys; records rely on Neon's and R2's encryption at rest (`docs/hipaa-plan.md` T6). | "Your data is walled off, down to each row. Your logins and keys are encrypted with a key that is yours alone." Not "separate storage" or "separate keys" for everything. |
| 9 | Nothing learns across clients. Forks and promotions carry an agent's settings, never a client's memory, records or connections (invariant 11). Memory notes are read live, per client (ARCHITECTURE §10.16). | "Nothing learned from your business is used for anyone else. We may reuse how an agent is set up, never your data." |
| 10 | Gmail and Outlook are send only (`gmail.send`; Microsoft `Mail.Send`, no read scope). Plaid is transactions only (a test holds it). Ramp reads, and only attaches receipts. BILL writes vendors and bills behind approval; its payments are refused (item 12). QuickBooks has one Intuit scope that includes writing, so our matrix holds it down: reads, and every write behind approval. | "We ask for the minimum access, and you can see exactly what, on your Access page." Not "read-only QuickBooks." |
| 11 | Approval is on by default; a step runs alone only when we set it so with you, your matrix allows it and the agent acts (invariant 8). An agent in trial or sign-off has every write signed. | "Agents propose; people approve." With the condition `claims.md` already sets for routine steps. |
| 12 | No tool pays or transfers money. QuickBooks' `qbo.deposit.create` and `qbo.transfer.create` record a booking in the books; they move nothing (`packages/connectors/src/qbo/banking.ts`). Plaid can't move money, and an item that could is removed. Payment pages and bank sites are blocked for browser logins. BILL's `billcom.payment.create` is defined but refused when proposed and at the write (`BillcomPaymentRefused`), starts off in the matrix and always needs a person (`docs/plan.md` §1.87). | "Agents can't pay, transfer or move funds." Holds only while BILL payments stay off: `docs/open.md` lists "code still needed for payments", and the agents' guardrail already allows a pay tool a person signs (`packages/core/src/governance/guardrails.ts`). Owner decides (§7). Add the contract test (§3.6). |

## 3. Change

### 3.1 Vendors and legal (owner; no code)

| # | Change | Why | Then claim |
|---|---|---|---|
| 1 | Keep a dated copy of the accepted commercial terms of every model provider with the policies: Anthropic and OpenAI, and xAI and Google (Gemini API, paid tier) before either gets client data (`docs/operations.md`, "Model keys", step 6: add them to `/subprocessors` first). Check the plan behind the Ops MCP connector: operators' Claude conversations send what the tools return to Anthropic through claude.ai, under that plan's terms, not the API's. Use it only from a Team or Enterprise plan, or don't use it on client data. Each MCP tool call is now in the audit log (PR #407), but that doesn't change whose terms apply. | The API terms already say no training. The connector is the gap. | "Your data is never used to train AI models." |
| 2 | Ask Anthropic for zero data retention on our API organization. Ask which features it covers: web research (`anthropic_web`) and anything server-side may not be. For OpenAI and xAI we already send `store: false`; ask each for the same, or keep their models out of the claim (no agent uses them by default). Google: the same, or out. **Don't move inference to Bedrock or Vertex**: it adds AWS or Google Cloud as a subprocessor and another model path, for a promise zero retention gives directly. Revisit only if a client requires it. | Privacy policy §7 says providers keep data "typically up to 30 days" today, so this claim would contradict it. | After the agreement, and privacy policy §7 updated: "AI providers don't keep your data after the task is done." |
| 3 | ElevenLabs: move Mezonas to its own workspace with its own key (`elevenlabs/NOTES.md` step 1; `docs/enterprise-readiness.md` lists it as "Later", which this claim can't wait for); set conversation retention to the minimum (transcripts and audio), not only `record_voice: false`, which we already set. Check the field names against the API, as `NOTES.md` still marks them unchecked, then set them in code (§3.6). Twilio: ask about message redaction and set recordings off or short. OCR has no separate vendor: documents are read by the model. | The shared personal workspace mixes Mezonas with other work. | "Every vendor in the chain is held to the same standard." |
| 4 | A data processing addendum for every client, not only for website measurement. Start from `docs/marketing/processor-terms-draft.md` §3, which already maps GDPR Art. 28 and the CCPA's terms to what we do. Publish it beside the terms. | The subprocessor list is done; the DPA is not (the terms link only the privacy policy and the list). | "Here's every company that touches your data, and why." (true now for the list, while xAI and Google get no client data) |
| 17 | Carry on with SOC 2 as `docs/hipaa-plan.md` §5–6 says. Done: the security officer is named and two policies are drafted (`docs/policies/information-security.md`, `data-retention.md`); the security register is in `docs/security.md` (PR #318). Left: the risk analysis, the other policies, training, a compliance tool, then Type I. | The groundwork has started; nothing an auditor would sign has. | Nothing until the report exists (`claims.md` "Never"). |

### 3.2 Log every model call (13) · small · first

Done (PR #327, migration 0055; PR #324; `docs/plan.md` §1.115): every model call inside a run is a
`model_call` row with the request and answer in the client's own storage, and `action` says what
it was for (`agent_turn`, `oversight`, `reach_out`, `tool_call`, `question`, `conversation`,
`check`, `choice`). A pack tool's own model call is its step's row. A portal question to Sloan is a
row on its question run, without a body. The back office tallies them at `/ops/usage`.

Also done (PR #414, §1.143): every model call outside a run goes through one entry point,
`apps/api/src/compliance/models.ts`, which names the clients each call may carry, and a source scan
(`compliance-models.test.ts`) fails on a transport made anywhere else.

Left: the operator's calls are recorded nowhere: the Builder, builds, Reshape, Reggie, back-office
questions and search, and the test bench (§1.115, "Not in it"). Background reading and translation
are counted from `doc_extraction` and `message_translation`, with no `model_call` row; voice typing
is in neither.

- Migration (its own PR): `run_id` and `step_run_id` become nullable, and `action` takes the new
  kinds (`builder`, `build`, `reggie`, `ops_question`, `test_bench`). No `purpose` column:
  `action` covers both (`docs/merge-backlog.md`). Keep the insert-only trigger and the body-key
  check.
- Record those calls at the entry point, through the same `ModelCallPort`. A call that names one
  client is that client's row. A call on a template, or one that spans clients (Reggie, questions
  across clients), names none: store it as an operator row, or leave it out and say so (DECISION
  for the plan).
- Extend `compliance-models.test.ts` so a call through the entry point that isn't recorded fails.

Then: "Every call to an AI model is recorded: what was sent, what came back, which agent and which
task." Say "every access is recorded" only together with the audit log (item 15).

### 3.3 Masking before the model (6) · large · promise kept by the owner

Not built. The Security page promises it, labelled "Coming soon" until it ships: "Account numbers
and personal details will be replaced before any model sees them." Its demo shows `[VENDOR_14]`,
`[PHONE_3]` and `[BANK_ACCOUNT_1]` in place of the vendor, its phone and the remit-to account.

What to build:
- A pure masker in `packages/core` with no model in it: deterministic patterns for bank account
  and routing numbers, card numbers (we have the check), SSN, ITIN and EIN; and the emails and
  phone numbers in the client's directory, matched by value.
- Where it runs: in the runtime (`packages/agents`) for a run's calls, and at the entry point
  (`apps/api/src/compliance/models.ts`) for every call outside a run. Two places, not dozens.
- Mask tool results and message text before they go into a model request; restore placeholders in
  the model's tool inputs before the permission gate, so the approval preview, the write and its
  before state hold real values. One placeholder per value per run, written as the page shows them
  (`[PHONE_3]`), so the model can still tell that two things are the same.
- The placeholder map lives with the run, encrypted with the client's key, never in a log, step
  output or `model_call` body. `model_call` keeps the masked request: the log shows what the model
  saw.
- Names: the 11-09 plan kept them, since agents match vendors and write polite emails with them.
  The page's demo masks the vendor's name ("It never needs to know who the vendor is"). Owner
  decides (§7): mask company names too, or keep them and change the demo's first row and caption.

The limit we must say plainly: **documents are read by the model as PDFs and images**
(`packages/documents/src/extract.ts`). Text masking can't reach inside them, so "before any model
sees them" isn't true until documents are covered too. Either add a step that turns a document into
text before the model (a new component, or a new vendor for scans), or narrow the page's line to
"records and messages". Owner decides (§7). "Coming soon" stays until one of them is done.

Then: "Bank and card numbers, tax IDs and your contacts' emails and phone numbers are replaced
before an AI model sees the records and messages agents work with." Not "sensitive identifiers
never reach an AI model", while documents are read whole.

### 3.4 The data receipt (14) · medium · needs the owner's yes · after 3.2 and 3.3

Not built. A "What this run used" panel on the portal's run page, built from rows we already keep:
- the records each step read (type and label, from `tool_call`);
- what went to which AI provider: provider, number of records, number of masked values (from
  `model_call` and the masker's counts);
- what was written and who approved it (`external_action`).

It never shows prompts, instructions, model ids or cost, so invariant 11 holds; a contract test on
the new route checks it. A monthly summary per agent can come later.

Then: "See what each agent looked at and what it sent to AI, on every run."

### 3.5 Our own access, shown to the client (15) · small

Keep standing access: we build and run the client's agents, so a request-and-wait step for every
look would stall the service. What we already have is the stronger promise: our team sees only the
clients it serves, every read is in the audit log (MCP tool calls too, PR #407), stepping into an
item takes a reason, and the client can already see it in two places:
- the client admin downloads the log as CSV from the portal's Exports page
  (`GET /api/audit/export.csv`, `apps/api/src/routes/audit-export.ts`), where our reads show as
  "Mezonas" and the client's lead by name;
- each run page shows who opened the run or its items and who signed (`GET /api/runs/:id/audit`).

Left:
- A portal page for the whole log, not only a CSV (`docs/hipaa-plan.md` T3 and
  `docs/enterprise-readiness.md` E8). T3 still says clients can't see their log; it should say the
  CSV and the run trail exist and only the page is left.
- Optional, later: a weekly line in the client's report, "Mezonas opened 4 items this week".

Then: "Even our team can't open your data without a record, and you can see that record."

### 3.6 Exit and the small fixes (16, 12, 3) · small to medium

- **Self-serve export:** the full export (`apps/api/src/exports/client-data.ts`) still starts only
  from the back office (`POST /api/ops/clients/<id>/exports`). The portal has the accountant export
  and the audit log, not the full one. Add a portal route for the client admin, with the same job
  and audit. A retired client can't sign in, so after leaving we still send it ourselves.
- **Deletion on time:** the privacy policy (§10) and `docs/policies/data-retention.md` promise
  deletion within 30 days. Files go at day 30; rows go only when the owner runs Purge client
  (`purge-client.yml`, PR #423), which refuses until day 30 has passed and the files are gone. So
  rows always outlive the promise. The terms (§12) also promise an export to anyone who asks
  within 30 days, which needs the files until day 30. Both can't hold. Either shorten the export
  window in the terms and purge earlier, so files and rows are gone by day 30, or change the
  privacy policy and the retention policy to a longer deletion time (lawyer). Owner decides (§7).
- **Vendor deletion** (`docs/hipaa-plan.md` T5): close the Twilio subaccount and delete ElevenLabs
  agents and conversations through their APIs on retirement, instead of by hand from
  `docs/operations.md`'s checklist.
- **No pay verbs:** not built. A contract test over every connector manifest that fails on a tool
  that pays, transfers or refunds. It must tell a booking from a payment: QuickBooks' deposit and
  transfer record entries and stay allowed, by name, with the reason. BILL's payment tool is listed
  as refused, and the test fails if it stops refusing without the claim changing.
- **ElevenLabs retention in code:** once §3.1's fields are checked, set them where the agent is
  created (`packages/connectors/src/elevenlabs/index.ts`).

Then: "Leave anytime: download everything yourself, and we delete it within 30 days."

## 4. Don't build

| Suggested | Why not | Instead |
|---|---|---|
| Inference through Bedrock or Vertex | A new subprocessor and model path for what zero retention gives directly | §3.1, item 2 |
| Field-level scoping per agent | Grants already narrow by connection, verb and entity (bills, payments); field lists per agent would be hard to keep right and to show | Keep entities; masking (§3.3) covers the sensitive fields; claim "each agent reaches only the tools and records it is given" |
| Just-in-time access for our staff | Running clients' agents is our daily work | §3.5: scoped, audited, and visible to the client |
| Benchmarks from anonymised aggregates | Not in v1 scope, and one wrong aggregate breaks the strongest promise we have | Revisit with an explicit opt-in if clients ask |

## 5. Order

1. Now, owner: §3.1 items 1 and 3 (terms on file, the MCP connector's plan, ElevenLabs workspace);
   ask Anthropic about zero retention; lawyer on the DPA and on deletion timing.
2. Code, small: §3.2 (migration PR, then the code), §3.5's page, §3.6.
3. Masking: an ARCHITECTURE version and a milestone (the owner has said yes to the promise).
   The owner decides on names and documents, and on the receipt.
4. Code, larger: §3.3, then §3.4.
5. As each lands: add its claim to `docs/marketing/claims.md` and
   `fixtures/marketing/mezonas-claims.json`, with its reason, and update the privacy policy where
   it changes (§7 for retention and masking). For masking, also remove "Coming soon" from the
   Security page (`soon: true` in `security.mjs` and the label on the demo in
   `apps/site/src/components.mjs`).

Leading the messaging: item 5 is ready now; 13 after §3.2; 6 and 14 only after §3.3 and §3.4.
Until then, lead with 5, 11, 12 and the audit log.

## 6. The Security page, checked (2026-11-20)

`apps/site/src/content/security.mjs`, line by line. "Change" means the line says more than this
plan or `claims.md` supports.

| Line | Status |
|---|---|
| Walled off per client: kept apart down to the row, logins encrypted with its own key, no shared memory | True (items 8, 9). |
| Least access: read-only where possible, send-only email, agents can't move money | True today (items 10, 12). The BILL decision (§7) decides whether "can't move money" stays. |
| Masking before AI: "will be replaced before any model sees them", Coming soon | Not built; the owner keeps it. §3.3, with the names and documents decisions. |
| Never used for training: "Enterprise terms with every AI provider bar it" | We hold commercial API terms, not enterprise agreements (privacy policy §7). Change "Enterprise terms" to match, or get them. True for xAI and Google only once item 1 is done for them. |
| Every access logged, including our own team's | True (audit log, item 15). |
| "Held to enterprise-grade security compliance standards" | Change: not in `claims.md`, and close to its "Never" entries (compliant, bank-level). Drop it until SOC 2 has a report (item 17). |
| Integrity: "Nothing posts without approval" | Change: a routine step can run on its own (item 11). Needs `claims.md`'s condition, or "Approval is on unless we set a routine step with you". |
| Permissions: accounting "Writes only what you signed" | Same as the line above. |
| Permissions: "Your money: Never" | True today (item 12); see the BILL decision. |
| Masking demo: vendor name masked | See the names decision (§3.3). |

Not checked here: "Checked twice" and the Worksheet demo, which are about integrity, not these
items.

## 7. Decisions for the owner

Made:
- [x] Keep the masking promise on the Security page (2026-11-16, `docs/merge-backlog.md`).
- [x] One column for what a model call was for: `action` (migration 0055), not a new `purpose`.

Open:
- [ ] Ask Anthropic for zero data retention, and whether OpenAI, xAI and Google stay in the claim.
- [ ] The plan the Ops MCP connector runs under, or keep it off client data.
- [ ] Masking: company names masked or kept; documents turned into text first, or the page's line
      narrowed to records and messages.
- [ ] The data receipt (§3.4) into scope.
- [ ] Deletion timing (§3.6): a shorter export window and an earlier purge, or a longer promise.
- [ ] BILL payments: stay off, so "Agents can't move money" holds, or built with a person's
      signature, and the claim and the Security page change first.
- [ ] The Security page's wording (§6): "Enterprise terms", "enterprise-grade" and "Nothing posts
      without approval".
- [ ] The DPA with counsel; when to start the risk analysis and pick a compliance tool for SOC 2.
