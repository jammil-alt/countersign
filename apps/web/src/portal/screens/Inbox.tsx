// `/inbox`: what needs the client (ARCHITECTURE §11, §15): approvals of changes to their tools,
// questions, reviews. A client user sees only what is assigned to them (the API filters).
// Resolving resumes the waiting run.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { InboxCard } from "../../inbox/InboxCard";
import { OPEN_RESOLVED, StatusFilter } from "../../inbox/StatusFilter";
import { usePoll } from "../../runs/usePoll";
import { EmptyState, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";

export function PortalInboxScreen() {
  const api = useApiClient();
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const { data, error, loading, reload } = useApi(apiRoutes.portalInbox, { query: { status } });
  usePoll(reload, status === "open", 20_000);

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Inbox"
        subtitle="Changes your agents want to make, and questions they need answered. Nothing changes in your tools until someone here says yes."
      />
      <div className="mb-4">
        <StatusFilter
          value={status}
          onChange={setStatus}
          area="portal-inbox"
          options={OPEN_RESOLVED}
        />
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.items.length === 0 ? (
        <EmptyState>
          {status === "open" ? "Nothing needs you right now." : "Nothing here yet."}
        </EmptyState>
      ) : null}
      <div data-testid="portal-inbox-list" className="flex flex-col gap-4">
        {data?.items.map((item) => (
          <InboxCard
            key={item.id}
            item={item}
            runHref={item.runId ? `/runs/${item.runId}` : null}
            outcome={
              item.status === "resolved"
                ? item.resolvedBy?.name
                  ? `Resolved by ${item.resolvedBy.name}`
                  : "Resolved"
                : null
            }
            onResolve={
              item.status === "open"
                ? async (body) => {
                    await api.call(apiRoutes.portalResolveInbox, {
                      params: { id: item.id },
                      body,
                    });
                    reload();
                  }
                : null
            }
          />
        ))}
      </div>
    </div>
  );
}
