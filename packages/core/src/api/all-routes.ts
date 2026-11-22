// Every route the API serves. `routes` is the web app's registry, loaded up front; a few groups
// stay out of it so their schemas load with the screen that calls them, not in the app's first
// load (scripts/web-size.mjs). The API mounts them from their own group, and the contract and
// access tests walk this whole list, so none of them skips a check.

import { adjustRoutes } from "./adjust";
import { agentReportRoutes } from "./agent-report";
import { assistRoutes } from "./assist";
import { assuranceRoutes } from "./assurance";
import { clientFileRoutes, startRoutes } from "./client-files";
import { codeRequestRoutes } from "./code-requests";
import { connectorAccessRoutes } from "./connector-access";
import { desktopRoutes } from "./desktop";
import { evidenceRoutes } from "./evidence";
import { opsIntakeRoutes, portalIntakeRoutes, welcomeRoutes } from "./intake";
import { interviewRoutes } from "./interviews";
import { inviteRoutes } from "./invite";
import { manualRoutes } from "./manual";
import { portalViewRoutes } from "./portal-views";
import { routes } from "./routes";
import { setupRoutes } from "./setup";
import { soc2Routes } from "./soc2";
import { sopRoutes } from "./sop";

/**
 * docs/plan.md §1.125: the Dev queue's routes, and §1.149: onboarding v1's (the client file,
 * starts, Invite and Sign up now, the intake, the welcome page), are served beside the registry.
 * Their screens load lazily (the back office, Getting started, the welcome page), so their schemas,
 * the guide's included, stay out of the first load.
 */
export const allRoutes = {
  ...routes,
  ...codeRequestRoutes,
  ...clientFileRoutes,
  ...startRoutes,
  ...inviteRoutes,
  ...opsIntakeRoutes,
  ...portalIntakeRoutes,
  ...welcomeRoutes,
  // docs/builder-plan.md §5 (B3): the agent manual; its tabs load lazily, and its view's schema
  // with them.
  ...manualRoutes,
  // docs/sop-plan.md: the agent's SOP; its tab loads lazily, and its view's schema with it.
  ...sopRoutes,
  ...assuranceRoutes,
  // Round 4 D (docs/plan.md §1.211): a proposed write's evidence and the client's thresholds; the
  // evidence panel and the thresholds form load lazily, and their schemas with them.
  ...evidenceRoutes,
  // docs/builder-plan.md §6 (B4): the setup checklist (Getting started, the agent's page).
  ...setupRoutes,
  // docs/builder-plan.md §7 (B5): client adjustments on the agent's Settings, and feedback on a
  // line of its manual; both load with their tabs.
  ...adjustRoutes,
  // docs/connectors-plan.md (C4): the client's Connectors place, our changes and their requests,
  // the Needs and Readiness panels; they load with the Connectors screens.
  ...connectorAccessRoutes,
  // docs/plan.md §1.168: Draft for long text fields; its sheet loads lazily with the field.
  ...assistRoutes,
  // docs/plan.md §1.204: the desktop app's pairing, folders and the computer's signed routes.
  ...desktopRoutes,
  // docs/plan.md §1.218: SOC 2 readiness and the access review's record; the screen loads lazily.
  ...soc2Routes,
  // R4 (docs/plan.md §1.214): the report per agent; its tabs load lazily, and its schema with them.
  ...agentReportRoutes,
  // R6 (docs/plan.md §1.236): the portal's saved views; the strip on the runs list loads lazily,
  // and its schemas with it.
  ...portalViewRoutes,
  // docs/plan.md §1.217: the process interview; its page and its back-office screen load lazily.
  ...interviewRoutes,
} as const;
