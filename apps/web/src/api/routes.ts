import { routes } from "@countersign/core";

/** The API's route contract (packages/core): the same specs apps/api mounts. */
export const apiRoutes = routes;
export type ApiRoutes = typeof apiRoutes;

export type { AgentSummary, VersionDetail, VersionSummary } from "@countersign/core";
