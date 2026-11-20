// @countersign/pack-sales: the Sales area (docs/plan.md §1.164; ARCHITECTURE §12.0). Its first
// version keeps the client's synced CRM records as match keys and matches rows to them.
// apps/api registers it. May import core, db, llm, senses, documents, connectors; never agents or
// workflows.

export { PACK_ID } from "./ids";
export {
  type CrmRecordMapper,
  DEFAULT_MATCH_TEXT_FIELDS,
  keysHash,
  keysOf,
  MATCH_TEXT_FIELDS,
  type MappedRecord,
  type MatchTextField,
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
export * from "./schema";
export {
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
/**
 * After a sync page committed (apps/api's sync): the connectors whose records the Sales area keys,
 * and the pass that builds them for a client with the area on.
 */
export { SALES_SYNCED } from "./synced";
export {
  keysRefreshTool,
  LookupRecordOut,
  MatchRecordsOutput,
  matchRecordsTool,
  recordsLookupTool,
  SALES_TOOLS,
} from "./tools";
