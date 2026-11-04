// @countersign/documents: Documents capability (ARCHITECTURE §7): store, locate support, extract,
// validate, link. Document text reaches models only as data: inside the extraction request's
// document block here, and inside tool results when agents read it (invariant 9).
// Allowed workspace dependencies: connectors llm senses db core. See docs/plan.md §2.
export * from "./extract";
export * from "./find-support";
export * from "./get";
export * from "./link";
export * from "./store";
export * from "./validate";
