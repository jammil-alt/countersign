// The client settings' "Who approves" rules (docs/plan.md §1.20): the operator sets the client's
// ordered approver rules, with a reason, and tries a sample change against them. The editor is its
// own card, titled "Who approves".

import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ApproverRules } from "../../approvals/ApproverRules";
import { ErrorNotice } from "../../ui/primitives";

export function ClientApproverRules({ clientId }: { clientId: string }) {
  const client = useApiClient();
  const { data, error, reload } = useApi(apiRoutes.opsApproverRules, {
    params: { id: clientId },
  });
  return (
    <div data-testid="ops-client-approvers">
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <ApproverRules
          // A save bumps the revision: the editor starts again from what was saved.
          key={data.revision}
          view={data}
          editor="operator"
          onSave={async (body) => {
            await client.call(apiRoutes.opsSaveApproverRules, { params: { id: clientId }, body });
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
