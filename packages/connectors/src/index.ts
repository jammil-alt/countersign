// @countersign/connectors: the connector framework (manifest, tools, registry), connection
// permissions, credential encryption, shared OAuth plumbing and object storage. Connectors: `upload`
// (uploads, purchase CSVs and email forwarding), `browser` (website logins, signed in by code),
// `webhook` (in and out, for Zapier/Make/n8n), `gmail` (send only), `qbo` (QuickBooks Online),
// `zoho_crm`, `podio`, `ramp`, `hubspot`, `gdrive` (Google Drive, only the files we make), `outlook`
// (send only), `slack` (posts to picked channels), `bankfeed` (bank and card feeds through Plaid,
// read only), `gsheets` (Google Sheets, only the sheets the client picks), `gchat` (Google Chat, posts
// to the spaces a client binds; v0.14 W4-E), `gsc` and `bing_webmaster` (search figures, read only;
// M45; `gsc_oauth`, Search Console by Google sign-in, M50), `website` (guides published to a client's own site; M46), `hackernews` (read only) and
// `linkedin` (company page posts, always signed; §1.77), and `testkit`, the test connector. Also
// `stripe/`, Mezonas' own billing client (not a connector: no manifest, no agent tools).
// No Workers, DOM or Node types: Web APIs are reached through ./runtime, R2 through a structural type.
// Allowed workspace dependencies: db core. See docs/plan.md §2.

// P-3: attachments both ways (docs/plan.md §1.65)
export * from "./attachments";
// v0.14 W4-C
export * from "./attempts";
// v0.12 bankfeed: bank and card feeds through Plaid (docs/plan.md §1.52).
export * from "./bankfeed/index";
// M45: Bing Webmaster Tools, read only (docs/plan.md §1.75).
export * from "./bing_webmaster/index";
export * from "./browser/index";
export * from "./connector";
export * from "./credentials";
export * from "./credentials-accessor";
export * from "./elevenlabs/index";
// v0.14 W4-E
export * from "./gchat/index";
export * from "./gdrive/index";
export * from "./gdrive/path";
export * from "./gmail/index";
export * from "./gmail/mime";
// M45: Google Search Console, read only, and the search records both share (docs/plan.md §1.75).
export * from "./gsc/index";
// M50: Search Console by Google sign-in, beside the service account (docs/plan.md §1.78).
export * from "./gsc/oauth";
// v0.14 W4-D: Google Sheets (picked sheets only).
export * from "./gsheets/a1";
export * from "./gsheets/index";
// §1.77: Hacker News, read only (the forum watch).
export * from "./hackernews/index";
export * from "./http";
// v0.12 W3-B
export * from "./hubspot/index";
export * from "./invoke";
// §1.77 (M49): LinkedIn company page posts, always signed.
export * from "./linkedin/index";
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
// v0.12 W3-B
export * from "./ramp/index";
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
// M46: the website guides are published to (docs/plan.md §1.76).
export * from "./website/index";
// v0.14 W4-A: WhatsApp through Meta (docs/plan.md §1.57).
export * from "./whatsapp_meta/index";
export * from "./zoho_crm/index";
