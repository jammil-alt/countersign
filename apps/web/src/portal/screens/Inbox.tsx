// `/inbox`: what needs the client (ARCHITECTURE §11, §15): approvals of changes to their tools,
// questions, reviews. A client user sees only what is assigned to them (the API filters).
// Resolving resumes the waiting run.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { InboxCard } from "../../inbox/InboxCard";
import { openResolved, StatusFilter } from "../../inbox/StatusFilter";
import { usePoll } from "../../runs/usePoll";
import { EmptyState, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";

export function PortalInboxScreen() {
  const api = useApiClient();
  const i18n = useI18n();
  const { t } = i18n;
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const { data, error, loading, reload } = useApi(apiRoutes.portalInbox, { query: { status } });
  usePoll(reload, status === "open", 20_000);

  return (
    <div className="max-w-5xl">
      <PageHeader title={t("inbox.title")} subtitle={t("inbox.subtitle")} />
      <div className="mb-4">
        <StatusFilter
          value={status}
          onChange={setStatus}
          area="portal-inbox"
          options={openResolved(i18n)}
        />
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.items.length === 0 ? (
        <EmptyState>
          {status === "open" ? t("inbox.emptyOpen") : t("inbox.emptyResolved")}
        </EmptyState>
      ) : null}
      <div data-testid="portal-inbox-list" className="flex flex-col gap-4">
        {data?.items.map((item) => (
          <InboxCard
            key={item.id}
            item={item}
            runHref={item.runId ? `/runs/${item.runId}` : null}
            recordHref={(id) => `/records/${id}`}
            outcome={
              item.status === "resolved"
                ? item.resolvedBy?.name
                  ? t("inbox.outcome.resolvedBy", { name: item.resolvedBy.name })
                  : t("inbox.outcome.resolved")
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
