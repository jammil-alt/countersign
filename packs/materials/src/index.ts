// @countersign/pack-materials: the first agent's domain, built on the platform (ARCHITECTURE §12).
// Exports the pack manifest (tools, skills, events), tool handlers and Drizzle schema. src/catalog:
// normalize, parse, match, learn, merge (§12.3). Pricing and alerts (§12.4), the Pia template and
// her workflows, and the report screens come with M8b. apps/api registers it.
// May import core, db, llm, senses, documents, connectors; never agents or workflows.

export * from "./catalog/keys";
export {
  decideLine,
  type HumanDecisionInput,
  MATCH_CONFIDENCE_AUTO,
  MatchError,
  type MatchLineInput,
  type MatchLineResult,
  matchLine,
} from "./catalog/match";
export { type MergeInput, type MergeResult, mergeItems } from "./catalog/merge";
export { descriptionHash, GLOBAL_ABBREVIATIONS, normalize } from "./catalog/normalize";
export {
  type Attributes,
  CATEGORY_SPECS,
  type CategorySpec,
  detectCategory,
} from "./catalog/parsers";
export { MATERIALS_EVENTS, materialsEventRegistry } from "./events";
export { MATERIALS_HANDLERS, MATERIALS_SKILLS, materialsManifest, PACK_ID } from "./manifest";
export * from "./schema";
export {
  MATERIALS_TOOLS,
  type PackTool,
  type PackToolContext,
  packToolContext,
  type ToolContextSource,
  thresholdFrom,
} from "./tools";
