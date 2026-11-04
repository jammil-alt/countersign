// `/ops`: what needs the operator across the clients they serve (ARCHITECTURE §15): failed runs,
// their inbox, connections a client has to sign in to again, template updates waiting. Then the
// clients. Open client requests join this list with the requests queue (another stream).
import type { OpsOverview } from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import {
  Badge,
  Card,
  Count,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { ClientsTable, NewClientLink } from "./Clients";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function OverviewScreen() {
  const { data, error, loading, reload } = useApi(apiRoutes.opsOverview);
  const total = data
    ? data.counts.failedRuns + data.counts.inbox + data.counts.connections + data.counts.updates
    : 0;

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle={
          data
            ? total === 0
              ? `Nothing needs you across ${plural(data.clients, "client", "clients")}.`
              : `${plural(total, "thing needs", "things need")} you across ${plural(data.clients, "client", "clients")}.`
            : "What needs you across your clients."
        }
        actions={<NewClientLink />}
      />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && total === 0 ? (
        <div className="mb-8" data-testid="ops-overview-clear">
          <EmptyState>
            Failed runs, your inbox, connections to fix and template updates show here.
          </EmptyState>
        </div>
      ) : null}
      {data && total > 0 ? <Attention data={data} /> : null}
      <ClientsTable />
    </div>
  );
}

function Attention({ data }: { data: OpsOverview }) {
  return (
    <div className="mb-8 flex flex-col gap-6" data-testid="ops-overview-attention">
      {data.failedRuns.length > 0 ? (
        <Block
          label="Failed runs"
          count={data.counts.failedRuns}
          shown={data.failedRuns.length}
          tone="risk"
          more={{ to: "/ops/runs", label: "All runs" }}
          testId="ops-overview-failed"
        >
          {data.failedRuns.map((r) => (
            <Row
              key={r.id}
              to={`/ops/runs/${r.id}`}
              client={r.client.name}
              title={r.agent?.name ?? r.workflowSlug}
              detail={r.error ?? "No error recorded."}
              aside={<Badge tone="risk">Failed</Badge>}
              when={r.finishedAt ?? r.createdAt}
              testId={`ops-overview-run-${r.id}`}
            />
          ))}
        </Block>
      ) : null}
      {data.inbox.length > 0 ? (
        <Block
          label="Your inbox"
          count={data.counts.inbox}
          shown={data.inbox.length}
          tone="warning"
          more={{ to: "/ops/inbox", label: "Open the inbox" }}
          testId="ops-overview-inbox"
        >
          {data.inbox.map((i) => (
            <Row
              key={i.id}
              to="/ops/inbox"
              client={i.client.name}
              title={i.title}
              detail={i.dueAt ? `Due ${shortTime(i.dueAt)}` : null}
              aside={<Badge tone="warning">Waiting on you</Badge>}
              when={i.createdAt}
              testId={`ops-overview-item-${i.id}`}
            />
          ))}
        </Block>
      ) : null}
      {data.connections.length > 0 ? (
        <Block
          label="Connections to fix"
          count={data.counts.connections}
          shown={data.connections.length}
          tone="neutral"
          note="The client signs in again from their portal. A reminder email comes later."
          testId="ops-overview-connections"
        >
          {data.connections.map((c) => (
            <Row
              key={c.id}
              to={`/ops/clients/${c.client.id}/connections`}
              client={c.client.name}
              title={c.connectorName}
              detail={c.usedBy.length > 0 ? `Used by ${c.usedBy.join(", ")}` : "No agent uses it"}
              aside={
                c.status === "error" ? (
                  <Badge tone="risk">Sign-in failed</Badge>
                ) : (
                  <Badge>Disconnected</Badge>
                )
              }
              testId={`ops-overview-connection-${c.id}`}
            />
          ))}
        </Block>
      ) : null}
      {data.updates.length > 0 ? (
        <Block
          label="Template updates waiting"
          count={data.counts.updates}
          shown={data.updates.length}
          tone="accent"
          testId="ops-overview-updates"
        >
          {data.updates.map((u) => (
            <Row
              key={u.agent.id}
              to={`/ops/clients/${u.client.id}/agents/${u.agent.slug}/versions`}
              client={u.client.name}
              title={u.agent.name}
              detail={u.releaseNote ?? `${u.template.name} has a newer version.`}
              aside={
                <Badge tone="accent">{plural(u.behind, "version behind", "versions behind")}</Badge>
              }
              testId={`ops-overview-update-${u.agent.id}`}
            />
          ))}
        </Block>
      ) : null}
    </div>
  );
}

function Block({
  label,
  count,
  shown,
  tone,
  more,
  note,
  testId,
  children,
}: {
  label: string;
  count: number;
  shown: number;
  tone: "risk" | "warning" | "neutral" | "accent";
  more?: { to: string; label: string };
  note?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId}>
      <SectionLabel
        action={
          more ? (
            <Link to={more.to} className="ds-btn ds-btn--link text-sm">
              {more.label}
            </Link>
          ) : null
        }
      >
        <span className="inline-flex items-center gap-2">
          {label}
          <Count n={count} tone={tone} />
        </span>
      </SectionLabel>
      <Card className="overflow-hidden">
        <ul>{children}</ul>
      </Card>
      {count > shown || note ? (
        <p className="mt-2 text-sm text-ink-muted">
          {count > shown ? `Showing ${shown} of ${count}. ` : ""}
          {note ?? ""}
        </p>
      ) : null}
    </section>
  );
}

function Row({
  to,
  client,
  title,
  detail,
  aside,
  when,
  testId,
}: {
  to: string;
  client: string;
  title: string;
  detail: string | null;
  aside: ReactNode;
  when?: string;
  testId: string;
}) {
  return (
    <li className="border-b border-line last:border-b-0" data-testid={testId}>
      <Link
        to={to}
        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-subtle"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink-muted">{client}</span>
          <span className="block font-medium text-ink">{title}</span>
          {detail ? <span className="block truncate text-sm text-ink-muted">{detail}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {when ? <span className="text-sm text-ink-muted figures">{shortTime(when)}</span> : null}
          {aside}
        </span>
      </Link>
    </li>
  );
}
