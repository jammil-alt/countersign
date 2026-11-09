# Trust claims: what we keep, what we change

Status: **draft for the owner's decisions**, 2026-11-09 · Owner: Jammil

The plan for 17 trust claims, grouped by the fear each answers ("they're training AI on my data",
"AI can see everything", and so on). For each: what is true today, whether to keep it as it is or
change it, and the claim we can make once it's done. Every claim still goes through
`docs/marketing/claims.md` before it appears in public; nothing here changes that list until the
owner decides.

Two of the changes (masking, §3.3, and the data receipt, §3.4) are outside ARCHITECTURE v0.15's v1
scope. They need the owner's yes, then an ARCHITECTURE version and a milestone in `docs/plan.md`,
before anyone builds them.

## 1. In short

| | Items |
|---|---|
| **Keep as is**, with the claim worded to match | 5 tool access · 8 tenancy · 10 least privilege · 11 approvals · 12 no money movement · 9 no cross-client learning |
| **Keep the design, don't build the suggested version** | 2 via Bedrock or Vertex · 7 field-level scoping · 15 just-in-time access · 9 benchmarks |
| **Change: vendors and legal** (no code) | 1 terms on file · 2 zero retention · 3 ElevenLabs and Twilio · 4 the DPA · 17 SOC 2 |
| **Change: code**, in this order | 13 log every model call · 16 self-serve export and deletion on time · 6 masking · 14 the data receipt · 15 the client's view of our access |

## 2. Keep as is

These are built and hold. The only change is wording: say what is true, not more.

| # | What is true today | Claim to make |
|---|---|---|
| 5 | Agents reach data only through registered tools; each model call gets what its step needs (invariant 2). No tool hands an agent a whole export. | "AI sees only what a task needs, never your whole books." |
| 8 | Row-level security on every client table, files under the client's own prefix, memory per client (invariant 1). The client's own key encrypts its logins and keys; records rely on Neon's and R2's encryption at rest (`docs/hipaa-plan.md` T6). | "Your data is walled off, down to each row. Your logins and keys are encrypted with a key that is yours alone." Not "separate storage" or "separate keys" for everything. |
| 9 | Nothing learns across clients. Promoting a client's improvement into a template carries its settings, never its data (invariant 11). | "Nothing learned from your business is used for anyone else. We may reuse how an agent is set up, never your data." |
| 10 | Gmail is send only. Plaid is transactions only (a test holds it). Ramp reads, and only attaches receipts. QuickBooks has one Intuit scope that includes writing, so our matrix holds it down: reads, and every write behind approval. | "We ask for the minimum access, and you can see exactly what, on your Access page." Not "read-only QuickBooks." |
| 11 | Approval is on by default; a step runs alone only when we set it so with you, your matrix allows it and the agent acts (invariant 8). | "Agents propose; people approve." With the condition `claims.md` already sets for routine steps. |
| 12 | No tool pays or transfers: QuickBooks payments are read only, Plaid can't move money, payment pages and bank sites are blocked for browser logins. | "Agents can't pay, transfer or move funds." Add a contract test so a future connector can't add a pay verb unnoticed (§3.6). |

## 3. Change

### 3.1 Vendors and legal (owner; no code)

| # | Change | Why | Then claim |
|---|---|---|---|
| 1 | Keep a dated copy of the accepted commercial terms of Anthropic and OpenAI with the policies. Check the plan behind the Ops MCP connector: operators' Claude conversations send what the tools return to Anthropic through claude.ai, under that plan's terms, not the API's. Use it only from a Team or Enterprise plan, or don't use it on client data. | The API terms already say no training. The connector is the gap. | "Your data is never used to train AI models." |
| 2 | Ask Anthropic for zero data retention on our API organization. Ask which features it covers: web research (`anthropic_web`) and anything server-side may not be. For OpenAI, either the same, or keep `openai:` models out of the claim (no agent uses them by default). **Don't move inference to Bedrock or Vertex**: it adds AWS or Google as a subprocessor and a third model path, for a promise zero retention gives directly. Revisit only if a client requires it. | The privacy policy says providers keep data "up to 30 days" today, so this claim would contradict it. | After the agreement, and the privacy policy §6 updated: "AI providers don't keep your data after the task is done." |
| 3 | ElevenLabs: move Mezonas to its own workspace with its own key; set conversation retention to the minimum (transcripts and audio), not only `record_voice: false`, which we already set. Check the field names against the API, as `elevenlabs/NOTES.md` marks them unchecked, then set them in code (§3.6). Twilio: ask about message redaction and set recordings off or short. OCR has no separate vendor: documents are read by Anthropic. | The shared personal workspace mixes Mezonas with other work. | "Every vendor in the chain is held to the same standard." |
| 4 | A data processing addendum for every client, not only for website measurement. Start from `docs/marketing/processor-terms-draft.md` §3, which already maps GDPR Art. 28 and the CCPA's terms to what we do. Publish it beside the terms. | The subprocessor list is done; the DPA is not. | "Here's every company that touches your data, and why." (true now for the list) |
| 17 | Start SOC 2 as `docs/hipaa-plan.md` §5–6 says: policies, risk analysis, a compliance tool, then Type I. | Nothing administrative has started. | Nothing until the report exists (`claims.md` "Never"). |

