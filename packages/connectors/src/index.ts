// @countersign/connectors: the connector framework (manifest, tools, registry), connection
// permissions, credential encryption, shared OAuth plumbing and object storage. Connectors: `upload`
// (uploads, purchase CSVs and email forwarding), `browser` (website logins, signed in by code),
// `webhook` (in and out, for Zapier/Make/n8n), `gmail` (send only), `qbo` (QuickBooks Online),
// `zoho_crm`, `podio`, `gdrive` (Google Drive, only the files we make), `outlook` (send only),
// `slack` (posts to picked channels), `bankfeed` (bank and card feeds through Plaid, read only),
// `gsheets` (Google Sheets, only the sheets the client picks), and `testkit`, the test connector.
// Also `stripe/`, Mezonas' own billing client (not a connector: no manifest, no agent tools).
// No Workers, DOM or Node types: Web APIs are reached through ./runtime, R2 through a structural type.
// Allowed workspace dependencies: db core. See docs/plan.md §2.

// v0.14 W4-C
export * from "./attempts";
// v0.12 bankfeed: bank and card feeds through Plaid (docs/plan.md §1.52).
export * from "./bankfeed/index";
export * from "./browser/index";
export * from "./connector";
export * from "./credentials";
export * from "./credentials-accessor";
export * from "./elevenlabs/index";
export * from "./gdrive/index";
export * from "./gdrive/path";
export * from "./gmail/index";
export * from "./gmail/mime";
// v0.14 W4-D: Google Sheets (picked sheets only).
export * from "./gsheets/a1";
export * from "./gsheets/index";
export * from "./http";
export * from "./invoke";
export * from "./logger";
export * from "./messaging/services";
export * from "./messaging/spec";
export * from "./oauth/flow";
export * from "./oauth/state";
export * from "./oauth/tokens";
export * from "./outlook/index";
export * from "./permissions";
export * from "./podio/index";
export * from "./qbo/index";
export * from "./records/vendors";
export * from "./registry";
export * from "./release-codes";
export * from "./resend/index";
// v0.14 W4-C
export * from "./slack/index";
export * from "./slack/text";
export * from "./storage/content";
export * from "./storage/memory";
export * from "./storage/object-store";
export * from "./storage/r2";
export * from "./storage/signed-url";
export * from "./stripe/index";
export * from "./tenant-keys";
export * from "./testkit/index";
export * from "./twilio/index";
export * from "./upload/index";
export * from "./voice/services";
export * from "./voice/spec";
export * from "./webhook/index";
export * from "./zoho_crm/index";
