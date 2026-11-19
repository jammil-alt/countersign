// Every route the API serves. `routes` is the web app's registry, loaded up front; a few groups
// stay out of it so their schemas load with the screen that calls them, not in the app's first
// load (scripts/web-size.mjs). The API mounts them from their own group, and the contract and
// access tests walk this whole list, so none of them skips a check.

import { clientFileRoutes, startRoutes } from "./client-files";
import { codeRequestRoutes } from "./code-requests";
import { opsIntakeRoutes, portalIntakeRoutes, welcomeRoutes } from "./intake";
import { inviteRoutes } from "./invite";
import { manualRoutes } from "./manual";
import { routes } from "./routes";

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
} as const;
