// Links to the back office's runs list with a filter in its address (UI cleanup, stream A), so the
// command center's tiles and other pages open the list already filtered. The list reads the same
// parameters `GET /api/ops/runs` takes (packages/core's OpsRunsQuery).
import { type RunFilter, runFilterQuery } from "@countersign/core";
import { OPS_PATHS } from "../paths";

/** `/ops/runs?statuses=waiting&mode=live`. */
export function runsLink(filter: RunFilter): string {
  const q = new URLSearchParams(runFilterQuery(filter)).toString();
  return q ? `${OPS_PATHS.runs}?${q}` : OPS_PATHS.runs;
}

/** Live runs waiting for approval (on the client or us). */
export const WAITING_RUNS = runsLink({ statuses: ["waiting"], mode: "live" });

/** Runs going now that wait on nobody. */
export const RUNNING_RUNS = runsLink({ statuses: ["queued", "running"] });

/** Live runs that failed since `since` (today's start). */
export function failedRunsSince(since: string): string {
  return runsLink({ statuses: ["failed"], mode: "live", since });
}
