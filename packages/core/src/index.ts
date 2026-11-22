// @countersign/core: domain types and Zod schemas (agent bundle, skill, workflow steps and rules,
// tool, connector, pack, events), workflow validation and template typing, rules → JSONLogic,
// bundle diff and three-way merge, canonical hashing, ids, money, roles and the API route contract.
// Pure: no I/O and no Node/DOM/Workers-only APIs, so it runs in the browser, the Worker and Node.
// Allowed workspace dependencies: none. See docs/plan.md §2.

// v0.12 W2-D: Sloan, the account agent
export * from "./account/changes";
export * from "./account/guard";
// §1.150: Sloan by email and text
export * from "./account/reach";
export * from "./account/views";
export * from "./account/words";
export * from "./api/a2p";
export * from "./api/access";
export * from "./api/account";
// docs/builder-plan.md §7 (B5): client adjustments and feedback on the manual
export * from "./api/adjust";
export * from "./api/all-routes";
export * from "./api/approver-rules";
export * from "./api/assigned";
// docs/plan.md §1.168: Draft for long text fields
export * from "./api/assist";
// v0.12 W2-B: automations
export * from "./api/automations";
// docs/plan.md §1.124.4: Reggie and Autopilot.
export * from "./api/autopilot";
// v0.12 bankfeed
export * from "./api/bankfeed";
export * from "./api/billing";
export * from "./api/browser";
export * from "./api/browser-scripts";
// docs/plan.md §1.108: builds, from intake to go-live
export * from "./api/build";
// v0.12 W3-A: the Builder as a conversation
export * from "./api/builder";
export * from "./api/calls";
// docs/plan.md §1.149: onboarding v1 (client files and starts)
export * from "./api/client-files";
// v0.12 W2-G: KPIs and the client view, credits, the client's audit export
export * from "./api/client-view";
export * from "./api/code-requests";
// v0.12 W2-F: the command center, search and plain-words questions
export * from "./api/command-center";
export * from "./api/compliance";
// Connectors C4 (docs/connectors-plan.md §3, §7): the Connectors place, change requests, panels.
export * from "./api/connector-access";
// v0.12 W2-A: the connectors catalog
export * from "./api/connectors";
export * from "./api/contract";
// v0.14 capture
export * from "./api/conversations";
// docs/plan.md §1.124: back office work (Sales)
export * from "./api/deals";
// v0.12 W1-D: the Desk
export * from "./api/desk";
export * from "./api/directory";
export * from "./api/documents";
export * from "./api/excel";
export * from "./api/exports";
export * from "./api/feedback";
// v0.14 W4-E: Google Chat
// docs/plan.md §1.121: forms, "Request info"
export * from "./api/forms";
export * from "./api/gchat";
// v0.14 W4-D
export * from "./api/gsheets";
// R4: business hours, person hours and channels (docs/plan.md §1.86).
export * from "./api/hours";
// docs/plan.md §1.149: onboarding v1 (the intake, the welcome page, Invite and Sign up now)
export * from "./api/intake";
export * from "./api/invite";
export * from "./api/knowledge";
export * from "./api/language";
export * from "./api/ledger";
// R8: the Library's banks (docs/plan.md §1.86).
export * from "./api/library";
// v0.12 W1-A: go-live stages and client controls
export * from "./api/lifecycle";
export * from "./api/manual";
export * from "./api/messaging";
// §1.116: the phone app
export * from "./api/mobile";
export * from "./api/models";
// v0.12 W1-B: notifications, the Table and the Weekly Table
export * from "./api/notify";
export * from "./api/onboarding";
export * from "./api/operators";
// v0.13 W2-I: run oversight
export * from "./api/oversight";
// v0.19: area owners (ARCHITECTURE §10.15)
export * from "./api/owners";
export * from "./api/packs";
export * from "./api/people";
export * from "./api/phone-approval";
// The skill model (owner, 2026-11-10)
export * from "./api/prompt-preview";
export * from "./api/qbo";
export * from "./api/reach";
// §1.164: the builder's sample-file check for a Read table step.
export * from "./api/read-table";
export * from "./api/records";
export * from "./api/reggie";
export * from "./api/requests";
export * from "./api/reshape";
export * from "./api/routes";
// Wave 6: the audit queue, marks, stats and sampling settings (docs/plan.md §1.86).
export * from "./api/run-audit";
// R8: what a run's rows say about a step's checks (docs/plan.md §1.86).
export * from "./api/run-checks";
// v0.12 W1-E
export * from "./api/run-controls";
// UI cleanup (stream A)
export * from "./api/run-state";
export * from "./api/run-subject";
// v0.12 W2-F
export * from "./api/runs-ask";
export * from "./api/runs-filter";
// v0.12 W2-F
export * from "./api/search";
export * from "./api/second-factor";
// docs/builder-plan.md §6 (B4): the setup checklist
export * from "./api/setup";
export * from "./api/skill-model";
// v0.14 W4-C: the Slack channel picker
export * from "./api/slack";
// §1.150
export * from "./api/sloan-reach";
export * from "./api/sop";
export * from "./api/step-code-request";
export * from "./api/step-data";
// P-6
export * from "./api/step-in";
export * from "./api/supervisor";
export * from "./api/table";
export * from "./api/teams";
// v0.12 W2-C: the test bench
export * from "./api/testbench";
export * from "./api/text-signup";
export * from "./api/threads";
// docs/plan.md §1.124.3: Your call
export * from "./api/todos";
// P-7: message translation
export * from "./api/translation";
// v0.12 W2-E
export * from "./api/triggers";
// R5: the Undo a late no is offered
export * from "./api/undo";
export * from "./api/usage";
// docs/plan.md §1.109: voice typing
export * from "./api/voice";
// v0.14 W4-A: WhatsApp through Meta
export * from "./api/whatsapp-meta";
// docs/plan.md §1.124: back office work (Build).
export * from "./api/work";
// v0.14 W4-B
export * from "./api/zoho";
export * from "./approvals/rules";
export * from "./assist/fields";
export * from "./assist/prompt";
// P-3: attachments both ways
export * from "./attachments";
export * from "./billing";
export * from "./browser/script";
export * from "./browser/site";
export * from "./build/build";
export * from "./build/code-request-words";
export * from "./build/code-requests";
export * from "./build/decisions";
export * from "./build/gap-steps";
export * from "./build/issues";
// BUILDER_QA CONS-6: a draft's problems counted the same on the build and in the builder
export * from "./build/problems";
export * from "./bundle/client-specific";
export * from "./bundle/diff";
export {
  buildEntity,
  type Entity,
  type EntityKind,
  type FlatBundle,
  flattenBundle,
  unflattenBundle,
} from "./bundle/flatten";
export * from "./bundle/merge";
// R8: the builder reads stored v3 workflows as v4 processes (ids kept).
export * from "./bundle/normalize";
export * from "./bundle/select";
// v0.12 W3-A: closest templates
export * from "./bundle/similarity";
export * from "./calls/rules";
export * from "./canonical";
export * from "./codes/service";
export * from "./compliance/card-numbers";
export * from "./compliance/controls";
export * from "./compliance/processors";
// P-4: conversations with people
export * from "./converse";
export * from "./desk/item";
export * from "./desk/rules";
// The Mezonas desktop app (docs/plan.md §1.151): folders, jobs and the computer's signed requests.
export * from "./desktop/a1";
export * from "./desktop/paths";
export * from "./desktop/protocol";
export * from "./directory/autonomy";
export * from "./directory/invite";
export * from "./directory/kinds";
export * from "./directory/language";
export * from "./directory/rows";
export * from "./directory/schemas";
export * from "./directory/search";
export * from "./directory/voice-samples";
export * from "./documents/extraction";
// §1.164: table files (.csv, .xlsx, .json) as documents.
export * from "./documents/tables";
export * from "./duration";
// Inbound email: whose verdicts count, and which mail is automatic.
export * from "./email/authentication";
// docs/plan.md §1.149: the branded layout and the onboarding emails.
export * from "./email/layout";
export * from "./email/onboarding";
export * from "./email/second-factor";
// docs/plan.md §1.121: forms, "Request info"
export * from "./forms";
// docs/builder-plan.md §8 (B6): governance in tiers
export * from "./governance";
// v0.19: area owners (ARCHITECTURE §10.15)
export * from "./help/guide";
// v0.12 W2-E
export * from "./holidays/us";
export * from "./i18n/desk";
export * from "./i18n/forms";
export * from "./i18n/gmail-test";
export * from "./i18n/lifecycle";
export * from "./i18n/locale";
export * from "./i18n/notify";
// docs/plan.md §1.149: the onboarding emails' and the welcome page's words.
export * from "./i18n/onboarding";
// v0.13 W2-I
export * from "./i18n/oversight";
// v0.19: area owners (ARCHITECTURE §10.15)
export * from "./i18n/owners";
export * from "./i18n/release";
// P-6
export * from "./i18n/step-in";
export * from "./i18n/supervisor";
export * from "./i18n/threads";
export * from "./i18n/timeline";
export * from "./i18n/weekly";
export * from "./ids";
export * from "./json";
// v0.12 W2-G: agent KPIs
export * from "./kpi/format";
export * from "./kpi/period";
export * from "./kpi/schema";
export * from "./kpi/validate";
// Worker startup (2026-11-11): definitions built on first read.
export * from "./lazy";
// B-2 (docs/plan.md §1.79): the ledger's tools.
export * from "./ledger/schemas";
export * from "./lifecycle/pause";
export * from "./lifecycle/stage";
// docs/builder-plan.md §5 (B3): the agent manual
export * from "./manual/manual";
export * from "./mappers/qbo";
export * from "./mappers/upload";
// P-8: US texting registration
export * from "./messaging/a2p";
export * from "./messaging/calling";
export * from "./messaging/rules";
export * from "./messaging/signup";
export * from "./mobile/mobile";
export * from "./money";
export * from "./notify/notify";
export * from "./notify/render";
// docs/plan.md §1.149: onboarding v1 (the client file, starts, the guide, the intake).
export * from "./onboarding";
// Wave 6: the owner's check on every step, and which runs go to a person's audit
export * from "./oversight/check";
// v0.13 W2-I: run oversight
export * from "./oversight/decision";
export * from "./owners/areas";
export * from "./owners/definition";
export * from "./owners/names";
// Connectors C4 (docs/connectors-plan.md §5.4, §7): a change's rows and direction, who may set it.
export * from "./permissions/change";
export * from "./permissions/decide";
export * from "./permissions/entities";
export * from "./permissions/explain";
export * from "./permissions/grants";
// Connectors C1 (docs/connectors-plan.md §4): an agent's needs, the gaps, allowing what it needs.
export * from "./permissions/needs";
export * from "./permissions/release";
// R1: processes, workflow schemaVersion 4 (docs/plan.md §1.86, §9), as the `processes` namespace.
export * as processes from "./process";
export * from "./process/change-class";
export * from "./process/numbers";
// Agent motion (docs/plan.md §1.106): the thinking state a running step shows.
export { THINKING_STATES, type ThinkingState, thinkingOf } from "./process/thinking";
// Invariant 9: what a prompt puts between its tags can't close them.
export * from "./prompt-data";
export * from "./reach/rules";
export * from "./roles";
export * from "./rules/compile";
export * from "./run-audit/sampling";
export * from "./schemas/agent";
export * from "./schemas/approval";
// v0.12 W2-B
export * from "./schemas/automation";
export * from "./schemas/common";
// Connectors C3: change requests and Changes by Mezonas (docs/plan.md §1.161)
export * from "./schemas/connection-requests";
export * from "./schemas/connector";
// v0.14 capture
export * from "./schemas/conversation";
export * from "./schemas/event";
export * from "./schemas/json-schemas";
export * from "./schemas/pack";
export * from "./schemas/permissions";
export * from "./schemas/rules";
export * from "./schemas/skill";
// The skill model (owner, 2026-11-10): parameters, rule rows, kinds, models, versions, writes.
export * from "./schemas/skill-model";
// §1.164: a table file's expected columns (the `columns` skill parameter).
export * from "./schemas/table";
export * from "./schemas/tool";
export * from "./schemas/tool-display";
export * from "./schemas/workflow";
export * from "./security/session-limits";
export * from "./setup/adjust";
export * from "./setup/adjustable";
export * from "./setup/checklist";
export * from "./setup/item";
export * from "./setup/view";
export * from "./skills/index";
// docs/sop-plan.md: the agent's SOP, made by code from its setup, and its revisions
export * from "./sop/index";
export * from "./supervisor/health";
// §1.164: reading and writing table files, outside `processes` (kept out of the web first load).
export * as tableFiles from "./tables";
export * from "./template/template";
export * from "./template/typer";
// v0.12 W2-C: the test bench
export * from "./testbench/case";
export * from "./testbench/match";
export * from "./testbench/suite";
// BUILDER_QA INPUT-1, INPUT-3: text Postgres can store, and cutting it on whole characters
export * from "./text";
export * from "./threads/command";
export * from "./threads/schemas";
export * from "./translate/detect";
export * from "./translate/settings";
// v0.12 W2-E
export * from "./triggers";
// Reshape data (2026-11-11): the fixed unit conversions any process may use.
export * from "./units";
export * from "./weekly/schemas";
export * from "./weekly/week";
export * from "./work";
// v0.12 W2-B
export * from "./workflow/automation";
export * from "./workflow/validate";
export * from "./workflow/walk";