### 3.2 Log every model call (13) · small · first

Today `model_call` records every call made inside a run, with the request and answer in the
client's own storage. Calls outside a run aren't recorded there: the Builder
(`packages/agents/src/builder/builder.ts`, `skill-draft.ts`), the question box on a run
(`apps/api/src/runs-ask/ask.ts`) and documents read outside a run.

- Migration (its own PR): `run_id` and `step_run_id` become nullable, plus a `purpose` column
  (`run_step`, `builder`, `ask`, `document`, `translation`). Keep the insert-only trigger and the
  body-key check. A Builder call on a template has no client: store it as an operator row, or
  leave it out and say so (DECISION for the plan).
- Record those calls through the same `ModelCallPort`.
- A test lists every caller of the model client and fails when one isn't recorded.

Then: "Every call to an AI model is recorded: what was sent, what came back, which agent and which
task." Say "every access is recorded" only together with the audit log (item 15).

### 3.3 Masking before the model (6) · large · needs the owner's yes

What to build:
- A pure masker in `packages/core` with no model in it: deterministic patterns for bank account
  and routing numbers, card numbers (we have the check), SSN, ITIN and EIN; and the emails and
  phone numbers in the client's directory, matched by value.
- In the runtime (`packages/agents`): mask tool results and message text before they go into a
  model request; restore placeholders in the model's tool inputs before the permission gate, so
  the approval preview, the write and its before state hold real values. One placeholder per value
  per run (`⟨email 3⟩`), so the model can still tell that two things are the same.
- The placeholder map lives with the run, encrypted with the client's key, never in a log, step
  output or `model_call` body. `model_call` keeps the masked request: the log shows what the model
  saw.
- Names stay. Agents can't match vendors or write a polite email without them, and masking them
  breaks more than it protects.

The limit we must say plainly: **documents are read by the model as PDFs and images**
(`packages/documents/src/extract.ts`). Text masking can't reach inside them. Either keep that out
of the claim, or add an OCR step before the model, which is a new vendor or a new component (owner).

Then: "Bank and card numbers, tax IDs and your contacts' emails and phone numbers are replaced
before an AI model sees the records and messages agents work with." Not "sensitive identifiers
never reach an AI model", while documents are read whole.

### 3.4 The data receipt (14) · medium · needs the owner's yes · after 3.2 and 3.3

A "What this run used" panel on the portal's run page, built from rows we already keep:
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
clients it serves, every read is in the audit log, stepping into an item takes a reason, and the
client admin can already download that log, where our reads show as "Mezonas"
(`GET /api/audit/export.csv`).

- Show it on a portal page, not only as a CSV (this is `docs/hipaa-plan.md` T3, which still says
  clients can't see their log; the export exists, so that row needs updating).
- Optional, later: a weekly line in the client's report, "Mezonas opened 4 items this week".

Then: "Even our team can't open your data without a record, and you can see that record."

### 3.6 Exit and the small fixes (16, 12, 3) · small to medium

- **Self-serve export:** the full export (`apps/api/src/exports/client-data.ts`) starts only from
  the back office. Add a portal route for the client admin, with the same job and audit.
- **Deletion on time:** the privacy policy promises deletion within 30 days. Today files go at
  day 30 and rows only when the owner runs `db:purge-client`, so rows can outlive the promise.
  Show "purge due" with its date on the back office's overview from day 23, keep a person running
  it, or move the file purge earlier so both finish by day 30.
- **Vendor deletion** (`docs/hipaa-plan.md` T5): close the Twilio subaccount and delete ElevenLabs
  conversations through their APIs on retirement, instead of by hand.
- **No pay verbs:** a contract test over every connector manifest that fails on a verb or tool
  that pays, transfers or refunds.
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
   ask Anthropic about zero retention; lawyer on the DPA.
2. Code, small: §3.2 (migration PR, then the code), §3.5, §3.6.
3. Owner decides on masking and the receipt; ARCHITECTURE v0.16 and a milestone each.
4. Code, larger: §3.3, then §3.4.
5. As each lands: add its claim to `docs/marketing/claims.md` and `fixtures/marketing/mezonas-claims.json`,
   with its reason, and update the privacy policy where it changes (§6 for retention, §8 for
   masking).

Leading the messaging: item 5 is ready now; 13 after §3.2; 6 and 14 only after §3.3 and §3.4.
Until then, lead with 5, 11, 12 and the audit log.

## 6. Decisions for the owner

- [ ] Ask Anthropic for zero data retention, and whether OpenAI stays in the claim.
- [ ] The plan the Ops MCP connector runs under, or keep it off client data.
- [ ] Masking (§3.3) into scope, and whether documents stay out of the claim or get an OCR step.
- [ ] The data receipt (§3.4) into scope.
- [ ] Deletion timing (§3.6): earlier file purge, or a reminder for the owner's purge.
- [ ] The DPA with counsel; when to start SOC 2.
