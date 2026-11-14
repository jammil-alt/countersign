// A template's panels, shared by its own page (the Overview tab) and nowhere else since the lab
// became a gallery: where it runs (its client copies, versions behind, merges to review and
// changes to promote), the panels it adds to the client's agent page, and Assign to a client,
// which forks it into a client as that client's own draft agent. Publishing a template changes no
// client agent: each takes the new version as a reviewed update merge (invariant 11).
import { pickLocalized } from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { AgentBadge } from "../../ui/badges";
import { Button, Card, ErrorNotice, Loading, Tag } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { errorText, Notice, notifyAgentsChanged, plural, Select, useAction } from "../agents/ui";
import type { AgentLinkState } from "../screens/AgentPage";

type UsedBy = ResponseOf<typeof apiRoutes.opsUsedBy>["agents"][number];

/** The agent's id travels with links to its page, so the page needn't look it up by slug. */
export function handOver(id: string): AgentLinkState {
  return { agentId: id };
}

// DECISION: a panel still loading after 8 s says so and offers Try again, rather than "Loading…"
// for ever (the owner's review: "Where it runs" never finished). A request that never answers
// (a dropped connection, a Worker past its limit) is the one case useApi can't turn into an error.
const SLOW_MS = 8_000;

/** True once `loading` has lasted `ms`; false again when it stops. */
export function useSlow(loading: boolean, ms = SLOW_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(timer);
  }, [loading, ms]);
  return slow;
}

function usedByChip(u: UsedBy) {
  if (!u.agent.liveVersionId) return <StatusChip state="idle">Not live</StatusChip>;
  if (!u.agent.linked) return <StatusChip state="idle">Detached</StatusChip>;
  if (u.behind > 0) return <StatusChip state="waiting">{u.behind} behind</StatusChip>;
  return <StatusChip state="done">Current</StatusChip>;
}

