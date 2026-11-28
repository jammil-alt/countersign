// The agent set (M47–M49, docs/plan.md §1.77): the pack's skills (./skills.ts), the reads they use (`marketing.site.figures`, `marketing.site.page`,
// `marketing.report.get`), `marketing.report.record` with its figures check, the checks in code
// before a change a person signs (`marketing.titles.check`, `marketing.social.check`), the
// research-checked `marketing.article.draft`, and the `reports` report with its actions (read,
// Done / Not now). Agents never publish or post. The agent templates (weekly site report, titles and descriptions,
// article drafts, forum watch, social posts) are built again in the step model, one by one.
// Owned by the agent set builder (docs/marketing-plan.md §11).

import type { AreaModule } from "../pack";
import { articleDraftTool } from "./articles";
import { siteFiguresTool, sitePageTool } from "./figures";
import { REPORT_ACTIONS_HANDLERS, REPORTS_REPORT, reportGetTool, reportRecordTool } from "./report";
import { AGENT_SKILLS } from "./skills";
import { socialCheckTool } from "./social";
import { MARKETING_SPLIT_SKILLS } from "./splits";
import { titlesCheckTool } from "./titles";

export * from "./articles";
export * from "./figures";
export * from "./figures-check";
export * from "./report";
export * from "./skills";
export * from "./social";
export * from "./splits";
export * from "./titles";

export const AREA: AreaModule = {
  TOOLS: [
    siteFiguresTool,
    sitePageTool,
    reportRecordTool,
    reportGetTool,
    titlesCheckTool,
    articleDraftTool,
    socialCheckTool,
  ],
  // Skill model (2026-11-10): AI skills that write nothing (./splits.ts).
  SKILLS: [...AGENT_SKILLS, ...MARKETING_SPLIT_SKILLS],
  // No agent templates until the agent set is built again in the step model (docs/step-model-plan.md
  // §12 R0: templates are built again one by one, later).
  TEMPLATES: [],
  EVENTS: [],
  SCREENS: [],
  REPORTS: { reports: REPORTS_REPORT },
  ACTIONS: REPORT_ACTIONS_HANDLERS,
};
