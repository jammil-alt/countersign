// @countersign/pack-sales: the Sales area (docs/plan.md §1.164; ARCHITECTURE §12.0). Its first
// version keeps the client's synced CRM records as match keys and matches rows to them.
// apps/api registers it. May import core, db, llm, senses, documents, connectors; never agents or
// workflows.

export { PACK_ID } from "./ids";
// §1.164: Confirm matches (the review card `sales.match`), the confirmed matches, the template.
export { SALES_INTAKE_SECTION } from "./intake";
export {
  type CrmRecordMapper,
  DEFAULT_MATCH_TEXT_FIELDS,
  keysHash,
  keysOf,
  MATCH_FIELDS_MAX,
  MATCH_TEXT_FIELDS,
  type MappedRecord,
  type MatchTextField,
  matchFieldsFrom,
  matchTextFieldsFrom,
  matchTextOf,
  type RecordFields,
} from "./keys/build";
export * from "./keys/normalize";
export { CRM_MAPPERS, ZOHO_CONNECTOR, zohoMapper } from "./keys/zoho";
export { SALES_HANDLERS, SALES_SKILLS, salesManifest } from "./manifest";
export {
  decideRow,
  latestDecisions,
  type RowDecision,
  type RowDecisionInput,
} from "./match/decide";
export {
  type CandidateView,
  extraValues,
  FOUND_BY,
  type FoundBy,
  KeyMapping,
  kindOf,
  MATCH_ROWS_MAX,
  type MatchedRecord,
  MatchRecordsInput,
  type MatchRecordsResult,
  matchOnFrom,
  matchRecords,
  type RowMatch,
  rowKeys,
  rowValues,
  thresholdFrom,
} from "./match/match";
export { chooseRecord, MODEL_CANDIDATES, RecordChoice } from "./match/model";
/**
 * After a sync page committed (apps/api's sync): the connectors whose records the Sales area keys,
 * and the pass that builds them for a client with the area on.
 */
export * from "./match/profile";
export {
  decideByRules,
  KEY_FIELDS,
  type KeyField,
  MATCH_THRESHOLD,
  type PairScore,
  RECORD_KINDS,
  type RecordKind,
  scorePair,
} from "./match/score";
export * from "./pack";
export {
  type CardDecision,
  CONFIDENCE_WORDS,
  type ComparedField,
  type ConfidenceWord,
  type ConfirmedMatch,
  type ConfirmedMatches,
  compareValues,
  confidenceWord,
  confirmedMatches,
  decideMatchReview,
  FOUND_WORDS,
  type FoundWord,
  lookupForReview,
  MATCH_REVIEW,
  MatchReviewDecision,
  MatchReviewPayload,
  matchReviewAnswer,
  matchReviewView,
  type PackReviewHandler,
  ReviewError,
  SALES_REVIEWS,
} from "./review";
export * from "./schema";
export {
  type ClientMatchSettings,
  clientMatchSettings,
  type EmbedResult,
  embedDueKeys,
  type KeyRow,
  keysAfterSync,
  LOOKUP_MAX,
  type LookupRecord,
  lookupRecords,
  refreshRecordKeys,
  salesOn,
} from "./store";
export { SALES_SYNCED } from "./synced";
export {
  ConfirmedUpdate,
  confirmedMatchesTool,
  keysRefreshTool,
  LookupRecordOut,
  MatchRecordsOutput,
  matchRecordsTool,
  recordsLookupTool,
  SALES_TOOLS,
} from "./tools";
