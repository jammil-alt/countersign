// Connections' "Who approves" section (docs/plan.md §1.20): the rules that decide who approves your
// changes. Your admin can make them stricter (a named person or the admin instead of us, or a new
// rule of their own); only we loosen them. Everyone else reads them.

import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ApproverRules } from "../../approvals/ApproverRules";
import { ErrorNotice, SectionLabel } from "../../ui/primitives";

export function PortalApproverRules() {
  const client = useApiClient();
  const { data, error, reload } = useApi(apiRoutes.portalApproverRules);
  return (
    <section data-testid="portal-approvers">
      <SectionLabel>Who approves</SectionLabel>
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
    </section>
  );
}
