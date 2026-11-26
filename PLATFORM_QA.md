# Platform QA (2026-11-20)

> **Status (2026-11-26): Done.** All 49 findings fixed; parts of §5's map describe v3/v4 workflows since deleted. Code cites its ids.

A hostile QA pass on Mezonas outside the Agent Builder, weighted toward tools, connectors and skills. The report came first, with nothing fixed; the fixes followed (see Fix status). The Builder (audited in `BUILDER_QA.md`) was left alone.

**Result: 49 defects survived verification, out of 57 reported.**

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 14 |
| Low | 33 |

How the 57 were handled:
- **Reported:** eight lenses each reported findings, and each finding came with a failing repro.
  - Flow: 9. State: 8. AI: 7. Input: 9. Integration: 6. Consistency: 4. Security: 9. Tools contract: 5.
- **Verified:** a separate verifier then tried to disprove each one.
  - It disproved 2 (AI-2, FLOW-3).
  - It found 5 by design (SEC-2, SEC-4, SEC-6, STATE-5, TOOL-4).
  - It merged 1 duplicate (FLOW-9 into INPUT-5).
  - It lowered 30 severities.
- **Repros:** every surviving finding had a test that failed at the time of the audit. That was 67 tests: 56 API and 11 web.

**Where it ran.**
- Everything ran locally, against a throwaway Postgres 16 (pgvector), using the repo's own API harness.
- Connectors ran on their own fakes, with injected `fetch` or the testkit connector. Models ran on a scripted `FakeModel`, or on a fake `fetch` for the OpenAI and Gemini transports.
- No test touched staging, production, a live model, a live provider or real client data. Staging wasn't used at all, not even for reads.
- STATE-6 is a race and failed in 2 of 3 runs alone; every other repro fails every time.

## Fix status (2026-11-20)

All 49 are fixed, in seven PRs. Each PR brings its repros in as regular tests titled "(PLATFORM_QA ID) …",
so CI runs them. The decisions they made are in `docs/plan.md` §1.157. The repro folders that were
first in this PR (`apps/*/src/qa-platform`, with their `vitest.qa.config.ts`) are gone: their tests now
live in the fix PRs.

| PR | What it fixes |
|---|---|
| #451 Approvals stay on across lineage, and a held agent doesn't answer calls | CONS-3, TOOL-1, TOOL-2, STATE-7 |
| #455 Proven senders only, no card numbers kept, Sloan within the portal's limits, provider answers checked | SEC-1, SEC-3, SEC-5, SEC-7, SEC-8, SEC-9, INPUT-6, AI-4 |
| #453 Runs ask and notify once, a reject holds, schemas fail closed, web.fetch stays in scope | STATE-1, STATE-2, STATE-3, STATE-8, CONS-1, CONS-2, AI-3, AI-7 |
| #454 Connector writes run once and a refusal isn't "maybe sent"; OAuth errors in our words | TOOL-3, STATE-4, INTEG-4, INTEG-5, INTEG-6, FLOW-1 |
| #456 Browser sign-in survives code-service trouble, each code reaches its own login | INTEG-1, INTEG-2, INTEG-3, INPUT-9, FLOW-6 (server half), STATE-6 |
| #452 Pack tools keep test runs out of live data, hard rules hold at save, money stays in one currency | TOOL-5, AI-1, AI-5, AI-6, INPUT-1, INPUT-2, INPUT-3, INPUT-4, INPUT-7, INPUT-8 |
| #450 The screens keep what people typed and say what failed | INPUT-5, FLOW-2, CONS-4, FLOW-4, FLOW-5, FLOW-6 (web half), FLOW-7, FLOW-8 |

Two fixes took a different path from the fix direction in the table below, and their tests changed with them:
- CONS-1: the validators now refuse a skill step that names another agent (`step_agent_unsupported`), instead
  of the executor running it as that agent.
- AI-3: a skill whose schema Zod can't read now fails the step, instead of re-asking the model.

