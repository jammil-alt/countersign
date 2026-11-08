// The back office's Marketing entry (/ops/marketing; docs/marketing-plan.md §4.7, §11): it opens
// our own client (Mezonas, `internal`) with the Marketing pack on. One: straight to its overview.
// Several: a choice. None of ours: the clients that have the pack on, if any, and how to set ours
// up (mark the client as ours in its settings, switch Marketing on in its Packs).
import { Link, Navigate } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi } from "../../../api/useApi";
import { useOpsClients } from "../../../ops/OpsLayout";
import { OPS_PATHS } from "../../../ops/paths";
import { Page } from "../../../ui/page";
import { Card, EmptyState, ErrorNotice, Loading, PageHeader, Tag } from "../../../ui/primitives";
import { MARKETING_PACK } from "./api";
import { MARKETING_PATHS } from "./paths";

interface Candidate {
  id: string;
  name: string;
  internal: boolean;
}

/** The clients with the pack on, ours first; which to open, or none. */
export function marketingClients(
  enabled: readonly { id: string; name: string }[],
  internal: ReadonlySet<string>,
): { open: string | null; ours: Candidate[]; others: Candidate[] } {
  const all = enabled.map((c) => ({ ...c, internal: internal.has(c.id) }));
  const ours = all.filter((c) => c.internal);
  const others = all.filter((c) => !c.internal);
  return { open: ours.length === 1 ? (ours[0]?.id ?? null) : null, ours, others };
}

function ClientChoice({ clients, testId }: { clients: Candidate[]; testId: string }) {
  return (
    <ul className="flex flex-col gap-2" data-testid={testId}>
      {clients.map((c) => (
        <li key={c.id}>
          <Link
            to={MARKETING_PATHS.overview(c.id)}
            className="flex items-center gap-2 hover:underline"
            data-testid={`marketing-entry-open-${c.id}`}
          >
            <span className="font-medium text-ink">{c.name}</span>
            {c.internal ? <Tag>Ours</Tag> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function MarketingEntryScreen() {
  const packs = useApi(apiRoutes.opsPacks);
  const clients = useOpsClients();
  const pack = packs.data?.packs.find((p) => p.id === MARKETING_PACK);
  const enabled = (pack?.clients ?? []).filter((c) => c.enabled);
  const internal = new Set((clients ?? []).filter((c) => c.internal).map((c) => c.id));
  const choice = marketingClients(enabled, internal);
  const ready = packs.data !== undefined && clients !== null;

  if (ready && choice.open) return <Navigate replace to={MARKETING_PATHS.overview(choice.open)} />;
  return (
    <Page testId="marketing-entry">
      <PageHeader
        title="Marketing"
        subtitle="Our website's visits, search, content and the agents that draft for us."
      />
      {packs.error ? <ErrorNotice error={packs.error} onRetry={packs.reload} /> : null}
      {!ready && !packs.error ? <Loading /> : null}
      {ready && choice.ours.length > 1 ? (
        <Card title="Which client" testId="marketing-entry-ours" pad>
          <ClientChoice clients={choice.ours} testId="marketing-entry-choice" />
        </Card>
      ) : null}
      {ready && choice.ours.length === 0 ? (
        <>
          <EmptyState
            testId="marketing-entry-none"
            title="None of our own clients has Marketing on"
            line="Mark our client as one of ours in its settings, then switch Marketing on in its Packs."
            action={{
              to: OPS_PATHS.packs,
              label: "Open Packs",
              testId: "marketing-entry-packs",
            }}
          />
          {choice.others.length > 0 ? (
            <Card title="Clients with Marketing on" testId="marketing-entry-others" pad>
              <ClientChoice clients={choice.others} testId="marketing-entry-other-choice" />
            </Card>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
