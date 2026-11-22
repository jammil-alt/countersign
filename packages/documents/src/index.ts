// @countersign/documents: Documents capability (ARCHITECTURE §7): store, locate support, extract,
// validate, link. Document text reaches models only as data: inside the extraction request's
// document block here, and inside tool results when agents read it (invariant 9).
// Allowed workspace dependencies: connectors llm senses db core. See docs/plan.md §2.
export * from "./bill";
export * from "./duplicates";
export * from "./extract";
export * from "./find-support";
export * from "./forwarding";
export * from "./get";
export * from "./golden";
// §1.213: file and email intake (report profiles, landing, duplicates, missing reports).
export * from "./intake";
export * from "./knowledge";
export * from "./link";
export * from "./purchase";
export * from "./qbo-bills";
export * from "./store";
// §1.164: table files (.csv, .xlsx, .json) Read table reads and Write table makes.
export * from "./tables";
export * from "./validate";
