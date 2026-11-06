// @countersign/core: domain types and Zod schemas (agent bundle, skill, workflow steps and rules,
// tool, connector, pack, events), workflow validation and template typing, rules → JSONLogic,
// bundle diff and three-way merge, canonical hashing, ids, money, roles and the API route contract.
// Pure: no I/O and no Node/DOM/Workers-only APIs, so it runs in the browser, the Worker and Node.
// Allowed workspace dependencies: none. See docs/plan.md §2.

// v0.12 W2-D: Sloan, the account agent
export * from "./account/changes";
export * from "./account/guard";
export * from "./account/views";
export * from "./account/words";
export * from "./api/access";
export * from "./api/account";
export * from "./api/approver-rules";
// v0.12 W2-B: automations
export * from "./api/automations";
// v0.12 bankfeed
export * from "./api/bankfeed";
export * from "./api/billing";
export * from "./api/browser";
// v0.12 W3-A: the Builder as a conversation
export * from "./api/builder";
export * from "./api/calls";
// v0.12 W2-G: KPIs and the client view, credits, the client's audit export
export * from "./api/client-view";
// v0.12 W2-F: the command center, search and plain-words questions
export * from "./api/command-center";
export * from "./api/compliance";
// v0.12 W2-A: the connectors catalog
export * from "./api/connectors";
export * from "./api/contract";
// v0.14 capture
export * from "./api/conversations";
// v0.12 W1-D: the Desk
export * from "./api/desk";
export * from "./api/directory";
export * from "./api/documents";
export * from "./api/exports";
export * from "./api/feedback";
// v0.14 W4-E: Google Chat
export * from "./api/gchat";
// v0.14 W4-D
export * from "./api/gsheets";
export * from "./api/knowledge";
export * from "./api/language";
// v0.12 W1-A: go-live stages and client controls
export * from "./api/lifecycle";
export * from "./api/messaging";
export * from "./api/models";
// v0.12 W1-B: notifications, the Table and the Weekly Table
export * from "./api/notify";
export * from "./api/onboarding";
// v0.13 W2-I: run oversight
export * from "./api/oversight";
export * from "./api/people";
export * from "./api/qbo";
export * from "./api/reach";
export * from "./api/records";
export * from "./api/requests";
export * from "./api/routes";
// v0.12 W1-E
export * from "./api/run-controls";
// v0.12 W2-F
export * from "./api/runs-ask";
export * from "./api/runs-filter";
// v0.12 W2-F
export * from "./api/search";
// v0.14 W4-C: the Slack channel picker
export * from "./api/slack";
export * from "./api/supervisor";
export * from "./api/table";
// v0.12 W2-C: the test bench
export * from "./api/testbench";
export * from "./api/threads";
// v0.12 W2-E
export * from "./api/triggers";
export * from "./api/usage";
// v0.14 W4-A: WhatsApp through Meta
export * from "./api/whatsapp-meta";
// v0.14 W4-B
export * from "./api/zoho";
export * from "./approvals/rules";
export * from "./billing";
export * from "./browser/site";
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
export * from "./bundle/select";
// v0.12 W3-A: closest templates
export * from "./bundle/similarity";
export * from "./calls/rules";
export * from "./canonical";
export * from "./codes/service";
export * from "./compliance/card-numbers";
export * from "./compliance/processors";
export * from "./desk/item";
export * from "./desk/rules";
export * from "./directory/autonomy";
export * from "./directory/kinds";
export * from "./directory/language";
export * from "./directory/rows";
export * from "./directory/schemas";
export * from "./directory/search";
export * from "./directory/voice-samples";
export * from "./documents/extraction";
export * from "./duration";
// v0.12 W2-E
export * from "./holidays/us";
export * from "./i18n/desk";
export * from "./i18n/gmail-test";
export * from "./i18n/lifecycle";
export * from "./i18n/locale";
export * from "./i18n/notify";
// v0.13 W2-I
export * from "./i18n/oversight";
export * from "./i18n/release";
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
export * from "./lifecycle/pause";
export * from "./lifecycle/stage";
export * from "./mappers/qbo";
export * from "./mappers/upload";
export * from "./messaging/rules";
export * from "./money";
export * from "./notify/notify";
export * from "./notify/render";
// v0.13 W2-I: run oversight
export * from "./oversight/decision";
export * from "./permissions/decide";
export * from "./permissions/entities";
export * from "./permissions/explain";
export * from "./permissions/grants";
export * from "./permissions/release";
export * from "./reach/rules";
export * from "./roles";
export * from "./rules/compile";
export * from "./schemas/agent";
export * from "./schemas/approval";
// v0.12 W2-B
export * from "./schemas/automation";
export * from "./schemas/common";
export * from "./schemas/connector";
// v0.14 capture
export * from "./schemas/conversation";
export * from "./schemas/event";
export * from "./schemas/json-schemas";
export * from "./schemas/pack";
export * from "./schemas/permissions";
export * from "./schemas/rules";
export * from "./schemas/skill";
export * from "./schemas/tool";
export * from "./schemas/tool-display";
export * from "./schemas/workflow";
export * from "./security/session-limits";
export * from "./supervisor/health";
export * from "./template/template";
export * from "./template/typer";
// v0.12 W2-C: the test bench
export * from "./testbench/case";
export * from "./testbench/match";
export * from "./testbench/suite";
export * from "./threads/command";
export * from "./threads/schemas";
// v0.12 W2-E
export * from "./triggers";
export * from "./weekly/schemas";
export * from "./weekly/week";
// v0.12 W2-B
export * from "./workflow/automation";
export * from "./workflow/validate";
export * from "./workflow/walk";
