// The per-client knowledge base (docs/plan.md §1.21): FAQs and policies, documents and memory
// notes, searchable with Postgres full-text search.
// DECISION: it lives in packages/documents (the documents capability: store, locate, extract…)
// because documents are most of what it indexes and that layer already reaches db; the
// `knowledge.search` tool in packages/agents reaches it through a port, like `docs.*`.
export * from "./chunk";
export * from "./documents";
export * from "./entries";
export * from "./search";
