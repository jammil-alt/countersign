// @countersign/pack-marketing: the Marketing area (docs/marketing-plan.md; ARCHITECTURE §12.0),
// built on the platform. M43: measuring a client's website (src/measure: the beacon, the visit
// hash, sources, the nightly build and retention), its measured sites and the overview report.
// §1.73: the areas (measure, search, content, agents, forum), each an AreaModule (src/pack.ts)
// that manifest.ts adds up; a builder exports new things from its area, not from here.
// apps/api registers it. May import core, db and llm; never agents or workflows.

// Skill model (2026-11-10): the AI skills that replace the agent-mode ones, and their step
// patterns, for the template stream.
export {
  forumReplySteps,
  MARKETING_SPLIT_SKILLS,
  MARKETING_SPLIT_WRITES,
  socialPostSteps,
  weeklyReportSteps,
} from "./agents/splits";
export {
  MARKETING_ACTIONS,
  MARKETING_AREAS,
  MARKETING_HANDLERS,
  MARKETING_INBOUND,
  MARKETING_NIGHTLY,
  MARKETING_REPORTS,
  MARKETING_SKILLS,
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
export * from "./pack";
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
