// The Marketing pack's reports and actions for one client in the back office (docs/marketing-plan.md
// §11): typed over the platform's generic pack routes, with the report's query parameters
// (`?site=…&from=…&to=…`). Each screen types its report's body itself (its builder's own types).
import type { ApiClient } from "../../../api/client";
import { apiRoutes } from "../../../api/routes";
import { type ApiState, useApi } from "../../../api/useApi";

export const MARKETING_PACK = "marketing";

/** A report's query: unset values are left out, everything else is sent as text. */
export type ReportQuery = Readonly<Record<string, string | number | null | undefined>>;

export function cleanQuery(query: ReportQuery | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") out[k] = String(v);
  }
  return out;
}

/** One report for a client, reloaded whenever the query changes. `null` client: nothing loads. */
export function useMarketingReport<T>(
  clientId: string | null,
  report: string,
  query?: ReportQuery,
): ApiState<T> {
  const state = useApi(
    apiRoutes.opsClientPackReport,
    clientId
      ? { params: { id: clientId, pack: MARKETING_PACK, report }, query: cleanQuery(query) }
      : null,
  );
  return { ...state, data: state.data?.report as T | undefined };
}

/** One row of a report in full (`…/items/:itemId`, a uuid): a content page, a weekly report. */
export function useMarketingItem<T>(
  clientId: string | null,
  report: string,
  itemId: string | null,
  query?: ReportQuery,
): ApiState<T> {
  const state = useApi(
    apiRoutes.opsClientPackReportItem,
    clientId && itemId
      ? {
          params: { id: clientId, pack: MARKETING_PACK, report, itemId },
          query: cleanQuery(query),
        }
      : null,
  );
  return { ...state, data: state.data?.report as T | undefined };
}

/** The report as a CSV file, for a download link. */
export function marketingCsvHref(clientId: string, report: string, query?: ReportQuery): string {
  const q = new URLSearchParams(cleanQuery(query)).toString();
  return `/api/ops/clients/${clientId}/reports/${MARKETING_PACK}/${report}/csv${q ? `?${q}` : ""}`;
}

/**
 * A person's action on the client's marketing data (`add-site`, `update-site`, …); answers the
 * action's result. A refusal comes back as the API's 422 `refused` error.
 */
export async function runMarketingAction<T = Record<string, unknown>>(
  client: ApiClient,
  clientId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<T> {
  const r = await client.call(apiRoutes.opsClientPackAction, {
    params: { id: clientId, pack: MARKETING_PACK, action },
    body,
  });
  return r.result as T;
}