export function WhereItRuns({ templateId }: { templateId: string }) {
  const res = useApi(apiRoutes.opsUsedBy, { params: { id: templateId } });
  const slow = useSlow(res.loading && !res.data);
  return (
    <Card
      title="Where it runs"
      meta={<span className="text-sm text-ink-muted">Lineage</span>}
      testId="lab-used-by"
    >
      {res.error ? (
        <div className="px-6 py-4">
          <ErrorNotice error={res.error} onRetry={res.reload} />
        </div>
      ) : null}
      {!res.data && !res.error ? (
        slow ? (
          <div
            className="flex flex-wrap items-center gap-3 px-6 py-4"
            data-testid="lab-used-by-slow"
          >
            <p className="text-sm text-ink-muted">
              This is taking longer than it should. Your clients' copies are still on their way.
            </p>
            <Button size="sm" variant="ghost" onClick={res.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="px-6">
            <Loading />
          </div>
        )
      ) : null}
      {res.data && res.data.agents.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          No client has a copy yet. Assign it to a client to fork it in as that client's own agent.
        </p>
      ) : null}
      {res.data && res.data.agents.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {res.data.agents.map((u) => (
            <li
              key={u.agent.id}
              className="flex items-start gap-3 px-6 py-4"
              data-testid={`lab-used-by-${u.agent.id}`}
            >
              <AgentBadge name={u.agent.name} seed={u.agent.id} size="sm" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link
                  to={`/ops/clients/${u.client.id}/agents/${u.agent.slug}`}
                  className="font-medium text-ink hover:underline"
                >
                  {u.client.name}'s copy · {u.agent.serviceName ?? u.agent.name}
                </Link>
                <span className="text-sm text-ink-muted">
                  {u.baseVersion ? `From v${u.baseVersion}` : "Forked"}
                  {" · "}
                  {u.customizations > 0
                    ? plural(u.customizations, "client change")
                    : "no client changes"}
                  {u.conflicts ? ` · ${plural(u.conflicts, "conflict")} to settle` : ""}
                </span>
                {u.agent.linked && u.behind > 0 && res.data?.templateLiveVersion ? (
                  <Link
                    to={`/ops/agents/${u.agent.id}/merge?mode=update`}
                    className="text-sm text-link hover:underline"
                    data-testid={`lab-used-by-${u.agent.id}-merge`}
                  >
                    Update it from template v{res.data.templateLiveVersion}
                  </Link>
                ) : null}
                {u.customizations > 0 && u.agent.liveVersionId ? (
                  <Link
                    to={`/ops/agents/${u.agent.id}/merge?mode=promote`}
                    className="text-sm text-link hover:underline"
                    data-testid={`lab-used-by-${u.agent.id}-promote`}
                  >
                    Promote its changes to the template
                  </Link>
                ) : null}
              </div>
              {usedByChip(u)}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function ClientViewCard({ agentId }: { agentId: string }) {
  const res = useApi(apiRoutes.opsAgentClientView, { params: { id: agentId } });
  return (
    <Card
      title="Client view"
      testId="lab-client-view"
      meta={res.data?.clientView?.panels.length ? <Tag>Custom</Tag> : null}
      pad
    >
      {res.error ? <ErrorNotice error={res.error} onRetry={res.reload} /> : null}
      {!res.data && !res.error ? <Loading /> : null}
      {res.data ? (
        res.data.clientView && res.data.clientView.panels.length > 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">
              Panels this template adds to the client's agent page. They travel with every fork.
            </p>
            {res.data.clientView.panels.map((p) => {
              const kpis = res.data?.clientView?.kpis ?? [];
              return (
                <div key={p.id} className="rounded-md bg-surface-subtle px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <b className="font-medium text-ink">
                      {p.kind === "kpis"
                        ? p.kpis
                            .map((id) => {
                              const k = kpis.find((x) => x.id === id);
                              return k ? pickLocalized(k.label) : id;
                            })
                            .join(", ")
                        : p.report}
                    </b>
                    <span className="text-sm text-ink-muted">
                      {p.kind === "kpis"
                        ? plural(p.kpis.length, "figure")
                        : `${p.pack} · pack report`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            {res.data.versionId
              ? "No panels: the client's agent page shows its runs and changes only."
              : "Publish a version to set what the client's agent page shows."}
          </p>
        )
      ) : null}
    </Card>
  );
}

function AssignForm({
  templateId,
  version,
  onCancel,
}: {
  templateId: string;
  version: number | null;
  onCancel(): void;
}) {
  const clients = useApi(apiRoutes.opsClients, { query: { view: "names" } });
  const [clientId, setClientId] = useState("");
  const action = useAction();
  const navigate = useNavigate();
  const choices = (clients.data?.clients ?? []).filter((c) => !c.sandbox);
  const chosen = clientId || choices[0]?.id || "";

  async function assign() {
    if (!chosen) return;
    const res = await action.call(apiRoutes.opsFork, {
      params: { id: templateId },
      body: { clientId: chosen },
    });
    if (res.ok) {
      notifyAgentsChanged();
      navigate(`/ops/clients/${chosen}/agents/${res.data.agent.slug}`, {
        state: handOver(res.data.agent.id),
      });
    }
  }

  return (
    <div
      className="ds-card flex w-full max-w-md flex-col gap-3 p-4 text-left"
      data-testid="lab-assign-form"
    >
      <p className="text-sm text-ink-muted">
        Forks v{version} into the client as its own agent, as a draft: bind its connections, test it
        there, then start its trial.
      </p>
      {clients.error ? <ErrorNotice error={clients.error} onRetry={clients.reload} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Client"
          className="w-64"
          data-testid="lab-assign-client-select"
          value={chosen}
          onChange={(e) => setClientId(e.target.value)}
        >
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button
          variant="primary"
          size="sm"
          data-testid="lab-assign-confirm"
          disabled={action.busy || !chosen}
          onClick={assign}
        >
          {action.busy ? "Assigning…" : "Assign"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {action.error ? <Notice tone="warning">{errorText(action.error)}</Notice> : null}
    </div>
  );
}

/** Assign to a client: a button that opens the fork form under the page's actions. */
export function AssignToClient({ templateId, version }: { templateId: string; version: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        data-testid="lab-assign"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        Assign to a client
      </Button>
      {open ? (
        <AssignForm templateId={templateId} version={version} onCancel={() => setOpen(false)} />
      ) : null}
    </>
  );
}
