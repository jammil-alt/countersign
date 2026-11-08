// @countersign/pack-marketing: the Marketing area (docs/marketing-plan.md; ARCHITECTURE §12.0),
// built on the platform. M43: measuring a client's website (src/measure: the beacon, the visit
// hash, sources, the nightly build and retention), its measured sites and the overview report.
// apps/api registers it. May import core and db; never agents or workflows.

export {
  MARKETING_ACTIONS,
  MARKETING_INBOUND,
  MARKETING_NIGHTLY,
  MARKETING_REPORTS,
  marketingManifest,
  PACK_ID,
  type PackInboundRequest,
} from "./manifest";
export {
  type CollectOutcome,
  type CollectRequest,
  collect,
  countDropped,
  hostOf,
  randomSalt,
  recordEvents,
  saltFor,
} from "./measure/collect";
export * from "./measure/events";
export {
  bandCounts,
  buildDay,
  daysToBuild,
  type NightlyResult,
  nightly,
  sweep,
} from "./measure/rollup";
export { type Overview, overview, overviewCsv, PERIOD_DAYS, SMALL_SAMPLE } from "./reports";
export * from "./schema";
export {
  AddSiteInput,
  addSite,
  listSites,
  normalizeDomain,
  SiteError,
  type SiteRow,
  UpdateSiteInput,
  updateSite,
} from "./sites";