The five findings judged by design were fixed afterwards at the owner's request: SEC-2 (#460, migration 0068), SEC-6 (#470, migration 0071), SEC-4 (#468), and STATE-5 and TOOL-4 (#469). #467 passes a statement's currency into reconciliation (the gap #452 left). Two flaky tests found on the way were fixed too (#465, #466).

#450 also raised the web first-load budget to 495 kB, recorded as a DECISION in `scripts/web-size.mjs`.

## 1. Top 5: what would hurt a real client first

1. **CONS-3 (high): an agent on a safety hold keeps answering the client's phone line on its own.**
   - The voice path has its own copy of the gate (`apps/api/src/calls/answer.ts:343-353`), and that copy never reads the hold.
   - So after a critical issue holds an agent, a ringing call is still handed to a new ElevenLabs voice agent, which talks to the client's customer.
   - Plan §1.124.1 says every external write waits for a person while the agent is held. The runtime's gate (`call-tool.ts:448-455`) and `planned.ts` honour this; the call path doesn't.
2. **SEC-1 (high): anyone can email support@ as a client admin and be trusted as them.**
   - `senders()` counts the envelope sender with no SPF or DMARC check (`apps/api/src/backoffice/inbound-email.ts:75-81`).
   - A spoofed mail becomes an issue raised as that person, a message posted as them, and attachments stored as that client's documents.
   - Every other mail path (forwarding, reach-out replies, Sloan, release codes) uses `authenticatedSenders`.
3. **TOOL-1 (medium): promoting or copying a client agent carries that client's loosened approvals.**
   - What it carries: `mode: act` and `approval: not_required` steps, into the template or into another client.
   - `stripForPromotion` (`packages/agents/src/registry/lineage.ts:607-691`, also used by `copyClientAgent`) never resets them.
   - Every later fork of that template starts with approval off. Trial and sign-off still sign every write; after go-live, only the new client's matrix stands between the agent and a write.
   - This breaks invariant 8 ("pack templates start with approval on") and plan "approval stays on" (`docs/plan.md:5515`).
4. **TOOL-5 (medium): a test run on the bench changes the client's live purchasing data.**
   - It moves the preferred vendor, discontinues and renames vendor items, and adds catalog items.
   - The four materials tools behind this never read `ctx.mode`; their sibling tools do. Invariant 8: test runs never write.
5. **INPUT-6 (medium): one empty or mistyped attachment loses a vendor's whole email to an agent's address.**
   - `receiveAgentEmail` (`apps/api/src/triggers/inbound-email.ts:214-226`) throws on the empty part, so the invoice is never stored and no run starts.
   - It also keeps a file whose bytes aren't its type.
   - Forwarded mail skips a bad part and keeps the rest.

Close behind:
- **INTEG-1:** a code-service outage counts as failed sign-ins, and two of them stop every client's website login.
- **SEC-9:** card numbers are stored verbatim in `tool_call` and `external_action`.
- **AI-5 / AI-6:** a model offered the materials record tools can record a match the hard rules veto, or claim a person decided it.

## 2. Findings

Sorted by severity. Within each severity, tools, connectors, skills and the runtime come first. "Lens" is the attack lens that found the finding. The repro column names the audit's repro file (in `apps/api/src/qa-platform/` or `apps/web/src/qa-platform/`, as first pushed in this PR) and the test, whose title starts with the ID. The fix PRs carry each one as a regular test. "Inv." is the CLAUDE.md invariant broken; R1–R4 and I-numbers are the concrete invariants in section 5.0.

| ID | Lens | Sev. | File:line | Trigger | Observed vs expected | Repro | Fix direction |
|---|---|---|---|---|---|---|---|
| CONS-3 | Consistency | high | `apps/api/src/calls/answer.ts:343-353` | A client agent answers calls (create auto, step not_required, act, live). A critical issue then puts it on a safety hold. | **Observed:** the preview says `agent`; the call is handed to a new ElevenLabs voice agent. **Expected:** voicemail or forward, no voice agent. Inv. 8 (I8.5), plan §1.124.1. | `cons-calls.qa.ts` "CONS-3: an agent on a safety hold doesn't answer a ringing call on its own" | Read `readHold(agent.hold)` in `answeringStep` and add the `approval` ceiling. Better: one shared gate-inputs helper with `call-tool.ts`. |
| SEC-1 | Security | high | `apps/api/src/backoffice/inbound-email.ts:75-81`, used at `:346-365` | Mail to support@ whose envelope `MAIL FROM` is a client admin, with no SPF or DMARC pass. | **Observed:** an issue `raisedBy` A's admin, a message posted as them, attachments kept as A's documents. **Expected:** unproven senders don't count and become a "Sort this" to-do. Inv. 1, 9. | `sec-isolation.qa.ts` "SEC-1: an unauthenticated email to support@ claiming a client admin is not filed as them" | Use `authenticatedSenders({envelopeFrom, from, auth})`. The fixture `backoffice-client.eml` needs an auth header. |
| TOOL-1 | Tools | medium | `packages/agents/src/registry/lineage.ts:607-691`; `registry/agents.ts:884` | The operator loosens client A's agent (`mode: act`, a write step `not_required`). Then Promote with every change, or copy A's agent into client B. | **Observed:** the template draft or B's copy has `mode: act` and `not_required`. **Expected:** approval back on (`plan.md:5515`). Inv. 8, 11. | `tool-lineage.qa.ts` "TOOL-1: a promotion never carries…" and "TOOL-1: copying client A's agent into client B never carries…" | In `stripForPromotion`, reset `permissions.mode` and each step's `approval.required` to the base's values (or the safe default). |
| TOOL-3 | Tools | medium | `packages/connectors/src/odoo/records.ts:199-218` (`PROTECTED_FIELDS`); `odoo/index.ts:287-317` | `odoo.record.update {model:"res.partner", id, values:{active:false}}` with the default matrix (delete off). | **Observed:** the customer is archived (Odoo's soft delete) under `update`. **Expected:** refused like `state`. QBO's equivalent change is always signed. Inv. 8 (delete off). | `tool-delete-like.qa.ts` "TOOL-3: odoo.record.update refuses to archive a record (active: false) with delete off" | Add `active` to `PROTECTED_FIELDS`. An archive, if wanted, gets its own always-signed tool. |
| TOOL-5 | Tools | medium | `packs/materials/src/vendor/tools.ts:541-583, :746-768, :772-788`; `packs/materials/src/tools.ts:204-232` | A test run calls `vendor_item.upsert`, `set_preferred`, `discontinue` or `catalog.create_item`. | **Observed:** the live preferred vendor moves, a live item is discontinued or renamed, a catalog item is added. **Expected:** nothing kept, as the sibling tools do. Inv. 8 (I8.3). | `tool-test-runs.qa.ts`, four "TOOL-5: a test run's …" tests | When `ctx.mode === "test"`, return what would be done without writing, or roll back as `contract.save` does. |
| AI-5 | AI | medium | `packs/materials/src/catalog/split-store.ts:205-235` → `catalog/match.ts:367-420` | `materials.matches.record` gets a model's "matched" without the Check matches step, e.g. offered to an agent-mode skill via `extraTools` (`VENDOR_INVOICE_WRITES`, `vendor/patterns.ts:296-301`). | **Observed:** a 1/2" line is recorded as matched to the 3/4" item, and an alias is learned, so future 1/2" lines auto-match. **Expected:** vetoed to `unsure`, no alias. Inv. 7 (I7.2). | `ai-pack-decisions.qa.ts` "AI-5: matches.record never records a match the hard rules veto (a 1/2in line to a 3/4in item)" | Re-run `scorePair` against the item before recording a match or learning an alias. Do the same in `vendor_items.register`. |
| AI-6 | AI | medium | `packs/materials/src/vendor/tools.ts:404-405, :429-430` → `vendor/pipeline.ts:899-925` | A model offered `vendor_items.register` calls it with `answers` plus `decidedBy: <any member id>`. | **Observed:** an `item_match` with method `human`, confidence 1, `decided_by` the admin, no agent version, in a run where no person answered. **Expected:** refused, or recorded as the agent's. Inv. 9, 10. | `ai-pack-decisions.qa.ts` "AI-6: vendor_items.register doesn't record a model's answer as a person's decision" | Take the answer and `by` from the resolved person step or inbox item, not from tool input. |
| INPUT-8 | Input | medium | `packages/agents/src/tools/group-list.ts:116-122, :179` | `data.list.group` over amounts written "1,250.00" (Google Sheets returns formatted values). | **Observed:** the total is 75; the 1,250.00 counts as 0, silently, and fails the keep rules. **Expected:** 1325, or a refusal naming the value. Inv. 5, 6. | `input-group-list.qa.ts` "INPUT-8: an amount written with a thousands separator is not totalled as zero" | Accept grouped decimals, or return the unreadable values instead of adding 0. |
| INTEG-1 | Integration | medium | `packages/connectors/src/browser/session.ts:306-320`; `browser/sign-in.ts:156-180` | The code service (`apps/mfa`) is down, answers `daily_cap`, or one `claim` RPC fails. | **Observed:** each counts as a failed sign-in; two stop the browser connection (`error`, "2 failed sign-ins: code service: daily_cap"). **Expected:** retryable, never counted. R2, plan §1.26. | `integ-browser.qa.ts`, three "INTEG-1: …" tests | Map `CodesServiceError` and RPC errors to a retryable error that doesn't count. Retry `claim` inside the poll. |
| INTEG-2 | Integration | medium | `packages/connectors/src/browser/sign-in.ts:153, :204`; `browser/index.ts:140`; `apps/mfa/src/identity.ts:465ff` | A sign-in gets no code in its 90 s poll; the step retries. | **Observed:** the dead 180 s wait takes the new code (`481516`), the retry fails, and two failures stop the connection. **Expected:** the retry claims its own code. I13.2. | `integ-browser.qa.ts` "INTEG-2: a timed-out sign-in's open wait does not take the next sign-in's code" | Add `cancelWait` to the codes port and call it on failure, or match the wait's lifetime to the poll. |
| SEC-5 | Security | medium | `apps/api/src/routes/ops-clients.ts:948-951` (`set.config = body.config`, `z.record(z.unknown())`) | `PATCH /api/ops/connections/:id {config:{site:"operator-site", …}}` on a client's browser connection. | **Observed:** config replaced whole. `site` now names another site, and the client's `stricter` settings are gone, so the vault login would be typed on the new site's origins. **Expected:** 422, or validated per connector. Inv. 13, 8. | `sec-isolation.qa.ts` "SEC-5: the operator can't repoint a client's browser login at another site through config" | Validate `config` per connector. Refuse changes to `site`, `siteVersionId`, `identity` and `stricter` here. |
| SEC-9 | Security | medium | `packages/agents/src/log/run-log.ts:236-265`; `log/external-actions.ts:147-159` | A run reads a record holding a card number and writes an input holding one (`executeRun`, testkit). | **Observed:** `tool_call.input/output` and `external_action.input/before/result` hold `4111 1111 1111 1111`; `model_call` is redacted. **Expected:** no stored row holds a card number. Inv. 14. | `sec-cards.qa.ts` "SEC-9: a run stores no card number in tool_call or external_action" | Apply `redactCardNumbersDeep` in the run-log and action writers. Refuse card numbers at tool input, or redact after execution. |
| STATE-7 | State | medium | `packages/agents/src/registry/agents.ts:546-568`; `apps/api/src/routes/ops-agents.ts:306` | Tab 1 holds draft v2. Tab 2 saves v3 and publishes it. Tab 1 then publishes v2. | **Observed:** v2 goes live and v3 is retired; v3's changes are lost silently. **Expected:** 409, as `createVersion` and template installs refuse (§1.124). Inv. 3, 4 in spirit. | `state-versions.qa.ts` "STATE-7: publishing a draft older than the live version is refused…" | In `publish`, refuse a draft numbered below the live version; send the operator to rollback. |
| INPUT-6 | Input | medium | `apps/api/src/triggers/inbound-email.ts:214-226` (also `account/reach.ts:319`) | Vendor mail to an agent address with an invoice PDF plus an empty `remittance.pdf`, or an HTML page named `.pdf`. | **Observed:** `DocumentError: the file is empty` loses the whole message, so no run starts; the fake PDF is stored. **Expected:** skip the bad part and keep the rest, as forwarding does. Inv. 5. | `input-agent-email.qa.ts`, two "INPUT-6: …" tests | Share forwarding's per-attachment filter (`bytesMatchType`, catch `DocumentError` into `skipped`) across every mail entry point. |
| SEC-3 | Security | medium | `apps/api/src/routes/threads.ts:516-540` → `packages/threads/src/post.ts:56-63` | `POST /api/threads/:id/messages {text:"… card 4111 1111 1111 1111 …"}`. | **Observed:** the full number is stored. **Expected:** `[card ending 1111]`, as SMS, email and extraction store it (`plan.md:928`). Inv. 14. | `sec-isolation.qa.ts` "SEC-3: a card number posted in the portal chat is not stored" | Call `redactCardNumbers` in `postMessage` and `postAsPerson` (covers portal, ops, Sloan and issues). |
| SEC-8 | Security | medium | `apps/api/src/account/views.ts:72-100`; `packages/agents/src/log/account-port.ts:146-200`; `account/reach.ts:73-93` | A client user limited to agent "Invoices" emails or texts Sloan; Sloan lists runs. | **Observed:** the "Payroll" agent's run is listed; the portal answers 404 for it. **Expected:** Sloan sees only what the portal shows this person. Inv. 11. | `sec-sloan.qa.ts` "SEC-8: Sloan shows a limited client user only their agents' runs, as the portal does" | Carry `agentIds` on `AccountAsker` and filter every account view, or refuse Sloan to limited users. |
| TOOL-2 | Tools | low | `apps/api/src/routes/ops-agents.ts:177-181`; `packages/agents/src/registry/agents.ts:752-775` | `POST /api/ops/templates/:X/fork {versionId}` with a draft of X, or a version of template Y. | **Observed:** 200; a client agent made from an unreviewed draft, or from another template. **Expected:** 409. Inv. 11. | `tool-lineage.qa.ts`, two "TOOL-2: …" tests | In `fork`, require `tv.agentId === templateId` and a published version. |
| STATE-4 | State | low | `packages/connectors/src/zoho_crm/index.ts:666-689` (also note `:753`, task `:784`) | Zoho create; the Worker stops after the POST; after the 25-minute lease the action is taken over with the same key. | **Observed:** two `POST /Leads`. **Expected:** at most once (Slack, Gmail, Teams and LinkedIn record attempts). Inv. 8 (I8.1); the DECISION at `:681` is overridden by the invariant. | `state-connectors.qa.ts` "STATE-4: a Zoho CRM create taken over…" | Use `attemptServices(ctx)`: return the recorded result or throw `UnconfirmedWriteError`. |
| INTEG-4 | Integration | low | `packages/connectors/src/linkedin/index.ts:455-494` | Expired token; LinkedIn's token endpoint answers 503; the run retries. | **Observed:** the retry gets `UnconfirmedWriteError: …may have gone out` though nothing was posted. **Expected:** the retry posts. R2, I8.4. | `integ-connectors.qa.ts` "INTEG-4: a retry under the same key posts…" | Get the access token before `attempts.start`, as Gmail does, and mark the attempt refused on not-written errors. |
| INTEG-5 | Integration | low | `packages/connectors/src/gchat/index.ts:268-283, :360-383` | Google Chat answers 429 on `messages.create`. | **Observed:** `failed`, with no `notWritten`, so it reads as "may have posted" and the run can't continue. **Expected:** `notWritten`, or retried after the backoff. R2. | `integ-connectors.qa.ts` "INTEG-5: …" | Mark 4xx (429, 403, 404) `notWritten` and honour Retry-After. LinkedIn and HubSpot 4xx look the same on reading. |
| INTEG-6 | Integration | low | `packages/connectors/src/twilio/index.ts:872-895` (reconcile `:700-745`); `whatsapp_meta/index.ts:326-347` (`:212-235`) | Twilio 429 (20429) or Meta 130429 on a send, then the run's retry under the same key. | **Observed:** `UnconfirmedWriteError: … may have been sent`; the text never goes, and a false review item reaches the operator. **Expected:** sent once the limit passes. R2, I8.4. | `integ-connectors.qa.ts`, two "INTEG-6: …" tests | Record a refusal on 4xx (`refuseAttempt`, as Gmail does) and mark those errors `notWritten`. |
| INTEG-3 | Integration | low | `apps/mfa/src/index.ts:62-99` | The same signed Twilio SMS webhook POSTed twice. | **Observed:** `receive` runs twice; an old code can fill a new wait. **Expected:** once per `MessageSid`. I13.2. | `integ-mfa.qa.ts` "INTEG-3: a replayed signed text (same MessageSid) reaches the identity only once" | Keep the `MessageSid`s seen in the Identity DO for the message lifetime. |
| INPUT-7 | Input | low | `packages/agents/src/tools/group-list.ts:116-122, :183, :190` | One group holding 400 USD and 400 CAD, with `minTotal` 500. | **Observed:** total "800", which passes the minimum. **Expected:** refused, or totalled per currency. Inv. 6. Low because QBO customers and vendors are single-currency. | `input-group-list.qa.ts` "INPUT-7: never totals two currencies into one figure" | Key totals by currency, or refuse mixed currencies in a group. |
| INPUT-9 | Input | low | `packages/connectors/src/browser/session.ts:146-151, :304, :341` | A portal sets a preference cookie "Delivered", or sends a 4-digit code "2026". | **Observed:** page data becomes "[hidden]" ("Statement [hidden]-10 … due [hidden]-11-30"). **Expected:** only real secrets hidden. Fails safe. Inv. 5. | `input-browser-redact.qa.ts`, two "INPUT-9: …" tests | Redact only session and auth cookies; drop a spent code; match whole tokens. |
| INPUT-1 | Input | low | `packs/bookkeeping/src/reconcile/store.ts:165, :348` | `bookkeeping.reconcile` with a records side holding a USD and a CAD transaction, against a statement of 200. | **Observed:** `explained`, closing 200.0000, recorded. **Expected:** refused. Low: the shipped flows use one account per side. Inv. 6. | `input-reconcile.qa.ts` "INPUT-1: refuses to sum a USD and a CAD bank transaction into one side" | Give every side a currency and refuse a mixed side or two sides that differ. |
| INPUT-2 | Input | low | `packs/bookkeeping/src/reconcile/store.ts:141, :348` | Side A is a statement given by a step; side B is CAD transactions. | **Observed:** the reconciliation is stored as USD ("Statement $60.00, CAD account $60.00"). **Expected:** CAD, or refused. Inv. 6. | `input-reconcile.qa.ts` "INPUT-2: …" | The given side takes a currency; the stored currency comes from both sides once checked. |
| INPUT-3 | Input | low | `packs/bookkeeping/src/reconcile/store.ts:878-884`; `reconcile/tools.ts:62` | A Los Angeles client runs the monthly reconcile by hand at 17:00 on Nov 30. | **Observed:** the period is November (still open). **Expected:** October. Same pattern in materials `purchasing/tools.ts:50`. | `input-reconcile.qa.ts` "INPUT-3: …" | Use the client's day (`isoToday(at, tenant.timezone)`), as `clientDay` does. |
| INPUT-4 | Input | low | `packs/bookkeeping/src/reconcile/store.ts:30`; `reconcile/api.ts:47` | A closing of `123456789012.00` (12 digits; the schema allows it, `numeric(14,4)` doesn't). | **Observed:** a DB overflow (a 500 through a route). **Expected:** a plain refusal. Inv. 5. | `input-reconcile.qa.ts` "INPUT-4: …" | Use core's `DecimalString`; check the difference fits; optionally map 22003 to 400. |
| AI-1 | AI | low | `packs/materials/src/catalog/model.ts:59, :118-122` | An invoice line or catalog name containing `</line>` or `</candidates>`. | **Observed:** the tag closes early, and the text after it reads as instructions. **Expected:** escaped. The answer is held to a schema and the veto runs after. Inv. 9. | `ai-robustness.qa.ts`, two "AI-1: …" tests | Use `promptText(line.raw)` and `promptJson` for the candidates and attributes. |
| AI-3 | AI | low | `packages/agents/src/runtime/json-schema.ts:15-20`; `run-agent.ts:368, :510`; `oversee.ts:636` | An operator skill whose output schema uses `unevaluatedProperties`, `if/then`, `dependentRequired` or a `definitions` `$ref`. | **Observed:** the schema compiles to `z.unknown()`, so `total: 12` is accepted where "12.00" is required. **Expected:** refused and re-asked. Inv. 5 (overrides the DECISION at `:12`). | `ai-robustness.qa.ts` "AI-3: …" | Fail closed: refuse an unreadable schema when the skill is saved, and fail the check at run time. |
| AI-4 | AI | low | `packages/llm/src/openai.ts:393-460` (`:440`); `gemini.ts:334-410` (`:384`) | A provider answers 200 with `{}`, with no `usage`, or with a nameless function call. | **Observed:** an empty turn at 0 tokens and $0, or `name: undefined`. **Expected:** a typed provider error, as Anthropic's `parseMessage` gives. Inv. 5, R3. | `ai-robustness.qa.ts`, four "AI-4: …" tests | Zod-check each provider's response before translating it; treat missing usage as an error. |
| AI-7 | AI | low | `packages/agents/src/tools/web.ts:185-215, :401-418` | An injected document leads the model to `web.fetch` a link it built with client data in the query, in a test run too. | **Observed:** the request goes out. **Expected:** only links the step was given are fetched, and nothing in test runs. Latent: `MARKETING_RESEARCH` is off everywhere. Inv. 9, I8.3. | `ai-robustness.qa.ts` "AI-7: …" | Track the links the step has seen; refuse others and anything in a test run. |
| CONS-1 | Consistency | low | `packages/core/src/process/validate.ts:1306-1312`; `apps/api/src/runs/ports.ts:321`; `run-agent.ts:483-485` | A skill step with `agent: "helper"` (commandable) whose skill the owner doesn't list. | **Observed:** valid and publishable, but it fails "agent clerk has no skill …", or runs as the owner. **Expected:** it runs as the helper, or the validator refuses `agent`. Inv. 4 (I4.2). | `cons-skill-agent.qa.ts` "CONS-1: …" | Resolve `step.agent` to its live version in `runSkill`, or refuse `agent` in the validator. |
| CONS-2 | Consistency | low | `packages/core/src/schemas/common.ts:19`; `packages/workflows/src/executor.ts:3312, :3338` | A repeat whose inner step id is `until` (or `wait`). | **Observed:** the verdict replays the inner step's stored result, so the repeat runs to `maxTimes` and fails, repeating any write. **Expected:** one pass. Inv. 4. | `cons-workflows.qa.ts` "CONS-2: …" | Reserve those ids in the validator, or namespace the repeat's own names. |
| STATE-2 | State | low | `packages/workflows/src/executor.ts:4118-4123`, from `:1961` | `any` mode: Ben rejects (his event wakes the run), then Amy approves before the round reads the inbox. | **Observed:** Amy's yes wins and the write runs. **Expected:** the first answer in time (ARCHITECTURE), or a reject wins in one round. I8.8. | `state-workflows.qa.ts` "STATE-2: …" | Order answers by `resolved_at`, or let any reject decide a round. |
| STATE-3 | State | low | `packages/workflows/src/executor.ts:2388-2468`; `apps/api/src/runs/ports.ts:851-875` | A notify step whose `log.update` fails after the notice went out; the engine retries. | **Observed:** two notices. **Expected:** one. R1. | `state-workflows.qa.ts` "STATE-3: …" | Key the posted message by (run, node), or move the send into its own durable step. |
| STATE-8 | State | low | `packages/workflows/src/executor.ts:1656`; `packages/agents/src/runtime/call-tool.ts:334-411` | A skill step runs `inbox.create`; the engine retries the step (timeout or eviction). | **Observed:** two identical inbox asks to the client. **Expected:** one. R1. | `state-retry.qa.ts` "STATE-8: …" | Key internal writes by (run, step, call index), as external ones are. |
| STATE-1 | State | low | `apps/api/src/runs/dispatch.ts:112-125`, caught at `:488` | Two cron passes start the same schedule tick. | **Observed:** `duplicate key … run_pkey` aborts that client's cron pass for the minute (redelivery, reach, alerts). **Expected:** "already started". R4. | `state-dispatch.qa.ts` "STATE-1: …" | Insert with `onConflictDoNothing` and read "nothing inserted" as not created. |
| FLOW-6 | Flow | low | `apps/mfa/src/service.ts:131-133`; `apps/api/src/routes/browser.ts:44-52`; `apps/web/src/accounts/vault.tsx:466` | A website login set-up on an SMS-code site, when Twilio refuses to sell a number. | **Observed:** "Twilio: The requested resource /2010-04-01/Accounts/AC…/IncomingPhoneNumbers.json was not found" in the client's vault card. **Expected:** our own words. | `flow-browser.qa.ts` "FLOW-6: …"; `flow-portal.qa.tsx` "FLOW-6: …" | `codesError` gives fixed words per code and logs the detail. |
| STATE-6 | State | low | `apps/api/src/routes/browser.ts:152-206` | Two concurrent `POST /api/access/browser {site}` (two tabs or two admins; the button itself is guarded). | **Observed:** both 200: two connections and two code identities (a billed number each on SMS sites). A failed set-up also leaves its identity behind. **Expected:** 200 and 409, with no orphan. | `state-browser.qa.ts` "STATE-6: …" (a race; failed 2 of 3 runs) | Partial unique index on (tenant, connector, site), or an advisory lock; remove the identity when the insert fails. |
| SEC-7 | Security | low | `apps/desktop/src/main/guard.ts:85-86` | A "new file" job through a symlink inside the granted folder. | **Observed:** the job is refused, but `Private/made-by-mezonas/` is created outside the grant. **Expected:** no change outside the grant. Not reachable until the desktop API exists. Inv. 13. | `sec-desktop.qa.ts` "SEC-7: …" | `realpath` the deepest existing ancestor, check it is inside, then make each level, checking it with `lstat`. |
| FLOW-1 | Flow | low | `packages/connectors/src/oauth/flow.ts:138-140, :152`; `apps/api/src/routes/connections.ts:514-516`; `OAuthCallback.tsx:61` | `/connections/zoho_crm/callback?error=Your account is suspended. Call 555-0100…` (no state needed), or Deny at the provider. | **Observed:** "the provider refused: Your account is suspended…" or "…: access_denied" on our page. **Expected:** our own plain words. I13.1. | `flow-oauth.qa.ts`, two "FLOW-1: …" tests | Map provider errors and state failures to fixed sentences; never echo `params.error`. |
| INPUT-5 | Input | low | `apps/web/src/desk/DeskDetail.tsx:1053-1054` | Before signing, a person edits a number field to "1,200" or clears it. | **Observed:** `qty: null` or `qty: 0` is sent and then signed. **Expected:** 1200, or refused on the page; never 0 for a blank. The server re-checks the edit. I8.8, Inv. 6. | `input-desk-edit.qa.tsx`, two "INPUT-5: …" tests | Parse like `valueFromText`; refuse a blank or NaN; send decimal text. |
| FLOW-2 | Flow | low | `apps/web/src/portal/screens/GettingStarted.tsx:185-187, :694` | A new client types 340 bills and "$12,500" spend, then Save. | **Observed:** only the bills are sent, and the spend box is wiped. **Expected:** 12500, or the text kept with a note on the format. | `flow-start.qa.tsx` "FLOW-2: …" | Accept "$" and thousands separators; clear only the drafts that were sent. |
| FLOW-4 | Flow | low | `apps/web/src/portal/screens/Inbox.tsx:64, :93, :254` | `/inbox?view=later` while the snoozed list answers 500. | **Observed:** "Nothing waits on you right now.", with no alert. **Expected:** an error with retry. | `flow-desk.qa.tsx` "FLOW-4: …" | Show `later.error` and `done.error` as an `ErrorNotice` with `onRetry`. |
| FLOW-5 | Flow | low | `apps/web/src/desk/DeskDetail.tsx:213-251` | Undo on a batch of two where one call gets a passing 503, then press Undo again. | **Observed:** the card is stale, and the second press says "nothing to undo" forever. **Expected:** reload to what the API holds; retry only what's left. | `flow-desk.qa.tsx` "FLOW-5: …" | `Promise.allSettled`, apply what succeeded, then `reload()` and `onChanged()`. |
| FLOW-7 | Flow | low | `apps/web/src/portal/screens/Home.tsx:924-957` | The client admin presses Rename on an area owner. | **Observed:** no Cancel or Escape; the form closes only by saving or leaving. **Expected:** a Cancel. | `flow-portal.qa.tsx` "FLOW-7: …" | A ghost Cancel that resets editing, value and error. |
| FLOW-8 | Flow | low | `apps/web/src/portal/screens/Settings.tsx:421-422` | `GET /api/settings/my-notifications` answers 500. | **Observed:** the personal and team notification sections vanish, with no error. **Expected:** an error with retry. The hide-when-off DECISION stays. | `flow-portal.qa.tsx` "FLOW-8: …" | Render `<ErrorNotice onRetry>` when `mine.error` is set. |
| CONS-4 | Consistency | low | `GettingStarted.tsx:185`; `apps/web/src/ops/agents/PricePanel.tsx:24`; `ops/screens/Billing.tsx:313` vs `packages/core/src/money.ts:13`, `core/api/billing.ts:19` | Intake money "12345678901"; credits 999,999,999 or 500,000,000. | **Observed:** the form accepts them and the server rejects them. **Expected:** the form's rule is the server's. Inv. 5. | `cons-money.qa.tsx`, three "CONS-4: …" tests | Validate the forms with core's schemas instead of local regexes. |

## 3. Tools, connectors and skills contract table

Built by the tools lens from the real registry, `createPlatform({connectors: deploymentConnectors(nonProdEnv, false)})`, the same build as `platformFor`. It holds **263 tool rows and 142 skills**.

Results:
- Every tool passes Zod in and out.
- Every connector write goes through `external_action` with key `<run>:<step>:<i>` and a captured `before`.
- No tool has the `delete` verb, and delete is pinned `off` (`packages/connectors/src/permissions.ts:185`).

The fails:
- **Delete-like writes:** TOOL-3 (Odoo `active`). BILL's archive is BY DESIGN (TOOL-4).
- **Test runs:** the four materials tools of TOOL-5.
- **Tests:** tool wrappers that no test names, marked "FAIL (none direct)". Their underlying functions are often tested.

Dropped while building the table:
- Platform internal tools all honour test mode. `inbox.create` goes to the operator; `memory.write` is scoped to the run; `threads.post` refuses the client audience.
- The release gate firing in test runs is intended and tested (`release.test.ts:713`). It's worth an owner look against I8.3.
- An undo re-checks the matrix at `invoke.check()`.
- `setGrant(by:"client")` has one caller, and that caller checks first.

The registry holds 263 tool rows (connector alternate providers counted separately) and 142 skills.

How to read it:
- **Zod:** the handler has Zod input and output, and connector writes also have a Zod `beforeSchema`. All 263 pass.
- **Check 2:** connector writes go through `external_action` with key `<run>:<step>:<i>` and a captured `before`.
- **Check 3:** the platform default matrix (create and update `approval`, delete `off`) or stricter; "(always)" means `approval: always`.
- **Check 5:** binding, grant, tool subset and entity in `callTool`.
- **Check 6:** `ToolCallError` and connector errors, or failed/refused outcomes, for internal tools.
- **Internal tools** write platform or pack records only. The registry refuses `external` on pack and platform tools, so checks 2-5 are n/a for them.
- **Test (n):** the number of `*.test.ts` files that name the id, its alias constant or its exported tool constant. "FAIL (none direct)" means the tool wrapper is never exercised by name; its underlying function may be.

| Tool | Kind / sideEffect / verb | 1 Zod | 2 External via action+key+before | 3 Approval default | 4 Delete off | 5 Grants | 6 Typed errors | 7 Test (files) | Note |
|---|---|---|---|---|---|---|---|---|---|
| **platform** | | | | | | | | | |
| `inbox.create` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (6) | Test run: item goes to the operator (DECISION) |
| `threads.post` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (4) | Test run: never to the client (checked) |
| `threads.read` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `memory.write` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (8) | Test run: scoped to the run (DECISION) |
| `docs.get` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (8) |  |
| `docs.read` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (15) |  |
| `docs.extract` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (37) |  |
| `docs.find_support` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `docs.qbo_bills` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `docs.match_bill` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `docs.record_purchase` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `docs.plan_bill` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `docs.bill_lines` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `docs.totals.check` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `docs.reading.record` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `docs.bill.check` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `knowledge.search` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (5) |  |
| `knowledge.voice_samples` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `manual.read` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `directory.search` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `directory.get` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `directory.suggest` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `ledger.accounts.list` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `ledger.dimensions.list` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `comms.reach_out` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `comms.converse` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (10) |  |
| `forms.request` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `health.runs` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `health.connections` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `health.inbox` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `health.agents` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `agents.ask` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `supervisor.report` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `supervisor.check` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `account.services` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `account.runs` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `account.run` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `account.waiting` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `account.explain_wait` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `account.pause_agent` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (5) | Test run answers test_run |
| `account.resume_agent` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (2) | Test run answers test_run |
| `account.draft_change` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (5) |  |
| `account.pass_to_lead` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `account.pass_to_agent` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `account.help` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `account.history` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `account.ideas` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `account.owner` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `account.reply_as` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `inbound.get` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `comms.translate` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (5) |  |
| `web.search` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (14) |  |
| `web.fetch` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (7) | Any URL, allowed in tests (read) |
| `data.reshape` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (7) |  |
| `data.list.group` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| **qbo** | | | | | | | | | |
| `qbo.purchase.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `qbo.bill.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (17) |  |
| `qbo.vendor.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (3) |  |
| `qbo.item.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `qbo.attachable.list` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `qbo.bill.update_lines` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (20) |  |
| `qbo.purchase.update_lines` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (2) |  |
| `qbo.bill.update_memo` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (4) |  |
| `qbo.purchase.update_memo` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `qbo.item.update_purchase_cost` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (2) |  |
| `qbo.attachable.upload` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (11) |  |
| `qbo.invoice.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `qbo.customer.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (3) |  |
| `qbo.payment.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `qbo.aging_report` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (3) |  |
| `qbo.invoice.add_note` | connector / external / update, undo none | pass | pass | pass | pass | pass | pass | pass (4) |  |
| `qbo.bill.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (23) |  |
| `qbo.account.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `qbo.class.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `qbo.vendor.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (5) |  |
| `qbo.purchaseorder.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (4) |  |
| `qbo.purchaseorder.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `qbo.purchase.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (3) |  |
| `qbo.deposit.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (2) |  |
| `qbo.transfer.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (3) |  |
| `qbo.account.create` | connector / external / create, undo reverse | pass | pass | pass (always) | pass | pass | pass | pass (3) |  |
| `qbo.account.update` | connector / external / update, undo restore | pass | pass | pass (always) | pass | pass | pass | pass (4) | `active:false` deactivates; always signed (DECISION) |
| `qbo.class.create` | connector / external / create, undo reverse | pass | pass | pass (always) | pass | pass | pass | pass (3) |  |
| `qbo.class.update` | connector / external / update, undo restore | pass | pass | pass (always) | pass | pass | pass | pass (2) | `active:false` deactivates; always signed (DECISION) |
| `qbo.location.create` | connector / external / create, undo reverse | pass | pass | pass (always) | pass | pass | pass | pass (3) |  |
| `qbo.location.update` | connector / external / update, undo restore | pass | pass | pass (always) | pass | pass | pass | pass (2) | `active:false` deactivates; always signed (DECISION) |
| `qbo.account.register` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (3) |  |
| **webhook** | | | | | | | | | |
| `webhook.event.send` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (2) |  |
| **website** | | | | | | | | | |
| `website.publish` | connector / external / update, undo none | pass | pass | pass (always) | pass | pass | pass | pass (6) | `action: unpublish` deletes the R2 object; always signed (DECISION) |
| `website.meta` | connector / external / update, undo restore | pass | pass | pass (always) | pass | pass | pass | pass (5) |  |
| **zoho_crm** | | | | | | | | | |
| `zoho_crm.record.search` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `zoho_crm.record.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `zoho_crm.record.create` | connector / external / create, undo none | pass | partial | pass | pass | pass | pass | pass (2) | No provider idempotency key; a retry after a lost answer may duplicate (DECISION) |
| `zoho_crm.record.update` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (2) |  |
| `zoho_crm.note.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `zoho_crm.task.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| **podio** | | | | | | | | | |
| `podio.space.list` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `podio.app.list` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `podio.app.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `podio.item.filter` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `podio.item.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `podio.item.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `podio.item.update` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (2) |  |
| `podio.comment.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `podio.task.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| **twilio** | | | | | | | | | |
| `messages.search` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (3) |  |
| `message.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (4) |  |
| `sms.send` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (11) |  |
| `whatsapp.send` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (6) |  |
| `call.place` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (7) |  |
| `call.answer` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (3) |  |
| `call.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| **gmail** | | | | | | | | | |
| `gmail.send` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (14) |  |
| **gdrive** | | | | | | | | | |
| `drive.file.list` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `drive.file.upload` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (4) |  |
| **gsheets** | | | | | | | | | |
| `sheets.range.read` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `sheets.rows.append` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (2) |  |
| `sheets.range.update` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (3) |  |
| **outlook** | | | | | | | | | |
| `outlook.send` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (4) |  |
| **onedrive** | | | | | | | | | |
| `drive.file.list` (alt provider) | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `drive.file.upload` (alt provider) | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (4) |  |
| **excel** | | | | | | | | | |
| `excel.range.read` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `excel.rows.append` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (2) |  |
| `excel.range.update` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (1) |  |
| **outlook_calendar** | | | | | | | | | |
| `calendar.events.list` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `calendar.freebusy` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `calendar.event.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (4) |  |
| `calendar.event.update` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (2) |  |
| **gcal** | | | | | | | | | |
| `calendar.events.list` (alt provider) | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `calendar.freebusy` (alt provider) | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `calendar.event.create` (alt provider) | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (4) |  |
| `calendar.event.update` (alt provider) | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (2) |  |
| **teams** | | | | | | | | | |
| `teams.message.post` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (2) |  |
| **gchat** | | | | | | | | | |
| `gchat.message.post` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (2) |  |
| **slack** | | | | | | | | | |
| `slack.message.post` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (3) |  |
| **whatsapp_meta** | | | | | | | | | |
| `messages.search` (alt provider) | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (3) |  |
| `message.get` (alt provider) | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (4) |  |
| `whatsapp.send` (alt provider) | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (6) |  |
| **resend** | | | | | | | | | |
| `email.send` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (6) |  |
| **ramp** | | | | | | | | | |
| `ramp.transaction.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `ramp.user.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `ramp.receipt.upload` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| **hubspot** | | | | | | | | | |
| `hubspot.record.search` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `hubspot.record.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `hubspot.record.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) | Twin within 24h reported alreadyDone (DECISION) |
| `hubspot.record.update` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (2) |  |
| `hubspot.note.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (2) | Twin within 24h reported alreadyDone (DECISION) |
| `hubspot.task.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) | Twin within 24h reported alreadyDone (DECISION) |
| **bankfeed** | | | | | | | | | |
| `bankfeed.transaction.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `bankfeed.account.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| **browser** | | | | | | | | | |
| `browser.page.read` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (5) |  |
| `browser.file.download` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (4) |  |
| `browser.script.read` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `browser.script.submit` | connector / external / create, undo none | pass | pass | pass (always) | pass | pass | pass | pass (2) |  |
| **hackernews** | | | | | | | | | |
| `hackernews.search` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (3) |  |
| `hackernews.thread` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| **linkedin** | | | | | | | | | |
| `linkedin.post` | connector / external / create, undo none | pass | pass | pass (always) | pass | pass | pass | pass (5) |  |
| **billcom** | | | | | | | | | |
| `billcom.vendor.search` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `billcom.vendor.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `billcom.bill.list` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `billcom.bill.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `billcom.payment.list` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `billcom.payment.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `billcom.vendor.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `billcom.vendor.update` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `billcom.bill.create` | connector / external / create, undo reverse | pass | pass | pass | pass | pass | pass | pass (7) |  |
| `billcom.bill.update` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `billcom.bill.archive` | connector / external / update, undo none | pass | pass | pass | FAIL | pass | pass | pass (1) | BILL's void under `update`, not always-signed; runs unsigned at update:auto: TOOL-4 |
| `billcom.bill.attach_document` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `billcom.payment.create` | connector / external / create, undo none | pass | pass | pass (always) | pass | pass | pass | pass (1) | Always signed; payment create off by default |
| **odoo** | | | | | | | | | |
| `odoo.record.search` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (1) |  |
| `odoo.record.get` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (2) |  |
| `odoo.record.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) | Twin within 24h reported alreadyDone (DECISION) |
| `odoo.record.update` | connector / external / update, undo restore | pass | pass | pass | FAIL | pass | pass | pass (1) | Can set `active: false` (Odoo's archive) under `update`; delete=off doesn't stop it: TOOL-3 |
| `odoo.order.confirm` | connector / external / update, undo none | pass | pass | pass | pass | pass | pass | pass (2) |  |
| `odoo.invoice.post` | connector / external / update, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `odoo.receipt.validate` | connector / external / update, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `odoo.note.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| `odoo.activity.create` | connector / external / create, undo none | pass | pass | pass | pass | pass | pass | pass (1) |  |
| **testkit** | | | | | | | | | |
| `testkit.record.query` | connector / none / read | pass | n/a | n/a (read auto) | n/a | pass | pass | pass (17) |  |
| `testkit.record.update` | connector / external / update, undo restore | pass | pass | pass | pass | pass | pass | pass (36) | Not registered in production |
| **materials** | | | | | | | | | |
| `materials.catalog.search` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `materials.catalog.create_item` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (5) | Ignores test mode: a test run adds to the live catalog: TOOL-5; throws plain Error |
| `materials.match_line` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (4) | Passes testRun only to its event emit (read in code, not reproduced) |
| `materials.match_lines` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (4) | Same as match_line (not reproduced) |
| `materials.catalog.duplicates` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `materials.prices.record` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.prices.check` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `materials.prices.history` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `materials.prices.compare_vendors` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `materials.prices.digest` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `materials.request.create` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (10) |  |
| `materials.request.get` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.request.list` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.request.update` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `materials.request.add-lines` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.request.match-lines` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.catalog.match-text` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `materials.vendors-for-items` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.frequent-items` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.quote.create` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (10) |  |
| `materials.quote.mark-sent` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (8) |  |
| `materials.quote.get` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.quote.record` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (10) |  |
| `materials.quote.compare` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `materials.po.document` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.backfill-from-bills` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `materials.request.update-lines` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.vendor-contacts` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.quote.expire` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.quote.document` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.vendor.qbo` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (2) | Writes the shared `vendor.external_refs.qbo` from the input id (not verified); test run keeps nothing |
| `materials.po.qbo-lines` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.quote.chosen` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.lines.lookup` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `materials.matches.check` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.matches.record` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `materials.prices.compare` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `materials.vendor.match` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (6) |  |
| `materials.vendor_items.lookup` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `materials.vendor_items.similar` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `materials.master_items.candidates` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `materials.vendor_items.register` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `materials.vendor_items.list` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (3) |  |
| `materials.vendor_items.for_item` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.vendor_item.upsert` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (3) | Ignores test mode (only its embedding skips): TOOL-5 |
| `materials.vendor_items.import` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.vendor_item.set_preferred` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (2) | Ignores test mode: a test run changes the live preferred vendor: TOOL-5 |
| `materials.vendor_item.discontinue` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (2) | Ignores test mode: a test run discontinues a live vendor item: TOOL-5 |
| `materials.embeddings.write` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (4) |  |
| `materials.contract.get` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.contract.save` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.invoice.review` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `materials.vendor_item.set_tolerance` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| **marketing** | | | | | | | | | |
| `marketing.search.figures` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `marketing.content.get` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `marketing.content.draft` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `marketing.content.check` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `marketing.site.figures` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `marketing.site.page` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `marketing.report.record` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `marketing.report.get` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `marketing.titles.check` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `marketing.article.draft` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `marketing.social.check` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `marketing.forum.threads.unseen` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `marketing.forum.thread.mark` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `marketing.forum.reply.draft` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| **bookkeeping** | | | | | | | | | |
| `bookkeeping.transactions.import` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.transactions.settle` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `bookkeeping.transactions.open` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `bookkeeping.accounts.list` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.booking.propose` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `bookkeeping.account.note` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `bookkeeping.accounts.unclear` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.transactions.to-review` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `bookkeeping.bookings.ready` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `bookkeeping.booking.qbo-input` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.booking.posted` | internal / internal / update | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `bookkeeping.reconcile.pairs` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `bookkeeping.reconcile` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (2) |  |
| `bookkeeping.reconcile.open` | internal / none / read | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |
| `bookkeeping.reconcile.propose` | internal / internal / create | pass | n/a | n/a | n/a | n/a | pass | pass (1) |  |

Skills table notes:
- Skill input and output are JSON Schemas, checked by the runtime (the `def.input` check in run-agent and `checkAgainst` on output).
- Task skills never write.
- Agent skills write only through their tools' gate.
- Tool-mode skills inherit their handler's row above.

| Skill | Mode / handler | 1 Zod (JSON Schema in/out) | 2-4 Writes | 5 Grants | 6 Errors | 7 Test (files) | Note |
|---|---|---|---|---|---|---|---|
| **documents** | | | | | | | |
| `docs.extract` | tool / `docs.extract` | pass | internal records only | n/a | pass | pass (37) |  |
| `docs.read` | tool / `docs.read` | pass | internal records only | n/a | pass | pass (15) |  |
| `docs.find-support` | tool / `docs.find_support` | pass | internal records only | n/a | pass | pass (5) |  |
| `docs.match-bill` | tool / `docs.match_bill` | pass | n/a (reads) | n/a | pass | pass (2) |  |
| `docs.plan-bill` | tool / `docs.plan_bill` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `docs.bill-lines` | tool / `docs.bill_lines` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `docs.read-document` | task / - | pass | none (task skills never write) | n/a | pass | pass (8) |  |
| `docs.check-totals` | tool / `docs.totals.check` | pass | n/a (reads) | n/a | pass | pass (2) |  |
| `docs.prepare-bill` | task / - | pass | none (task skills never write) | n/a | pass | FAIL (none direct) |  |
| `docs.check-bill` | tool / `docs.bill.check` | pass | n/a (reads) | n/a | pass | pass (2) |  |
| **knowledge / writing / directory / ledger** | | | | | | | |
| `knowledge.search` | tool / `knowledge.search` | pass | n/a (reads) | n/a | pass | pass (5) |  |
| `writing.draft-in-voice` | agent / - | pass | via its tools' gate | n/a | pass | pass (1) |  |
| `directory.lookup` | tool / `directory.search` | pass | n/a (reads) | n/a | pass | pass (1) |  |
| `ledger.chart` | tool / `ledger.accounts.list` | pass | n/a (reads) | n/a | pass | pass (1) |  |
| **people / comms / data** | | | | | | | |
| `comms.reach-out` | tool / `comms.reach_out` | pass | internal records only (sends via planned external actions) | n/a | pass | pass (10) |  |
| `comms.converse` | tool / `comms.converse` | pass | internal records only | n/a | pass | pass (10) |  |
| `forms.request` | tool / `forms.request` | pass | internal records only | n/a | pass | pass (2) |  |
| `forms.draft` | task / - | pass | none (task skills never write) | n/a | pass | pass (1) |  |
| `comms.read-message` | tool / `inbound.get` | pass | n/a (reads) | n/a | pass | pass (2) |  |
| `comms.translate` | tool / `comms.translate` | pass | internal records only | n/a | pass | pass (5) |  |
| `data.reshape` | tool / `data.reshape` | pass | n/a (reads) | n/a | pass | pass (7) |  |
| `data.group-list` | tool / `data.list.group` | pass | n/a (reads) | n/a | pass | pass (1) |  |
| **supervisor / account** | | | | | | | |
| `supervisor.triage` | agent / - | pass | via its tools' gate | n/a | pass | pass (2) |  |
| `supervisor.report` | tool / `supervisor.report` | pass | internal records only | n/a | pass | pass (3) |  |
| `supervisor.daily-check` | tool / `supervisor.check` | pass | internal records only | n/a | pass | pass (1) |  |
| `supervisor.explain` | task / - | pass | none (task skills never write) | n/a | pass | pass (1) |  |
| `account.chat` | agent / - | pass | via its tools' gate | n/a | pass | pass (2) |  |
| **QuickBooks Online (agent/task)** | | | | | | | |
| `qbo.map-invoice-lines` | agent / - | pass | via its tools' gate | n/a | pass | pass (1) |  |
| `qbo.choose-invoice-lines` | task / - | pass | none (task skills never write) | n/a | pass | pass (1) |  |
| **Materials / Purchasing pack** | | | | | | | |
| `materials.match-lines` | tool / `materials.match_lines` | pass | internal records only | n/a | pass | pass (5) |  |
| `materials.review-merge` | agent / - | pass | via its tools' gate | n/a | pass | FAIL (none direct) |  |
| `materials.record-prices` | tool / `materials.prices.record` | pass | internal records only | n/a | pass | pass (1) |  |
| `materials.price-check` | tool / `materials.prices.check` | pass | internal records only | n/a | pass | pass (1) |  |
| `materials.vendor-compare` | tool / `materials.prices.compare_vendors` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `materials.weekly-digest` | tool / `materials.prices.digest` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `materials.read-request` | task / - | pass | none | n/a | pass | pass (3) |  |
| `materials.read-quote` | task / - | pass | none | n/a | pass | pass (6) |  |
| `materials.open-request` | tool / `materials.request.create` | pass | internal records only | n/a | pass | pass (3) |  |
| `materials.update-request` | tool / `materials.request.update` | pass | internal records only | n/a | pass | pass (1) |  |
| `materials.match-request` | tool / `materials.request.match-lines` | pass | internal records only | n/a | pass | pass (1) |  |
| `materials.find-vendors` | tool / `materials.vendors-for-items` | pass | n/a (reads) | n/a | pass | pass (2) |  |
| `materials.top-items` | tool / `materials.frequent-items` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `materials.request-quotes` | tool / `materials.quote.create` | pass | internal records only | n/a | pass | pass (2) |  |
| `materials.mark-quote-sent` | tool / `materials.quote.mark-sent` | pass | internal records only | n/a | pass | pass (2) |  |
| `materials.record-quote` | tool / `materials.quote.record` | pass | internal records only | n/a | pass | pass (2) |  |
| `materials.compare-quotes` | tool / `materials.quote.compare` | pass | n/a (reads) | n/a | pass | pass (3) |  |
| `materials.purchase-order` | tool / `materials.po.document` | pass | internal records only | n/a | pass | pass (2) |  |
| `materials.import-bill-prices` | tool / `materials.backfill-from-bills` | pass | internal records only | n/a | pass | FAIL (none direct) |  |
| `materials.update-request-lines` | tool / `materials.request.update-lines` | pass | internal records only | n/a | pass | FAIL (none direct) |  |
| `materials.vendor-contacts` | tool / `materials.vendor-contacts` | pass | n/a (reads) | n/a | pass | pass (2) |  |
| `materials.quote-document` | tool / `materials.quote.document` | pass | internal records only | n/a | pass | pass (1) |  |
| `materials.expire-quotes` | tool / `materials.quote.expire` | pass | internal records only | n/a | pass | FAIL (none direct) |  |
| `materials.qbo-vendor` | tool / `materials.vendor.qbo` | pass | internal records only (shared `vendor`) | n/a | pass | pass (1) | Writes `vendor.external_refs.qbo` from the input id |
| `materials.qbo-order-lines` | tool / `materials.po.qbo-lines` | pass | n/a (reads) | n/a | pass | pass (1) |  |
| `materials.chosen-vendor` | tool / `materials.quote.chosen` | pass | n/a (reads) | n/a | pass | pass (1) |  |
| `materials.lookup-existing` | tool / `materials.lines.lookup` | pass | n/a (reads) | n/a | pass | pass (5) |  |
| `materials.match-unmatched` | task / - | pass | none | n/a | pass | pass (2) |  |
| `materials.check-matches` | tool / `materials.matches.check` | pass | n/a (reads) | n/a | pass | pass (4) |  |
| `materials.compare-prices` | tool / `materials.prices.compare` | pass | n/a (reads) | n/a | pass | pass (2) |  |
| `materials.read-quote-document` | task / - | pass | none | n/a | pass | pass (3) |  |
| `materials.choose-merges` | task / - | pass | none | n/a | pass | pass (1) |  |
| `materials.match-vendor` | tool / `materials.vendor.match` | pass | n/a (reads) | n/a | pass | pass (4) |  |
| `materials.match-sku-vendor` | tool / `materials.vendor_items.lookup` | pass | n/a (reads) | n/a | pass | pass (5) |  |
| `materials.semantic-match-vendor` | task / - | pass | none | n/a | pass | pass (2) |  |
| `materials.master-item-manager` | task / - | pass | none | n/a | pass | pass (1) |  |
| `materials.read-contract` | task / - | pass | none | n/a | pass | pass (1) |  |
| `materials.invoice-review` | tool / `materials.invoice.review` | pass | n/a (reads) | n/a | pass | pass (1) |  |
| **Marketing pack** | | | | | | | |
| `marketing.weekly-report` | agent / - | pass | via its tools' gate | n/a | pass | FAIL (none direct) |  |
| `marketing.titles` | agent / - | pass | via its tools' gate | n/a | pass | FAIL (none direct) |  |
| `marketing.article-draft` | agent / - | pass | via its tools' gate | n/a | pass | FAIL (none direct) |  |
| `marketing.forum-reply` | agent / - | pass | via its tools' gate | n/a | pass | FAIL (none direct) |  |
| `marketing.social-post` | agent / - | pass | via its tools' gate | n/a | pass | FAIL (none direct) |  |
| `marketing.check-titles` | tool / `marketing.titles.check` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `marketing.check-post` | tool / `marketing.social.check` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `marketing.write-report` | task / - | pass | none | n/a | pass | pass (1) |  |
| `marketing.write-titles` | task / - | pass | none | n/a | pass | pass (1) |  |
| `marketing.write-article` | task / - | pass | none | n/a | pass | pass (1) |  |
| `marketing.write-forum-reply` | task / - | pass | none | n/a | pass | pass (1) |  |
| `marketing.write-post` | task / - | pass | none | n/a | pass | pass (1) |  |
| **Bookkeeping pack** | | | | | | | |
| `bookkeeping.import` | tool / `bookkeeping.transactions.import` | pass | internal records only | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.settle` | tool / `bookkeeping.transactions.settle` | pass | internal records only | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.categorize` | agent / - | pass | via its tools' gate | n/a | pass | pass (2) |  |
| `bookkeeping.accounts-to-ask` | tool / `bookkeeping.accounts.unclear` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.to-review` | tool / `bookkeeping.transactions.to-review` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.ready` | tool / `bookkeeping.bookings.ready` | pass | n/a (reads) | n/a | pass | pass (1) |  |
| `bookkeeping.qbo-input` | tool / `bookkeeping.booking.qbo-input` | pass | n/a (reads) | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.posted` | tool / `bookkeeping.booking.posted` | pass | internal records only | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.reconcile-pairs` | tool / `bookkeeping.reconcile.pairs` | pass | n/a (reads) | n/a | pass | pass (1) |  |
| `bookkeeping.reconcile-two` | tool / `bookkeeping.reconcile` | pass | internal records only | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.explain-leftovers` | agent / - | pass | via its tools' gate | n/a | pass | FAIL (none direct) |  |
| `bookkeeping.read-statement` | task / - | pass | none | n/a | pass | pass (2) |  |
| `bookkeeping.propose-accounts` | task / - | pass | none | n/a | pass | pass (1) |  |
| `bookkeeping.suggest-matches` | task / - | pass | none | n/a | pass | pass (1) |  |
| `bookkeeping.read-statement-document` | task / - | pass | none | n/a | pass | pass (3) |  |
| **Connector read skills (tool mode, generated per read tool by `connectorReadSkills`)** | | | | | | | |
| `qbo.purchase.query`, `qbo.bill.query`, `qbo.vendor.query`, `qbo.item.query`, `qbo.attachable.list`, `qbo.invoice.query`, `qbo.customer.query`, `qbo.payment.query`, `qbo.aging_report`, `qbo.account.query`, `qbo.class.query`, `qbo.purchaseorder.query`, `qbo.account.register` | tool / same id | pass | n/a (reads) | via handler's gate | pass | pass (see tool rows) |  |
| `zoho_crm.record.search`, `zoho_crm.record.get` | tool / same id | pass | n/a (reads) | via handler's gate | pass | pass |  |
| `podio.space.list`, `podio.app.list`, `podio.app.get`, `podio.item.filter`, `podio.item.get` | tool / same id | pass | n/a (reads) | via handler's gate | pass | pass |  |
| `messages.search`, `message.get`, `call.get` | tool / same id (Twilio first; bound connector at call time) | pass | n/a (reads) | via handler's gate | pass | pass |  |
| `drive.file.list`, `sheets.range.read`, `excel.range.read`, `calendar.events.list`, `calendar.freebusy` | tool / same id | pass | n/a (reads) | via handler's gate | pass | pass |  |
| `ramp.transaction.query`, `ramp.user.query`, `hubspot.record.search`, `hubspot.record.get`, `bankfeed.transaction.query`, `bankfeed.account.query` | tool / same id | pass | n/a (reads) | via handler's gate | pass | pass |  |
| `browser.page.read`, `browser.file.download`, `browser.script.read`, `hackernews.search`, `hackernews.thread` | tool / same id | pass | n/a (reads) | via handler's gate | pass | pass |  |
| `billcom.vendor.search`, `billcom.vendor.get`, `billcom.bill.list`, `billcom.bill.get`, `billcom.payment.list`, `billcom.payment.get`, `odoo.record.search`, `odoo.record.get`, `testkit.record.query` | tool / same id | pass | n/a (reads) | via handler's gate | pass | pass |  |

(The gsc, gsc_oauth, bing_webmaster and upload connectors register no agent tools, so they have no rows.)

## 4. What verification disproved or merged

| ID | Verdict | Why |
|---|---|---|
| AI-2 | DISPROVED | The facts in the charter draft are the client's own (`theirs` facts and confirmed `about` entries). The draft isn't used until the client admin confirms it (`apps/api/src/knowledge/charter.ts:1-6`). The only "attacker" is the client, editing their own charter. |
| FLOW-3 | DISPROVED | `portalAuthorize` writes nothing. A connection is inserted only at the callback, which reuses an existing row (`connections.ts:130-143`). A double press fetches a second redirect URL and nothing more. |
| SEC-2 | BY DESIGN | Recorded in migration `0042_second_factor.sql` and asserted by `second-factor.test.ts:107`. The only route to these rows checks that the operator serves the person's client (`second-factor.ts:424-429`). `user_factor` has no `tenant_id`, and recovery codes are HMACs. **Owner's call:** RLS gives no isolation behind that route check. **Fixed anyway, at the owner's request:** migration 0068 limits an operator session to the people of the clients it serves (`docs/plan.md` §1.157). |
| SEC-4 | BY DESIGN | `plan.md:5074` (§1.122 "Not here"): "A limited user's document by id is checked by client, not by agent." Ids are UUIDv7. **Fixed anyway, at the owner's request** (#468): a limited user opens only documents their own agents' items, runs or steps name. |
| SEC-6 | BY DESIGN | DECISION at `plan.md:921` and the `0017_audit_log.sql:41-42` policy. Rows with no client belong to no tenant, and every operator is Mezonas staff. **Fixed anyway, at the owner's request** (#470, migration 0071): an operator reads only no-client rows of people in clients it serves, of operators, or with no actor. |
| STATE-5 | BY DESIGN | DECISION at `hubspot/index.ts:813-816`, the twin check. The record holds that exact note, and the action records its id. Odoo has the same rule. **Fixed anyway, at the owner's request** (#469): HubSpot and Odoo create once per key through attempt records; different keys always write. |
| TOOL-4 | BY DESIGN | DECISION at `plan.md:4037-4041`. BILL's archive is a void that keeps the bill, approval is on by default, and it runs alone only after the operator loosens and the client allows `auto`. Delete itself stays off. **Fixed anyway, at the owner's request** (#469): `billcom.bill.archive` is always signed. |
| FLOW-9 | DUPLICATE OF INPUT-5 | The same `Number(text)` at `DeskDetail.tsx:1054`. |

Lowered by the verifier, with the reason that carried the most weight:
- **INPUT-1, INPUT-2, INPUT-3:** the shipped reconcile flows use one account per side and run on the 3rd at 07:19.
- **INPUT-5:** the server re-checks every edit before it is signed.
- **INPUT-6:** a lost invoice, not a bad write.
- **INPUT-7:** QBO customers and vendors are single-currency.
- **INPUT-9:** over-redaction fails safe.
- **FLOW-1:** React escapes it; it is wording only.
- **FLOW-2, FLOW-4, FLOW-5:** nothing wrong is stored.
- **FLOW-6:** the subaccount SID is an identifier, not a secret.
- **SEC-7:** the desktop API isn't built.
- **AI-1:** a schema and the veto stand after it.
- **AI-3:** only hand-written schemas; writes are re-checked.
- **AI-4:** rare; an unnamed tool is refused.
- **AI-5, AI-6:** reachable only when the tool is offered to a model.
- **AI-7:** behind an off flag.
- **INTEG-1:** nothing is written wrong.
- **INTEG-3:** needs a captured request.
- **INTEG-4, INTEG-6:** fail safe; a person is asked.
- **STATE-1:** the next minute catches up.
- **STATE-2:** either approver may decide alone in `any` mode.
- **STATE-4:** needs a stopped try.
- **STATE-6:** the button is guarded.
- **STATE-8:** a duplicate ask, no write.
- **CONS-1:** no escalation.
- **CONS-2:** the Builder's ids are UUIDs.
- **TOOL-1:** trial and sign-off sign every write until go-live.
- **TOOL-2:** needs a hand-crafted API body.

Leads the lenses checked and dropped, as not defects:
- **Recorded DECISIONs:** OAuth state reuse; the 5-minute carried account; Ramp's 10 pages; the durable-step estimate counting each step once (`plan.md:4517`); assumed units compared only within a vendor (`plan.md:5472`).
- **Harm stopped by another layer:**
  - `propose` on a key conflict: `resumeProposed` compares the input.
  - Disconnect: writes then fail as `not_connected`.
  - NUL bytes and lone surrogates map to 400 in `pgStatus`.
  - Webhook replays are deduped by message id or body hash.
- **Not reproduced:** HubSpot's revoke token in a log line; a refetch dropping notification toggles; a phone signature replay.

## 5. The map

Eight read-only mappers built this map, one per slice. It covers the platform end to end, without the Builder. The mappers also listed unproven "leads"; those are left out here. Each lead either became a finding above or was checked and dropped by a lens.

### 5.0 Invariants the platform must hold

These start from CLAUDE.md's 14, made concrete for this audit. R1–R4 are runtime rules added by this audit.


**Client isolation (1)**
- I1.1 One client's data is never readable or writable in another client's run, portal session or operator session that doesn't serve it.
- I1.2 Every query on a tenant table filters by `tenant_id` as well as relying on RLS.
- I1.3 Global tables (`tenant`, `app_user`) are changed only for the session's own client and person.
- I1.4 Person-scoped secrets (second factors, recovery codes, approvals) are readable only by that person, not by every operator.
- I1.5 A removed membership or role stops working.

**Layering (2):** I2.1 No platform package imports a pack.

**Immutable history (3):** I3.1 `agent_version`, `skill_version`, `raw_record`, `doc_extraction` and `audit_event` are never updated (except status) or deleted.

**Settings (4)**
- I4.1 The executor and the builder share one validator. What fails validation never runs: not live, and not on a test run.
- I4.2 A workflow the validator accepts runs as the validator understood it (step ids, the agent field, durable names).

**Validation (5)**
- I5.1 Tool inputs and outputs are Zod-checked in both directions, including connector writes and provider responses.
- I5.2 Model output is Zod-checked for every provider (Anthropic, OpenAI, Gemini), and a schema that can't be read fails closed.

**Money (6)**
- I6.1 No money passes through a JS float: inbound provider amounts, connector field values, web edit forms.
- I6.2 Currencies are never mixed in a sum or a comparison.

**Units and rules (7)**
- I7.1 Never compare prices across different or assumed `standard_uom`.
- I7.2 Hard matching rules veto the model at every step that records a decision, not only in the check step.

**Approval and writes (8)**
- I8.1 A write happens at most once per idempotency key, including after a retry, a lost answer, a takeover or a replay.
- I8.2 Reusing an idempotency key with different input never writes the old or the new input silently.
- I8.3 A test run never writes to a client's tool, never sends a message to a real person, and never creates real inbox items or codes for clients.
- I8.4 An expired or revoked token never leaves a half-done write; the action ends `failed` (or `unconfirmed`), not `done`.
- I8.5 The gate (strictest of matrix, grant, step, mode, stage, `alwaysSigned`, hold) is rechecked at execution for every action, including undo.
- I8.6 Approval defaults to required on every write step, template and promotion. A promotion never carries `not_required` or `mode: act` into a template.
- I8.7 Delete is off, including delete-like writes (archive, deactivate, take down).
- I8.8 The approval the person saw (its before state and input) is what is executed and what stays on record.

**Untrusted text (9)**
- I9.1 Document, email, vendor, web page and chat text reaches models only as tool results or properly escaped data, never in system prompts or inside unescaped tags.
- I9.2 Model output can't change approvals, permissions or the plan, and can't impersonate a person's decision.

**Evidence (10):** I10.1 Alerts carry sources, and a decision recorded as "human" was made by a person.

**Operator and client (11)**
- I11.1 No portal route returns bundles, prompts or cost.
- I11.2 An agent-limited client user sees only their agents' records.

**Email (12):** I12.1 The Gmail query is narrow and validated, and can't be widened without a check.

**Access and secrets (13)**
- I13.1 A secret never reaches a model, a log, an error message, a step output or a screen (provider error strings included).
- I13.2 A second factor is single-use and goes to the right login.
- I13.3 The browser types secrets only on pinned origins.
- I13.4 OAuth state is single-use.

**Audit and compliance (14)**
- I14.1 Every read or change of client data on a person's behalf writes an audit row, file downloads included.
- I14.2 HIPAA mode refuses every unnamed vendor.
- I14.3 Card numbers are redacted in every store (threads, calls, tool_call, external_action).

**Runtime**
- R1 A step retried by the engine doesn't repeat internal writes, notifications or emitted events.
- R2 A provider timeout, 429 or 5xx gives a typed, retryable error. A 401 or revocation gives a reconnect, never a crash or a silent success.
- R3 Budgets stop runaway cost even when a model has no price.
- R4 A cron race never aborts a client's whole cron pass.


### 5.0.1 Boundaries data crosses

| Boundary | How it is guarded | Where |
|---|---|---|
| Browser → API | Middleware: `securityHeaders`, then `requestOrigin` (CSRF on non-GET), then `mobileSession`. Then `mount()`: identify, the second factor, the removed-phone check, role and tenant scope (a portal session has exactly one client), `withSession`, the handler, and an audit row. The web checks each body against the route's Zod schema before sending; the server checks it again. | `apps/api/src/http.ts:715`, `request-origin.ts`, `core/api/contract.ts` |
| API → database | The Worker connects as `cs_worker` (in `cs_runtime`). Client data is reached only inside `withTenant` or `withOperator`. Every table with `tenant_id` has FORCE RLS on `app.tenant_ids`. `tenant` and `app_user` have no RLS. Operator tables are keyed by `client_id`. | `packages/db/src/client.ts`, migrations |
| API → model | `packages/llm`: Anthropic answers are Zod-checked; OpenAI, xAI and Gemini answers are cast (AI-4). Operator text goes in the system prompt. Untrusted text goes in a synthetic `read_*` tool result or escaped `promptText`/`promptJson` (AI-1 is an exception). Answers come back through a `finish` tool and are checked against the skill's schema (`checkAgainst`, which fails open: AI-3). | `packages/llm`, `packages/agents/src/runtime` |
| API → provider | Connector tools (Zod in, out and before), then `invoke.check()` (tenant, connector, status, matrix), then an injected `fetch` with `redirect: manual` and a timeout. Credentials come from the per-client vault, decrypted for one step. Each connector maps its own errors to typed errors with `retryable` and `notWritten` (no shared base; R2 gaps in INTEG-4/5/6). | `packages/connectors/src/invoke.ts`, `credentials*.ts` |
| Service bindings | `apps/mfa` (codes) and `apps/browser` are reached only by the `CODES` and `BROWSER` bindings. mfa's public fetch is `/health` plus a signed Twilio SMS hook (no replay guard: INTEG-3). apps/browser's fetch answers 404. | `apps/api/wrangler.jsonc`, `apps/mfa/src/index.ts`, `apps/browser/src/index.ts` |
| Webhooks in | Each provider's signature, compared in constant time. Plaid, Stripe, the signed generic hook and ElevenLabs have a time window. Twilio and Meta dedupe by message id, the generic hook by body hash, and QBO and Zoho re-sync idempotently. No audit row (system work). | `apps/api/src/routes/hooks.ts` and the provider routes |
| Email in | The Cloudflare email handler routes, in order: codes, release reply, reach-out reply, back office, voice sample, Sloan, agent address, forwarding. Forwarding, replies and Sloan require SPF and DMARC; back office doesn't (SEC-1). | `apps/api/src/email.ts`, `mail-route.ts` |
| Phone app → API | A PKCE handoff, then the `x-mezonas-session` header. A Desk decision carries an ECDSA device signature (±300 s), and the server re-runs the gate. | `apps/api/src/routes/mobile.ts`, `mobile/devices.ts` |
| Desktop app → API | Not built yet. The client signs `mezonas-desktop:v1` requests (ECDSA, ±300 s, no nonce); there are no routes or tables. | `packages/core/src/desktop/protocol.ts` |
| Public beacon in | `POST /api/in/:pack/:tenantId/:target`: no session, an IP rate limit, the pack must be on, a 16 KB cap, and a field-by-field check. | `apps/api/src/routes/pack-inbound.ts` |

### 5.0.2 Every model call

| Where | Inputs (untrusted ones in bold) | How the output is parsed and checked |
|---|---|---|
| The agent loop (`packages/agents/src/runtime/run-agent.ts:987`) | Skill instructions and charter (system). **Task input, memory, attachments and tool results** (tool results). | Tool calls go through `callTool` (Zod). `finish` goes through `checkOutput`, which checks it against the skill's schema (AI-3). Refusal or a cut-off answer fails the step; budgets escalate. |
| Path choice and repeat judge (`runtime/choose.ts:179, :294`) | **Run data, clipped to 20k** (tool result). | `pickedPath` checks against an enum of allowed paths plus `unsure`, and the executor intersects again. `PassVerdictAnswer`. |
| Oversight (`runtime/oversee.ts:591`) | **Step input, error, earlier steps, owner memory** (tool result). | `parseOversightDecision`. `retry_with` is checked against the schema plus the fixed fields. |
| Confer (`runtime/confer.ts:141`) | **Input, output, references** (tool result). | Zod `Answer`, or unsure. |
| Conversation (`runtime/converse.ts:237`) | **Transcript, record, notes** (tool result). The goal and opening are fixed inputs (system). | `ConverseAnswer`, plus `checkAgainst`. |
| Reach-out composition (`runtime/planned.ts:294`) | **Record and contact**, via `promptJson` in `<data>`. | Zod `Composed`. |
| Translation (`runtime/translate.ts:105`) | **Message** (tool result). | `TranslateAnswer`. |
| `web.search` and `web.fetch` (`tools/web.ts:389, :402`) | A query or URL the agent chose (AI-7). | `searchResultsOf`, `fetchedPageOf`. |
| Document extraction (`packages/documents`) | **Document text and images.** | Zod per document type; validated, then linked. |
| Materials parse and adjudicate (`packs/materials/src/catalog/model.ts`) | **Vendor line text** in `<line>`, unescaped (AI-1). | `llm.callTool` with a Zod schema, then the `scorePair` veto (`match.ts:298`). |
| Pack task skills (purchasing, bookkeeping, marketing) | **Request, quote, statement and bank text** in the task input. | The skill's output schema, then deterministic checks in code (sums, accounts, thresholds). |
| Embeddings (materials) | Item names. | Vector length. Cost is recorded on the step. |
| Charter draft (`packages/core/src/governance/charter.ts:61`) | The client's own facts in `<data>`. | The client admin confirms the draft before it's used. |
| Voice: inbound calls and ElevenLabs | **The caller's speech**, held by the provider. | Tool calls back through `/api/voice/:t/tools/:tool` with a token. Post-call data is signed. |

### 5.0.3 Run, step, approval, action, connection, version and client states

| Thing | States, and how they move |
|---|---|
| Run (`packages/db/src/schema.ts:79`) | `queued` → `running` → `succeeded` \| `failed` \| `cancelled`. "Waiting" is worked out from open inbox items (`run-wait.ts`). `finishRun` ends a run once; open items become `expired` and proposed actions `rejected`. The reconciler fails runs whose instance has ended. |
| Step run | `pending` → `running` → `waiting` (approval, reply, help or person) → `succeeded` \| `failed` \| `skipped` \| `cancelled`. Retries set it back to `running` and add an attempt. v4 outcome records include: done, empty, rejected, no_answer, skipped, failed, needs_help, timed_out, sent, limit, stopped. |
| Tool call | `running` → `succeeded` \| `failed` \| `refused` \| `awaiting_approval`. |
| Approval (inbox item) | `open` → `resolved` \| `expired`. Undo inside the window reopens the change. Approval modes: `in_turn`, `any`, `all`; with several signers, it waits for the last yes. |
| External action | `proposed` → `approved` (by a person, or automatically when the gate says run and it isn't a test or a signed stage) → `executing` (`claim`, 25-minute lease, takeover) → `done` \| `failed`. Also: approved → `rejected` on a gate refusal at execution. approved → `proposed` on undo inside the window or when a signer is added. An undo is a new `undo:<id>` action inserted as approved. An unconfirmed write ends `failed`, with an operator review item. |
| Connection | `pending` (no sign-in needed) → `connected` → `disconnected` (credentials cleared, revoke tried) \| `error` (browser stopped, or reconnect required). `AccessFailingError` keeps it connected and raises it for a person. |
| Agent version | `draft` → `live` → `retired`. Publish retires the old live version. A rollback copies the old version as a new one, then publishes it. Rows are never updated except `status`. |
| Agent stage and run status | Stage: `bench` → `trial` → `signoff` → `live` (anything but `live` is `suggest_only`). Run status: `draft` \| `testing` \| `active` \| `paused` \| `retired`. A safety hold adds an `approval` ceiling. |
| Client (tenant) | Live or not live, with a compliance mode (standard, or HIPAA, which refuses unnamed vendors and holds the inbound beacon), packs enabled through `tenant_pack` (no disable route), and go-live stages per agent. |

### 5.0.4 The flows, step by step

- **Connecting a tool.**
  - OAuth: `portalAuthorize` (no write) → an HMAC state (10 min, bound to client, connector, user and origin; not single-use, a DECISION) → the provider → `/connections/:c/callback` → `completeAuthorization` (the state is checked and `handleCallback` runs) → credentials sealed with the client's key → the connection is `connected`.
  - API keys: `portalSetCredentials` (client admin, write-only).
  - Browser logins: the operator's site profile → the client admin's `portalSetUpBrowser` (the blocked tier is refused; a code identity is made and a Twilio number bought or an authenticator set; the connection is pinned to the site version) → a vault entry. See 5.7.
- **An agent run.**
  1. A trigger: an event, webhook, email, schedule, manual run or hand-off.
  2. A run row pinned to the live version.
  3. `executeWorkflow` walks the steps.
  4. A skill or tool goes to `callTool`. The gate takes the strictest of matrix, grant, step, mode, stage, `alwaysSigned` and hold.
  5. `captureBefore`, keyed `<run>:<step>:<i>`.
  6. `propose` runs, together with the inbox item.
  7. An approval: a person or automatic.
  8. `executeAction`: the gate is checked again, then `claim`, then `executeWrite` (refused if the record moved since it was proposed).
  9. `complete` or `fail`.
  10. `tool_call`, `model_call` and audit rows are written.
- **Approvals and the Desk.**
  1. Items carry a fingerprint.
  2. Resolve locks the item and recomputes it.
  3. A phone decision is signed.
  4. `resolveInboxItem` runs the gate again, sends `inbox-<id>`, and the run resumes through `agent.resume`.
  5. The cron re-sends the resolution.
  6. Undo works within the window.
- **Reach-outs and messaging.** A planned reach-out is a plan signed once; its attempts run under that signature. Each send goes through the Twilio, WhatsApp, Gmail or Resend connectors with attempt records, then a reconcile on retry. Replies come back through tagged addresses or by message id.
- **Email capture and documents.** Forwarded mail is checked for SPF and DMARC and a known address; each attachment is checked by type and stored. Agent-address mail starts a run (INPUT-6). Documents are extracted (Zod), validated and linked; signed downloads last 5 minutes.
- **The test bench and test runs.** A test copy is bound to the client's real connections. A test run is mode `test`: writes become `would_have_done`, no notices or hand-offs are sent, person items go to the operator, memory is scoped to the run, and `emit` writes nothing. Pack tools must check `ctx.mode` themselves (TOOL-5).
- **Publishing, versions, forks, update merges and promotions.**
  - `createVersion` locks the agent and refuses stale saves and no-op saves. `publish` doesn't check order (STATE-7).
  - A fork keeps step ids and copies no bindings or memory; it doesn't check the version is published (TOOL-2).
  - An update merge is three-way and saved as a `merge` draft.
  - A promotion strips client settings and contacts into a template draft, but keeps the client's mode and approvals (TOOL-1).
- **The portal's settings and connection matrix.** Clients tighten only (`portalTightenPermissions`, `portalSetGrant`, browser stricter). Operators may loosen (`opsUpdateConnection`, which also writes raw config: SEC-5). Both matrix paths share `applyMatrixChange`.
- **Pack setup.** `opsEnableClientPack` inserts `tenant_pack` and installs the templates and Library skills once, deployment-wide. "Update templates" adds later versions. There is no disable.

### 5.1 Connectors

**Connection states**

`pending | connected | disconnected | error` (`connector.ts:27`). Only apps/api writes them.

| Transition | Where |
|---|---|
| → connected | `apps/api/src/routes/connections.ts:131,147` |
| → disconnected | `:330-358` (clears the credentials, revokes, swallows any error) |
| → error | the browser (`services.ts:98`), or `ReconnectRequiredError` |

`AccessFailingError` leaves the connection `connected`. A tool runs only on a `connected` connection, or a `pending` one when the connector needs no sign-in (`invoke.ts:71-75`).

**OAuth** (`oauth/flow.ts`)
1. **Start.** `beginAuthorization` (`:23`). The state is an HMAC over client, connector, user, origin and target, valid 10 minutes (`oauth/state.ts:90-123`).
2. **Callback.** `completeAuthorization` (`:116-166`) checks the signature, the expiry and that the state matches the session, then runs `handleCallback`.
3. **Store.** The credentials are encrypted with the client's own key.
4. **Refresh.** `tokenManager` (`oauth/tokens.ts:257-480`):
   - refreshes 5 minutes before expiry, or after a 401;
   - single-flight within an isolate;
   - a compare-and-swap across isolates;
   - `invalid_grant` disconnects;
   - otherwise a retryable `TokenRefreshError`, and after 24 hours an `AccessFailingError`.
5. **Revoke.** The connector's `revoke()`.

Gaps: the state's nonce is not single-use, and no connector uses PKCE.

**The vault** (`credentials.ts`)
- AES-256-GCM under the client's data key, with additional data binding it to the client and the connection.
- The data key is wrapped by the master key. `tenant-keys.ts` handles rewrap and destroy.
- The accessor (`credentials-accessor.ts`) decrypts lazily, caches for one step, and does compare-and-swap updates.
- Connectors that take credential fields: odoo, billcom, browser, gsc, bing_webmaster.

**A tool call**
1. `defineReadTool` and `defineWriteTool` take Zod input, output and before schemas (`connector.ts:299-440`).
2. `defineConnector` checks (`:684-757`):
   - tool-id prefixes;
   - a write tool is `external`;
   - no `internal` tools;
   - undo rules;
   - the default permissions are no looser than the platform's.
   The registry checks again (`registry.ts:282-311`).
3. `invoke.ts` runs `check()` (`:60-80`): the client, the connector, the status, and the connection's matrix level not `off`. Then `runReadTool`, `captureBefore` and `executeWrite`.
4. `executeWrite` refuses with `NotWrittenError` if the record changed since it was proposed (`recordChangedSince`, `:222-250`).
5. Zod failures become `ToolCallError` (`invoke.ts:13-35`).
6. The idempotency key is `<run>:<step>:<index>` (`agents call-tool.ts:528`).
7. HTTP is an injected fetch with `redirect: "manual"` and a timeout. There's no shared retry. QBO throttles and backs off on 429.

How each provider takes the key: QBO `requestid` = sha256(key); Ramp has its own key; Podio uses `external_id`; Stripe sends the header; Slack and Gmail keep attempt records and a Message-ID.

**Connectors**
| Folder | Writes | Fake | Unchecked in NOTES |
|---|---|---|---|
| qbo | 8 create, 6 update | yes | whole file |
| gmail / outlook | send | yes | 3 / 1 |
| gdrive / onedrive | upload | yes | to verify |
| gsheets / excel | rows.append, range.update | yes | to verify |
| slack / teams / gchat | message.post | yes | to verify |
| twilio | sms, whatsapp, call | yes | 54 |
| whatsapp_meta | send | yes | 2 |
| resend | email.send | yes | 2 |
| upload (email forwarding) | none | no | |
| browser | script.submit | yes | none |
| zoho_crm | create ×3, update | **no** | 21 |
| podio | create ×3, update | **no** | 11 |
| hubspot | create ×3, update | yes | 11 |
| odoo | create ×3, update, invoice.post, order.confirm, receipt.validate | yes | 14 |
| billcom | bill/vendor create and update, payment.create, bill.archive, attach | yes | 27 |
| ramp | receipt.upload | yes | 19 |
| bankfeed (Plaid) | none | yes | |
| stripe | none | yes | 9 |
| gcal / outlook_calendar | event create, update | yes | |
| linkedin | post | yes | |
| website | publish, meta | no | |
| webhook | event.send | no | |
| desktop | xlsx.append, file.create, xlsx.update | yes | not built yet |
| testkit | record.update | n/a | not registered in prod |

No tool has the `delete` verb. Delete is pinned `off` (`permissions.ts:185`).

**Webhooks in**
| Connector | Check | Replay window |
|---|---|---|
| qbo | HMAC-SHA256 | none |
| Plaid | ES256 JWT + body hash | ±5 min |
| stripe | t + v1 | yes |
| twilio | HMAC-SHA1 | none (dedupe by SID) |
| meta | X-Hub-Signature-256 | none |
| generic | token or signed `ts.body` | 5 min signed; none for token-only |
| zoho | channel token, no body signature | none |
| teams / gchat | JWT | exp |
| elevenlabs | t + v0 | 30 min |
| email | stored address + SPF/DMARC | |

**Pagination**
- QBO: limit ≤ 100, start ≤ 100k; CDC capped at 30 days and 1,000 objects.
- Plaid: at most 50 pages. Ramp: 10 pages. gcal: 10 pages. Slack: 2,000 channels. Zoho: 10 pages per window.
- Podio: offset has no maximum.

### 5.2 Agents runtime, registries and LLM

**Run flow**
1. **The run.** `createRun` (`log/run-log.ts:69-83`) inserts it as `running` on the pinned live version. The executor calls `runAgent` (`apps/api/src/runs/ports.ts:321`) with `stepId = keyNode ?? nodeId`.
2. **The step.** `runAgent` (`runtime/run-agent.ts:430`):
   - loads the pinned version (`registry/runtime-store.ts:92`, filtered by tenant and `kind=client`);
   - upserts the step_run with `startStepRun` (`run-log.ts:164`);
   - resolves the skill and checks the input against `def.input` (`:510`).
   - Modes: rule rows (`:629`), reshape (`:644`), tool (`:670`), and the agent/task loop (`:707-1131`).
3. **Each tool call.** `callTool` (`call-tool.ts:227`) checks, in order: the allowed set, readOnly, the browse scope, the `tool_call` row, `tools.resolve`, the policy/HIPAA refusal, then `dispatch`.
4. **The gate.**
   - Internal tools: Zod in, run, Zod out, with no gate (`:334-411`).
   - Connector tools: binding → connection (read fresh) → the grant's tool subset → the contact autonomy ceiling → `effectiveMode` by stage (anything not live is `suggest_only`, `core/lifecycle/stage.ts:85`) → the safety hold → `decideToolCall` (`core/permissions/decide.ts:56`).
   - `decideToolCall`: `alwaysSigned` never runs; any `off` refuses; matrix = `effectiveMatrix(matrix, grant)`, the stricter per verb (`grants.ts:70`); a write runs automatically only if the level is `auto` AND the step is `not_required` AND the mode is `act`.
   - Then the release gate (`:507`).
5. **The external action.**
   - `captureBefore` takes the before state. The key is `${runId}:${stepId}:${externalIndex++}` (`context.ts:127`).
   - It runs automatically only if `decision==="run" && !test && !signAllWrites`. Otherwise `routeApproval` builds the inbox item.
   - `actions.propose` (`log/external-actions.ts:145`) uses `onConflictDoNothing(tenant,key)` and makes the inbox item in the same transaction.
   - `settle`: a test run gives `would_have_done`.
6. **Approval.** `resolveExternalActionTx` (`external-actions.ts:916`) locks the item, refuses a test run or an ended run, and checks `mayResolve`. With several signers, the change waits for the last yes.
7. **Execute once.** `executeAction` (`runtime/actions.ts:78`):
   - throws for a test run;
   - rechecks the gate via `grantRefusal` (`:106`);
   - `actions.claim` takes a row lock, moves approved → executing, and allows a takeover after a 25-minute lease;
   - `executeWrite` runs with the key, `proposedBefore` and a recheck;
   - `complete`/`fail` is fenced on the claim time. `UnconfirmedWriteError` → failed plus an operator review item.
   - `sweepStaleExecutions` (`:551`).
8. **Logging.** A `tool_call` row for every call, a `model_call` row (card numbers redacted in `log/model-calls.ts:76`), and `agent_change` rows.

**States** (`packages/db/src/schema.ts:47-116`)

| Thing | States | Notes |
|---|---|---|
| run | queued, running, waiting, succeeded, failed, cancelled | mode live or test. `finishRun` closes approvals: items expire, proposed actions are rejected. |
| step_run | pending, running, waiting, succeeded, failed, skipped, cancelled | |
| tool_call | running, succeeded, failed, refused, awaiting_approval | |
| external_action | proposed → approved → executing → done or failed | approved → proposed on undo inside its window or when a signer is added; approved → rejected on a gate refusal; executing → executing on a lease takeover; an undo inserts a new `undo:<id>` action as approved |
| inbox_item | open, resolved, expired | |
| agent_version | draft, live, retired | publish retires the old live; rollback copies, then publishes |
| agent stage | bench, trial, signoff, live | |
| agent runStatus | draft, testing, active, paused, retired | |

**Model calls.** Operator text goes in the system prompt. Untrusted text goes in as a synthetic `read_*` tool_result. The answer comes back through a `finish` tool, and a cut-off answer is refused (`llm/client.ts:246`).

| Where | Untrusted input | Output check |
|---|---|---|
| `run-agent.ts:987` (the loop) | input, memory, attachments, tool results | `checkOutput` → `checkAgainst` (JSON schema → Zod) |
| `choose.ts:179` (choose/judge) | run data, clipped to 20k | Zod |
| `oversee.ts:591` (oversight) | step input, error, owner memory | `parseOversightDecision` |
| `confer.ts:141` | | Zod `Answer` |
| `converse.ts:237` | transcript (tool result); goal and opening in the system prompt | Zod + `checkAgainst` |
| `planned.ts:294` `composeReachMessage` | record and contact in the user message inside `<data>` | Zod `Composed` |
| `translate.ts:105` | | Zod |
| `tools/web.ts:389/402` | | |

- Anthropic transport (`anthropic.ts`): 2 retries on 408/409/429/5xx, a 10-minute limit, the answer Zod-checked.
- OpenAI, xAI and Gemini: answers are cast, not Zod-checked.
- Record/replay: requests are hashed, and a miss throws.

**Versions and lineage**
- `createVersion` (`agents.ts:230`) locks the agent and inserts only. It refuses `stale_parent` and `no_op`.
- Fork (`agents.ts:752`) keeps the step ids and copies no bindings or memory.
- Update merge (`lineage.ts:204`) is three-way and saved as a `merge` draft.
- Promote (`lineage.ts:808`): `stripForPromotion` (`:607`) resets client-specific settings and redacts emails and phone numbers.
- Memory, records and connections are never copied.

### 5.3 Workflows, the router and the test bench

**Triggers**
| Trigger | Path | Run id |
|---|---|---|
| Event | `emit` writes to the outbox in the caller's tx (`senses/outbox.ts:79`; test runs emit nothing). `dispatchTenant` (`runs/dispatch.ts:228`, skip locked) calls `routeEvent` (`workflows/router.ts:232`), then `createRunRow`, `markDispatched` and `instances.start`. | `eventRunId`, deterministic |
| Webhook | `routes/hooks.ts` sends `webhook.received` to `routeW2E` (`router.ts:363`), with dedupe and a rate limit | `webhookRunId` |
| Email | `triggers/inbound-email.ts:263` sends `inbound.message` to `messageOf` (`router.ts:301`) | event-based |
| Schedule | `cronTick` (`dispatch.ts:438`), then `dueSchedules` (`router.ts:585`, 15-min lookback), then `startRun` (`dispatch.ts:112`) | uuid v5 of (agent, slug, scheduledAt) |
| Manual / test | `requestRun` (`router.ts:646`); a test run can name any version | uuid v7 |
| Hand-off | `handoffRunRequest` (`router.ts:511`) | `handoffRunId` |

**How a run executes**
1. `RunWorkflow` (`runs/workflow.ts:13`) calls `executeRun` (`runs/execute.ts:480`).
2. `run:load` reads the pinned bundle.
3. `executeWorkflow` (`workflows/executor.ts:530`) parses the schema only (`process.ts:93`), then runs `runList`.
4. `run:finish` ends the run.
- The adapter is `cloudflareStepRunner` (`runs/step-runner.ts:103`). It caps results at 960 KiB and maps a timeout to `WaitTimeoutError`.

**Step kinds** (`executor.ts:801`)
- **read / skill / write:** `workStep` (`:1170`): `approverPlan`, then `gateApproval` and `when`, then `work`, then `attempt` inside `do(name)` (STEP_CONFIG: 3 retries, 15 min). Then the approval/wait loop, `needsHelp`, sign-off and notify.
- **person:** `:2677`. **if** by rules: `:3029`. **if** by the agent: `:3069` (ChoicePort).
- **for_each:** at most 200 items, prefix `${name}:${i}:`.
- **repeat:** `maxTimes` at most 10; each pass is prefixed `${name}:r${p}:`, with `:wait` and `:until`.
- **notify:** `:2388`. **handoff:** `:3469`. **process:** `:3559`. **stop:** `:4035`. **conversation:** `:2833`.

**Approval: pause and resume**
1. `decideApproval` (`:1802`) calls `awaitResolution` (`:2084`): `check`, then `waitForEvent('inbox-<id>')`.
2. On timeout, it expires the item and holds for undo.
3. Modes: in_turn, any, all.
4. Resume: `${base}:resume` → `agent.resume` (`ports.ts:557`) → `approveForRunTx` and `executeAction`.
5. The resolution event is sent by the inbox resolve (`inbox.ts:309-318`) and re-sent by the cron (`runs/resume.ts`).

**How test runs are kept from writing:** `actions.ts:712` and `call-tool.ts:780` give `would_have_done`; `settle` marks it `notWritten` (`executor.ts:1087`). Notices, hand-offs and reach-outs are skipped; person items go to the operator; `emit` writes nothing.

**Run states:** queued → running → succeeded | failed | cancelled. "Waiting" is computed from open inbox items.

**Step states:** running → waiting → succeeded | failed | skipped. Retries set the row back to running and add an attempt.

**Validation**
- Process `safeParse` at load, `InboxResolution.parse`, `NeedsHelp.safeParse`, `PendingState.parse`, and tool input `safeParse`.
- Step outputs are capped in size but not checked against a schema by the executor.
- Choosing a path: `choosePath` (`choose.ts:239`) with an enum of allowed paths, `pickedPath`, and an intersection in the executor.
- Ending a repeat: `judgePass` (`choose.ts:294`).

**Where the builder and executor can disagree**
- The executor never calls `validateProcess`, only the schema parse. Test runs can run any draft.
- `SkillStep.agent` is allowed by the validator (`validate.ts:1306-1312`) but ignored by the executor (`ports.ts:321`).
- `durableEstimate` (`validate.ts:1996`) underestimates; the size check runs only when there's a repeat.
- Step ids `wait` and `until` are allowed (`schemas/common.ts:19`) and collide inside a repeat (`executor.ts:3312, 3337`).
- Converted v3 steps keep v3 approval semantics.

### 5.4 API routes, auth, audit, isolation and secrets

**Guards**
- Middleware on `/api/*`, in order: `securityHeaders`, `requestOrigin` (a CSRF check on non-GET, exempt list at `request-origin.ts:22-38`), `mobileSession`, `requestState`.
- `routeFamily` (`core/api/contract.ts:59`): `/api/ops` is "ops", everything else is "portal". Each of the 650 specs has roles. Every ops spec is operator-only, no portal spec allows the operator role, and 52 are public.
- `mountWith` (`http.ts:715`):
  1. identify;
  2. the second factor;
  3. the removed-phone check;
  4. `scopeOf` (`requireRole` + `tenantScope`);
  5. `checkScope` (a portal session must have exactly one client);
  6. `withSession`;
  7. the handler;
  8. `auditInTx`. Errors go to `auditAlone`.
- `invokeRoute` (`http.ts:1002`) serves mcp, reggie, build, deal and todo.
- MCP (`mcp/routes.ts:296`): a bearer JWT, a rate limit, and an approval link as the second factor.

**Not mounted**
| Route | Auth | Audit | Tenant |
|---|---|---|---|
| GET /api/session | getSession | none | withTenant |
| /api/auth/sign-in, callback | WorkOS state | sign_in | — |
| POST /api/start/:token/signed-in (welcome.ts:141) | getSession + HMAC | auditAlone | link tenant; **skips the removed-phone check** |
| welcome, forms, text-signup, /api/preview/:token | HMAC token | none, by decision | token tenant |
| GET /api/files/:token (documents.ts:591) | HMAC, 5 min | **none** | none (R2 key from the token) |
| /api/mobile/* | PKCE, flag | session only | — |
| second factor and setup links | step cookie | yes | — |
| /api/hooks/:tenantId/:hookId | token or HMAC | none (system) | withTenant |
| provider webhooks (gchat, teams, meta, zoho, qbo, bankfeed, stripe, twilio, voice, elevenlabs) | signatures | none | withTenant |
| /api/in/:pack/:tenantId/:target | none (beacon) | none | withTenant(path) |

Email in (`index.ts:24`, `email.ts`, `mail-route.ts`) is system work. It is routed, in order, to: codes, release reply, reach-out reply, back office (support@ and hello@), voice sample, Sloan, the agent address, forwarding.

**Tenant scope**
- Portal: the active client comes from `?client=` or the header, or the user's only membership. `withSession` throws if a non-operator doesn't have exactly one client. Agent-limited users go through `core/api/assigned.ts`.
- Operator: `servedTenantIds`; `withOperator` sets `app.operator=on`. Handlers call `ensureClient`.
- The account carried in the cookie (`ACCOUNT_WINDOW_SEC = 300`, `auth/account.ts:18`) means a revoked membership works for 5 minutes.
- Runs: `withTenant(db, tenantId)` per run and per cron client. The back-office email path uses `withOperator` over all live clients.

**RLS**
- Every table with `tenant_id` has RLS enabled and forced.
- `tenant` and `app_user` have no RLS and are writable by `cs_runtime`.
- Operator tables are keyed by `client_id`: build, deal, todo, reggie_action, client_file, client_fact.
- user_factor, user_recovery_code, mcp_session_approval and sign_in_approval use `user_id = app_user_id() OR app_is_operator()` (`0042:60-80`, `0067:39`).
- `audit_event` rows with a null tenant can be read by any operator.
- Lookups by id only (RLS but no tenant filter): `autopilot.ts:53`, `owners.ts:239`, `qbo.ts:219`, `browser-scripts.ts:80`, `ops-automations.ts:306`, `ops-skills.ts:260`, `access.ts:324`, `billing.ts:439,539`, `deals.ts:157-161`.

**Secrets**
- Envelope v2 under the client's key, wrapped by `ENCRYPTION_KEY` (`apps/api/src/secrets.ts`). Rewrapped hourly.
- Written by: `portalSetCredentials` (`access.ts:410`), the OAuth callback (`connections.ts:567`), webhook setup, Twilio provisioning, `reach.ts`.
- Decrypted in: the hooks, the pickers, `runs/execute.ts` `credentialsFor` (one step), `browser/scripts.ts:412`.
- `GET /api/connections/:id/webhook` (`webhook-setup.ts:52-71`) shows hook tokens and the signing secret again on every read (a documented exception).

**Matrix and grants**
- Stored in `connection.permissions` with `connection_change`, and in `agent_grant`.
- Portal: `portalTightenPermissions` (`portal.ts:1080`) and `portalSetGrant` (`access.ts:354`, refuses loosening).
- Ops: `opsUpdateConnection` (`ops-clients.ts:932`, may loosen, and **writes `body.config` verbatim**, `:948`) and `opsSetAgentGrant`.
- Both matrix paths call `applyMatrixChange` (`connectors/permissions.ts:155`).
- Strictest wins in `decideToolCall` (`core/permissions/decide.ts:56`). Its callers: agents call-tool, actions, planned, and `apps/api/src/calls/answer.ts:343`.
- `STRICTNESS` is copied in `core grants.ts:49`, `decide.ts:113`, `entities.ts:22`, `directory/autonomy.ts:21`, `connectors/permissions.ts:21`, and `web connections/matrix.ts:14`.

### 5.5 Web: back office and portal

**Route tables:** `apps/web/src/portal/routes.tsx` and `apps/web/src/ops/routes.tsx`. Calls go through `apiRoutes.*` and `useApi`.

**Portal screens**
| Route | File | Key API |
|---|---|---|
| `/` | portal/screens/Home.tsx | portalTable, portalOverview, ownerRename |
| `/inbox` (the Desk) | Inbox.tsx, desk/DeskDetail.tsx, DeskList.tsx | portalInbox ×3, portalResolveInbox, portalBatchResolve, portalSnoozeInbox, portalUndoInbox, portalEditInbox |
| `/accounts` (+ `#vault`) | Accounts.tsx, accounts/vault.tsx, connections/MatrixTable.tsx | portalConnections, portalAccess, portalAuthorize, portalDisconnect, portalTightenPermissions, portalSetCredentials, portalSetUpBrowser, portalSetGrant |
| `/connections/:c/callback` | OAuthCallback.tsx | portalAuthorizeCallback |
| `/reports/:pack/:report` | Reports.tsx, packs/screens.tsx | portalPackReport |
| `/requests` | requests/* | portalWorkRequests, portalRaiseRequest |
| `/settings/*` | Settings.tsx, approvals/ApproverRules.tsx, Team.tsx | |
| `/runs`, `/agents/:id`, `/start` | Runs.tsx, Agent.tsx, GettingStarted.tsx | |

**Back-office screens**
| Area | File | Notes |
|---|---|---|
| connections | ops/screens/Connections.tsx | the operator's matrix |
| client settings | ClientSettings.tsx | |
| client overview and owners | ClientOverview.tsx, ClientOwners.tsx | |
| runs | Runs.tsx, RunView.tsx | |
| inbox | Inbox.tsx | |
| merge | merge/MergeScreen.tsx | |
| agent tabs | VersionsTab.tsx, TestsTab.tsx (test bench), GoLivePanel.tsx, PricePanel.tsx, GrantsPanel.tsx | |
| packs | packs/opsScreens.tsx | |

**Portal flows**
- **Connecting by OAuth:** `startConnect`, then the provider, then `/connections/:c/callback`, which posts every query parameter once and goes to `/accounts`.
- **The vault:**
  - The key form keeps input on error.
  - Browser setup needs a confirm checkbox, plus a code on TOTP sites.
  - The grant editor offers only stricter levels.
- **The matrix:** drafts are saved row by row.
- **The Desk:**
  - It loads three lists and polls the open one every 20 s.
  - `act()` shows the error. On `changed` it reloads.
  - Each item carries its fingerprint.
- **Reports:** an unchecked cast `as T`.

**Rules implemented twice**
| Rule | Web | Server |
|---|---|---|
| Matrix strictness | connections/matrix.ts:14 | permissions.ts:155, core grants.ts:48. `STRICTNESS` is also copied in core decide.ts:113, entities.ts:22 and directory/autonomy.ts:21 |
| Grant tightening | vault.tsx:915 | core grants.ts:96 |
| Approval default | ops/run/checklist.ts:93, ops/workflow/describe.ts:347 | the workflow schema |
| Price regex | PricePanel.tsx:21, Billing.tsx:314, BillingStatement.tsx:31 | core money.ts:13, api/billing.ts |
| Intake money | GettingStarted.tsx:185 (no 10-digit cap) | |
| Units | packs/materials/types.ts:99 | packs/materials/src/schema.ts:50 |

The API client (`api/client.ts:147`) checks each body against the route's Zod schema, then sends the raw body, not the parsed one.

**Tests**
- jsdom with `fakeApi(routes)` (`src/test/fixtures.ts:238`), plus `CLIENT_SESSION` and `OPERATOR_SESSION`.
- Example: `portal/screens/Accounts.test.tsx:160`.

### 5.6 Packs

**Wiring**
- `apps/api/src/packs.ts`: `DEPLOYMENT_PACKS`, `adapt()`; only tools that declare `usesModel` get a model transport.
- Inputs are parsed in `defineTool` (`packs/materials/src/tools.ts:157`); outputs are checked at `call-tool.ts:409`.
- Routes are `apps/api/src/routes/packs.ts`, `pack-inbound.ts` and `pack-preview.ts`, all through `mount()`. Ops routes call `ensureClient`; portal routes use `tenantIds[0]`.
- Layering is clean: no platform package imports a pack.

**Tables:** all 39 pack tables have `tenant_id` with ENABLE and FORCE RLS. The `alert` table has a DB check that `evidence` is not empty (`schema.ts:4574`).

**Materials**
- Tools are all `none` or `internal`; there are no `external` tools.
- Model-backed tools: catalog.create_item, match_line(s), vendor_item.upsert, embeddings, similar/candidates.
- `vendor.qbo` updates the platform `vendor` table.
- Skills: tool-mode wrappers; review-merge (agent mode, proposes only); task-mode model skills (read-request, read-quote, read-contract, invoice-review, …).
- The template "Vendor contracts and invoice review" has approval required.

**Bookkeeping**
- Tools: read and internal (import, settle, propose, posted, reconcile).
- QuickBooks writes are connector tools in `template.ts`, with `APPROVAL_REQUIRED` (`:546`).
- Task skills: propose-accounts, suggest-matches, read-statement-document.
- The feed import runs nightly at 04:16 UTC.

**Marketing**
- Tools: read and internal (drafts, report.record).
- Publishing goes only through `website.publish` via a person's `signedWrite` (`content/publish.ts:120`).

**Setup**
- Enable (`routes/packs.ts:535`): `tenant_pack` with `onConflictDoNothing`, and the templates installed once deployment-wide.
- Re-enable does nothing. There is no disable route.
- Publish checks `requiresPacks` (`agents.ts:1142`).

**Money, units and dates**
- Money is `numeric(14,4)` in the DB and a string with `dec()` in code. No floats were found.
- Units (`pricing/uom.ts`): a line whose unit has no rule gets no price. A line with no unit is treated as the standard unit and marked `uomAssumed` (`:291`).
- Price rules filter on the same standardUom and currency. A merge refuses different standardUom (`merge.ts:45`).
- Bookkeeping settle matches an exact amount, the same currency and ±3 days. Reconciliation is decimal with tolerance 0.
- Dates are UTC `yyyy-mm-dd`; the client's time zone is never used.

**Model calls**
- `materials/src/catalog/model.ts`: `modelParse` and `adjudicate` put vendor text inside `<line>` tags with a "data" rule.
- Hard rules veto the model in `adjudicateLine` (`match.ts:298`).

**Marketing collector:** `POST /api/in/:pack/:tenantId/:target` (`pack-inbound.ts`)
- Not mounted: no session, no audit row, always 204.
- Checks the params with Zod and rate-limits per IP (120/min).
- The pack must be on, the body is capped at 16 KB, and the Origin must equal the site's domain (forgeable).
- DNT or GPC means nothing is stored.
- `parseBeacon` checks fields by hand. There's a cap of 500 events per visit per day, and the visit is a hashed salt.
- Retention runs nightly.

### 5.7 Code service and browser service

**Website login flow**
1. **Site profile.** The operator writes it (`apps/api/src/routes/browser.ts:66-139`; schema `core/browser/site.ts:457`). It sets 1–5 exact `login.origins`.
2. **Client setup.** `portalSetUpBrowser` (`routes/browser.ts:142`):
   - refuses the blocked tier;
   - calls `codes.createIdentity`, then `addPhone` (a Twilio number) or `setAuthenticator`;
   - inserts the connection, pinned to the site version.
3. **Vault entry.** The client admin enters the login through the write-only route (`routes/access.ts:421-475`).
4. **Tool call.** It goes to `withBrowserSession` (`connectors/src/browser/session.ts:220`): the tier check, the credentials read, the redactor seeded, the caps checked. Then `BROWSER.open({hosts})` (`apps/api/src/browser/driver.ts:34` to `apps/browser/src/service.ts:95`).
5. **Opening the browser.** `open` checks the input with Zod, refuses blocked hosts, and launches Browser Run with guardrails: `allowedDomains` plus common CDNs, no downloads, no service workers.
6. **Sign-in** (`connectors/src/browser/sign-in.ts:189`):
   - go to the login URL and check the origin;
   - open a code wait before submitting (TTL 180 s);
   - fill the username and password with `onlyOn: login.origins`;
   - submit;
   - `claimCode` polls 45 × 2 s;
   - add the code to the redactor and fill it.
7. **apps/mfa** (`identity.ts`):
   - `openWait` (`:278`) checks the client owns the identity and the daily cap.
   - `receive` (`:465`) takes an inbound SMS (Twilio-signed) or email (SPF, DKIM, DMARC; `EMAIL_CODES` is off everywhere). The first matching open wait gets the code, sealed with AES-GCM.
   - `claim` (`:340`) closes the wait synchronously, so a code is handed out once. It answers `expired` past the wait's expiry.
   - An alarm cleans up after 10 min.
8. **Session.** On the low tier with `session.keep`, the cookies are kept in the vault. Otherwise it signs out. The browser is always closed, and a `connection_change` row is written.
9. **Tool work.** `checkBrowserUrl` runs before and after navigation. Text and tables are redacted, and the result is deep-redacted.

**How each service checks its caller**
- apps/mfa: reached only through the `CODES` service binding. The `tenantId` the caller sends is checked against the identity.
- apps/mfa public fetch: `/health`, and `POST /twilio/sms/:id` (HMAC-SHA1, `constantTimeEqual`, AccountSid). No replay protection.
- apps/browser: `fetch` answers 404; the entrypoint is reachable by binding only.

**When a service is down**
- No CODES binding: setup answers 503, and sign-in answers `BrowserRefused`.
- An RPC throw or `daily_cap` during `openWait` or `claim` counts as a sign-in failure. Two failures stop the connection (`session.ts:306-320`).
- No BROWSER binding: `BrowserRefused`. Other browser errors are thrown raw, with no failure counted.

**Origin pinning and the blocked tier**
- Pinning compares `new URL(url).origin` exactly (`site.ts:391`). Userinfo is refused.
- `checkBrowserUrl` (`site.ts:353-376`) checks, in order: the blocked host, https only (http only on loopback), the block lists, then the allow globs.
- The blocked tier is a list of about 75 domains plus their subdomains, with a copy in `apps/browser/src/blocked.ts` kept equal by a test. These checks see the main frame only.

**What the model sees**
- Page text, tables and downloads come back as a JSON `tool_result`, never in the system prompt.
- `readText` leaves out password, hidden and one-time-code inputs. Other inputs read as their values.
- Redaction covers the password, the code and cookies of 8 characters or more. Screenshots are not redacted.

**Tests**
- Node `vitest run`, plus the workerd config. mfa's `codes.runtime.test.ts` covers a single claim, expiry, DMARC, the cap, signed SMS and TOTP.
- `connectors/src/browser/fake.ts` provides a fake CodesService and driver.

### 5.8 Phone and desktop apps

**The API has no desktop routes yet.** No `/api/desktop/*`, no migration, no `desktop_device` or `desktop_job` table, and the desktop connector isn't registered in `platform.ts` (`docs/open.md` D2–D3). The app treats a 404 as "not built yet" (`apps/desktop/src/main/controller.ts:328`).

**Mobile sign-in** (all 404 unless `MOBILE_SIGNIN=on`)
1. `GET /api/mobile/sign-in?challenge=` takes a PKCE S256 challenge, starts WorkOS and sets a sealed start cookie (`routes/mobile.ts:104-120`).
2. `GET /api/mobile/handoff` turns away operators, sends the person to the second factor if it's pending, then redirects to `mezonas://signed-in?code=`. The code is a sealed `{session, challenge}` that lasts 120 s (`:123-155`).
3. `POST /api/mobile/session` redeems the code against the verifier (timing-safe) and returns the sealed session.
4. After that, every request carries `x-mezonas-session`. The middleware (`routes/mobile.ts:51-61`, `app.ts:224`) turns it into the cookie, and the origin check lets any request with this header through (`request-origin.ts:92`).

**Phone signing**
- The key is P-256 in SecureStore, read behind Face ID (`apps/mobile/src/state/store.ts:104-118`). It's a software key, not the Secure Enclave.
- `POST /api/inbox/:id/resolve` (`apps/api/src/routes/portal.ts:932-994`) works in this order:
  1. A phone session must send a `deviceSignature`.
  2. The item is locked.
  3. `checkDeviceSignature` (`mobile/devices.ts:212-260`) checks the device, the time (±300 s), the fingerprint and the ECDSA signature.
  4. The audit row is written.
  5. `resolveInboxItem` runs, the same gate path the browser uses.
- Other routes that decide refuse phone sessions.

**Desktop, client side only**
- Signing is ECDSA P-256 over `mezonas-desktop:v1\ndevice\nMETHOD\npath\nsha256(body)\nat`, allowing ±300 s and with no nonce (`packages/core/src/desktop/protocol.ts:33,67-80`).
- Jobs go through `runJob` (`apps/desktop/src/main/jobs.ts:61-100`). Paths go through `resolveInFolder` (`guard.ts:53-92`).

| Route | mount / audit | Tenant |
|---|---|---|
| sign-in, handoff | plain `app.get`, no audit (D7 open) | none |
| POST /api/mobile/session | mountPublic + auditAlone | none |
| /api/me/devices*, /api/me/push* | mount (client roles) | exactly one |
| resolve + device signature | mount + auditInTx | one |
| sign-in approvals | mountPublic + auditAlone | withTenants([phone.tenantId]) |

## 6. Invariants with no test coverage today

Checked by each lens with grep over the existing `*.test.ts` and `*.test.tsx`. The qa repros cover each gap below; none of them is in CI yet.

| Invariant | What no test checks today |
|---|---|
| 1 / I1.4 | That operator sessions are scoped on person tables (`user_factor`, `user_recovery_code`, `sign_in_approval`, `mcp_session_approval`). The existing test asserts every operator sees them all. |
| 1, 9 | SPF and DMARC on back-office mail (support@, hello@). The existing test passes only because its fixture has no auth header. |
| 4 / I4.2 | A skill step with `agent` run through the executor or agent port. Step ids that collide with the executor's own names (`until`, `wait`, `:r<n>:`). How `durableEstimate` compares with the durable steps actually taken. |
| 5 | Fail-closed skill schemas (a schema Zod can't read). Malformed or partial 200 answers from OpenAI, xAI or Gemini, and a missing usage block. Bad attachments sent to agent or Sloan addresses. `pgStatus` for 22003 and 22008. Web forms held to core's money and credit schemas. |
| 6 | Mixed currencies in reconcile and `data.list.group`. Number and money fields in the Desk edit form. Getting started money with "$" or ",". |
| 7 / I7.2 | That `matches.record` and `vendor_items.register` re-apply the hard rules to an incoming "matched". |
| 8 / I8.1 | A takeover of a connector create that has no idempotency key (Zoho). A reconnect to another account while actions are approved. |
| 8 / I8.3 | That the materials `vendor_item.upsert`, `set_preferred`, `discontinue` and `catalog.create_item` keep nothing in a test run. The `web.fetch` link scope. |
| 8 / I8.5 | The safety hold on the inbound-call path (`calls.test.ts` never mentions `hold`). |
| 8 / I8.6 | That a promotion or copy keeps approval on (`mode`, `not_required`). Forking only a published version of the same template. |
| 8 / I8.7 | Delete-like writes under other verbs (Odoo `active`). |
| 8 / I8.8 | A reject and an approve in the same round in `any` mode. Partial failure of batch undo or snooze. |
| 9 / I9.1 | Tag-closing text in the materials matching prompts and the charter draft prompt. |
| 10 / I9.2 | Where a "human" match decision came from. |
| 11 / I11.2 | Agent-limited users in Sloan's account views and in document detail. |
| 13 / I13.1 | Provider or vendor error text (Twilio, the OAuth `?error=`) kept off the portal. `OAuthCallback.test.tsx` asserts the pass-through. |
| 13 / I13.2 | A replayed inbound text at apps/mfa. A stale code wait taking the next sign-in's code. A code-service outage or `daily_cap` during a browser sign-in. |
| 13 | That the desktop guard leaves nothing behind when it refuses. Per-connector validation of the operator's `config` write. That non-secret page data survives browser redaction. |
| 14 | Card-number redaction in threads, issues, `tool_call` and `external_action`. |
| R1 | Notices and internal tool writes under an engine retry. Only external actions and oversight have retry tests. |
| R2 | 429 and 4xx on Google Chat, Twilio and Meta followed by a retry of the same key. A LinkedIn refresh failure before a post. That a connector's `retryable` flag is ever acted on (it is read only by `apps/api/src/qbo/sync.ts:376`). |
| R4 | Two concurrent cron passes or `startRun`s. |
| Calls | Publishing a draft older than the live version. Concurrent set-up of a browser login. |
