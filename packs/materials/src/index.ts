// @countersign/pack-materials: the first agent's domain, built on the platform (ARCHITECTURE §12).
// Exports the pack manifest (tools, skills, events, the Pia template agent and its two workflows),
// tool handlers, Drizzle schema and API routes. src/catalog: normalize, parse, match (§12.3).
// src/pricing: price observations and alert rules (§12.4). apps/api registers it.
// May import core, db, llm, senses, documents, connectors; never agents or workflows.
export {};
