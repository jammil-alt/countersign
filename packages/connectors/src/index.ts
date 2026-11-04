// @countersign/connectors: the connector framework (manifest, tools, registry), connection
// permissions, credential encryption, shared OAuth plumbing and object storage. Connectors: `upload`
// (uploads, purchase CSVs and email forwarding) and `testkit`, the test connector.
// No Workers, DOM or Node types: Web APIs are reached through ./runtime, R2 through a structural type.
// Allowed workspace dependencies: db core. See docs/plan.md §2.

export * from "./connector";
export * from "./credentials";
export * from "./credentials-accessor";
export * from "./invoke";
export * from "./logger";
export * from "./oauth/flow";
export * from "./oauth/state";
export * from "./oauth/tokens";
export * from "./permissions";
export * from "./records/vendors";
export * from "./registry";
export * from "./storage/content";
export * from "./storage/memory";
export * from "./storage/object-store";
export * from "./storage/r2";
export * from "./storage/signed-url";
export * from "./testkit/index";
export * from "./upload/index";
