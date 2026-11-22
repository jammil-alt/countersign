// Connections' "Who approves" section (docs/plan.md §1.20): the rules that decide who approves your
// changes. Your admin can make them stricter (a named person or the admin instead of us, or a new
// rule of their own); only we loosen them. Everyone else reads them.

import { lazy, Suspense } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ApproverRules } from "../../approvals/ApproverRules";
import { useI18n } from "../../i18n/i18n";
import { ErrorNotice, SectionLabel } from "../../ui/primitives";

// Round 4 D (docs/plan.md §1.211): the client's thresholds, loaded on their own.
const WriteThresholds = lazy(() => import("../../approvals/WriteThresholds"));

export function PortalApproverRules() {
  const { t } = useI18n();
  const client = useApiClient();
  const { data, error, reload } = useApi(apiRoutes.portalApproverRules);
  return (
    <section data-testid="portal-approvers">
      <SectionLabel>{t("approvers.title")}</SectionLabel>
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <ApproverRules
          key={data.revision}
          view={data}
          editor={data.canTighten ? "client_admin" : "viewer"}
          {...(data.canTighten
            ? {
                onSave: async (body) => {
                  await client.call(apiRoutes.portalSaveApproverRules, { body });
                  reload();
                },
              }
            : {})}
        />
      ) : null}
      {data ? (
        <Suspense fallback={null}>
          <div className="mt-6">
            <WriteThresholds surface="portal" canEdit={data.canTighten} />
          </div>
        </Suspense>
      ) : null}
    </section>
  );
}
