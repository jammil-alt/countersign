// @countersign/pack-materials: the first agent's domain, built on the platform (ARCHITECTURE §12).
// Exports the pack manifest (tools, skills, events; no agent templates), tool handlers, Drizzle schema
// and the client reports. src/catalog: normalize, parse, match, learn, merge (§12.3). src/pricing:
// units, recording, the six alert rules, history and the digest (§12.4). apps/api registers it.
// May import core, db, llm, senses, documents, connectors; never agents or workflows.

export {
  MATERIALS_ACTIONS,
  MATERIALS_REPORTS,
  MATERIALS_REVIEWS,
  type PackActionHandler,
  type PackReportHandler,
  type PackReviewHandler,
  ReviewError,
} from "./api";
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
export { seedDemoPrices } from "./demo";
export { MATERIALS_EVENTS, materialsEventRegistry } from "./events";
export { MATERIALS_HANDLERS, MATERIALS_SKILLS, materialsManifest, PACK_ID } from "./manifest";
export { checkPrices } from "./pricing/check";
export { PricingError, recordPrices } from "./pricing/record";
export * from "./pricing/rules";
export { convert, readUom } from "./pricing/uom";
export * from "./reports";
export * from "./schema";
export {
  MATERIALS_TOOLS,
  type PackTool,
  type PackToolContext,
  packToolContext,
  type ToolContextSource,
  thresholdFrom,
} from "./tools";
