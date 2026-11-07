// The client page's health section (docs/plan.md §1.28): the client's supervisor (or a button to
// add it), its latest account check, and its open findings, both the client admin's (the plain
// steps they see) and the operator's (the agent, version, step, error and the supervisor's note).
import type { OpsFinding } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Section } from "../../ui/page";
import { Badge, Button, Card, EmptyState, ErrorNotice, Tag } from "../../ui/primitives";

const AUDIENCE: Record<OpsFinding["audience"], string> = {
  client_admin: "Client admin",
  operator: "Us",
};

/** The details' fields worth a line, in this order; the rest stay in the run. */
const DETAIL_FIELDS: [string, string][] = [
  ["agentName", "Agent"],
  ["version", "Version"],
  ["workflowSlug", "Workflow"],
  ["stepId", "Step"],
  ["error", "Error"],
  ["connectorName", "Tool"],
  ["reason", "Reason"],
  ["detail", "Detail"],
];

function detailLines(details: Record<string, unknown> | null): [string, string][] {
  if (!details) return [];
  return DETAIL_FIELDS.flatMap(([key, label]) => {
    const v = details[key];
    return v === null || v === undefined || v === "" ? [] : [[label, String(v)]];
  });
}

export function ClientHealthSection({
  clientId,
  onChanged,
}: {
  clientId: string;
  onChanged?: () => void;
}) {
  const client = useApiClient();
  const { data, error, reload } = useApi(apiRoutes.opsClientHealth, {
    params: { id: clientId },
    query: { status: "open" },
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;

  async function add() {
    setBusy(true);
    setProblem(null);
    try {
      await client.call(apiRoutes.opsAddSupervisor, { params: { id: clientId }, body: {} });
      reload();
      onChanged?.();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  const s = data.summary;
  return (
    <Section
      title="Health"
      testId="ops-client-health"
      action={
        data.supervisor ? (
          <Link
            to={`/ops/clients/${clientId}/agents/${data.supervisor.slug}`}
            className="ds-btn ds-btn--link text-sm"
          >
            Open the supervisor
          </Link>
        ) : null
      }
    >
      <Card className="flex flex-col gap-3 p-5">
        {data.supervisor ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-ink">
              {data.supervisor.name} watches runs, connections, logins, codes and waiting items.
            </p>
            <Badge
              tone={data.supervisor.runStatus === "active" ? "positive" : "neutral"}
              testId="ops-client-supervisor-state"
            >
              {data.supervisor.runStatus === "active"
                ? "Watching"
                : `Not active yet: ${data.supervisor.runStatus ?? "draft"}`}
            </Badge>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-ink">
              No supervisor yet. It watches this client's account and tells the client admin and us
              what needs a person. It changes nothing itself.
            </p>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void add()}
              data-testid="ops-client-add-supervisor"
            >
              Add the supervisor
            </Button>
          </div>
        )}
        {problem ? <ErrorNotice error={problem} /> : null}
        {s ? (
          <p className="text-sm text-ink-muted" data-testid="ops-client-health-summary">
            {`Checked ${shortTime(s.checkedAt)}: ${s.runs.total} live runs in a day, ${s.runs.failed} failed · ${s.connections.needsAttention} of ${s.connections.total} connections need a person · ${s.waiting.count} items waiting, oldest ${s.waiting.oldestHours} h · ${s.openFindings} open for the client`}
          </p>
        ) : data.supervisor ? (
          <p className="text-sm text-ink-muted">No daily check yet. It runs at 08:00 their time.</p>
        ) : null}
      </Card>

      <div className="flex flex-col gap-3" data-testid="ops-client-findings">
        {data.findings.length === 0 ? (
          <EmptyState>Nothing open.</EmptyState>
        ) : (
          data.findings.map((f) => <FindingCard key={f.id} finding={f} />)
        )}
      </div>
    </Section>
  );
}

function FindingCard({ finding: f }: { finding: OpsFinding }) {
  const lines = detailLines(f.details);
  return (
    <Card className="flex flex-col gap-2 p-5" testId={`ops-finding-${f.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={f.audience === "client_admin" ? "person" : "warning"}>
            {AUDIENCE[f.audience]}
          </Badge>
          <Tag>{f.kind.replace(/_/g, " ")}</Tag>
          {f.reminders > 0 ? <Tag>{`reminded ${f.reminders}×`}</Tag> : null}
          {f.occurrences > 1 ? <Tag>{`seen ${f.occurrences}×`}</Tag> : null}
        </span>
        <span className="text-sm text-ink-muted">{shortTime(f.createdAt)}</span>
      </div>
      <h3 className="font-medium text-ink">{f.title}</h3>
      {lines.length > 0 ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          {lines.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="break-words text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {f.note ? <p className="text-sm text-ink">{f.note}</p> : null}
      {f.steps.length > 0 ? (
        <ol className="list-decimal flex flex-col gap-1 pl-5 text-sm text-ink">
          {f.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}
