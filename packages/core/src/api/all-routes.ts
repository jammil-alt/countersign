// Every route the API serves. `routes` is the web app's registry, loaded up front; a few groups
// stay out of it so their schemas load with the screen that calls them, not in the app's first
// load (scripts/web-size.mjs). The API mounts them from their own group, and the contract and
// access tests walk this whole list, so none of them skips a check.

import { codeRequestRoutes } from "./code-requests";
import { routes } from "./routes";

/** docs/plan.md §1.125: the Dev queue's routes are served beside the registry. */
export const allRoutes = { ...routes, ...codeRequestRoutes } as const;
