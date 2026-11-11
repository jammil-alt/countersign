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
export * from "./catalog/split";
export { lookupDocument, recordMatches } from "./catalog/split-store";
export { seedDemoPrices } from "./demo";
export { MATERIALS_EVENTS, materialsEventRegistry } from "./events";
export { MATERIALS_HANDLERS, MATERIALS_SKILLS, materialsManifest, PACK_ID } from "./manifest";
export * from "./patterns";
export { checkPrices } from "./pricing/check";
export { PricingError, recordPrices } from "./pricing/record";
export * from "./pricing/rules";
export { convert, readUom } from "./pricing/uom";
// P-5: the Purchasing area (docs/plan.md §1.67).
export { backfillFromBills } from "./purchasing/backfill";
export { compareOffers, compareQuotes, SPLIT_MIN_SAVING_PCT } from "./purchasing/compare";
export { renderPurchaseOrder } from "./purchasing/po";
export { PURCHASING_SKILLS } from "./purchasing/skills";
export { PURCHASING_TOOLS } from "./purchasing/tools";
export * from "./reports";
export * from "./schema";
export * from "./split";
export {
  MATERIALS_TOOLS,
  type PackTool,
  type PackToolContext,
  packToolContext,
  type ToolContextSource,
  thresholdFrom,
} from "./tools";
// §1.88: the vendor catalog, its matching pipeline, skills and pattern.
export {
  EMBEDDING_TEMPLATE,
  EMBEDDING_TEXT_MAX_WORDS,
  embeddingText,
  specsText,
  stripTerms,
} from "./vendor/embedding-text";
export * from "./vendor/patterns";
export {
  type LoadedDocument,
  lineEmbeddingText,
  lookupBySku,
  masterText,
  matchVendor,
  openLineEmbeddingText,
  type RegisterResult,
  registerLines,
  VendorMatchError,
  vendorItemText,
} from "./vendor/pipeline";
export {
  MASTER_ITEM_MANAGER,
  SEMANTIC_MATCH_VENDOR,
  SUPERSEDED_BY_LIBRARY_SKILLS,
  VENDOR_LIBRARY_SKILLS,
  VENDOR_SKILLS,
} from "./vendor/skills";
export {
  cleanSku,
  discontinue,
  setPreferred,
  VendorItemError,
  type VendorItemView,
  vendorCatalog,
  vendorItemById,
  vendorItemView,
  vendorsForItem,
} from "./vendor/store";
export { embedTexts, VENDOR_TOOLS, writeEmbeddings } from "./vendor/tools";
