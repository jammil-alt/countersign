// A step's catch-up (owner, 2026-11-24: "poll once per day and then again when a relevant agent is
// triggered to run"). A tool that reads what a connector's sync saved names that connector as its
// `feed` (core `ToolSpec.feed`); before it runs, the client's connections of that connector read
// what changed since their last sync, so a match never searches a day-old copy. Only connectors
// with a catch-up here do; any other feed (the bank feed) reads what we hold, as before.

import { ZOHO_CRM_CONNECTOR_ID } from "@countersign/connectors";
import type { FeedCatchUp } from "./packs";
import { dispatchByIds } from "./runs/dispatch";
import type { RunDeps } from "./runs/execute";
import { catchUpZoho } from "./zoho/sync";

/** The connectors whose synced records a step can bring up to date before it reads them. */
export const FEEDS_CAUGHT_UP: readonly string[] = [ZOHO_CRM_CONNECTOR_ID];

/**
 * The run's catch-up for a pack tool's feed, or null where the run has no credentials to read the
 * client's tools with (tests without them). Events a catch-up raises are dispatched at once when
 * the run can start runs; otherwise the sweep sends them.
 */
export function feedCatchUp(deps: RunDeps): FeedCatchUp | null {
  const credentials = deps.credentials;
  if (!credentials) return null;
  const { db, platform, instances } = deps;
  return async (tenantId, feed) => {
    if (feed !== ZOHO_CRM_CONNECTOR_ID) return;
    await catchUpZoho(
      { db, platform, credentials, ...(deps.now ? { now: deps.now } : {}) },
      tenantId,
      instances ? (ids) => dispatchByIds({ db, instances }, tenantId, ids) : undefined,
    );
  };
}
