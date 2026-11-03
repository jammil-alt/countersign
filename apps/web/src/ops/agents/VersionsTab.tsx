// The Versions tab (ARCHITECTURE §9.3, §10.5 "Versions"): history with change notes and status
// badges, each version's readable diff against its parent, publish a draft, roll back to an older
// version. On a client agent: "Based on template vN", update available, and its customizations
// against the template; on a template: "Used by", with versions behind and open conflicts.
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionSummary } from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../../ui/primitives";
import { ChangeList } from "./ChangeList";
import { detailMessages, errorText, Notice, plural, useAction } from "./ui";

export type AgentDetail = ResponseOf<typeof apiRoutes.opsAgent>;

function statusBadge(v: VersionSummary, liveId: string | null) {
  if (v.id === liveId) return <Badge tone="positive">live</Badge>;
  if (v.status === "draft") return <Badge tone="neutral">draft</Badge>;
  return <Badge tone="warning">{v.status}</Badge>;
}

export function VersionsTab({
  agent,
  versions,
  liveId,
  base,
  update,
  onChanged,
}: {
  agent: AgentSummary;
  versions: VersionSummary[];
  liveId: string | null;
  base: string;
  update: AgentDetail["update"];
  onChanged(): void;
}) {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const [selected, setSelected] = useState<string | null>(sorted[0]?.id ?? null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();
  const template = useApi(
    apiRoutes.opsAgent,
    agent.kind === "client" && agent.templateId ? { params: { id: agent.templateId } } : null,
  );
  const templateVersion = (id: string | null) =>
    id ? template.data?.versions.find((v) => v.id === id) : undefined;
  const live = versions.find((v) => v.id === liveId) ?? null;

  if (versions.length === 0) return <EmptyState>No versions yet.</EmptyState>;

  async function publish(v: VersionSummary) {
    const res = await action.call(apiRoutes.opsPublish, {
      params: { id: agent.id, vid: v.id },
    });
    if (res.ok) {
      setDone(`v${v.version} is live.`);
      onChanged();
    }
  }

  async function rollback(v: VersionSummary) {
    setConfirming(null);
    const res = await action.call(apiRoutes.opsRollback, {
      params: { id: agent.id },
      body: { versionId: v.id },
    });
    if (res.ok) {
      setDone(`Rolled back: v${res.data.version.version} is a copy of v${v.version} and is live.`);
      setSelected(res.data.version.id);
      onChanged();
    }
  }

  const failure = action.error ? (
    <Notice tone="warning" testId="agent-versions-error">
      {errorText(action.error)}
      {detailMessages(action.error).length > 0 ? (
        <ul className="mt-2 list-disc pl-5">
          {detailMessages(action.error).map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
    </Notice>
  ) : null;

  return (
    <div className="flex flex-col gap-5">
      {agent.kind === "client" ? (
        <LineageCard
          agent={agent}
          update={update}
          templateName={template.data?.agent.name ?? null}
          baseVersion={
            templateVersion(
              live?.basedOnTemplateVersionId ?? sorted[0]?.basedOnTemplateVersionId ?? null,
            )?.version ?? null
          }
        />
      ) : (
        <UsedByCard templateId={agent.id} />
      )}

      {done ? (
        <Notice tone="positive" testId="agent-versions-done">
          {done}
        </Notice>
      ) : null}
      {failure}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <table data-testid="agent-versions" className="w-full text-left">
            <thead className="border-b border-edge bg-subtle">
              <tr className="label-caps text-secondary">
                <th className="px-4 py-2.5 font-medium">Version</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Change</th>
                <th className="px-4 py-2.5 font-medium">
                  {agent.kind === "client" ? "Template" : "By"}
                </th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 font-medium" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((v) => {
                const tv = templateVersion(v.basedOnTemplateVersionId);
                const isSelected = v.id === selected;
                return (
                  <tr
                    key={v.id}
                    data-testid={`agent-version-${v.version}`}
                    className={`border-b border-divider align-top last:border-0 ${isSelected ? "bg-selected" : ""}`}
                  >
                    <td className="px-4 py-3 font-mono">
                      <Link
                        to={`${base}/workflow?version=${v.version}`}
                        className="text-link hover:underline"
                      >
                        v{v.version}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{statusBadge(v, liveId)}</td>
                    <td className="px-4 py-3 text-body">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        data-testid={`agent-version-${v.version}-diff`}
                        onClick={() => setSelected(v.id)}
                      >
                        {v.changeNote ?? "No change note"}
                      </button>
                      {v.releaseNote ? (
                        <span className="block text-sm text-secondary">
                          Release note: {v.releaseNote}
                        </span>
                      ) : null}
                      {v.authorType !== "operator" ? (
                        <span className="block text-sm text-secondary">by {v.authorType}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-secondary">
                      {agent.kind === "client"
                        ? v.basedOnTemplateVersionId
                          ? tv
                            ? `v${tv.version}`
                            : "template"
                          : "—"
                        : v.authorType}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs whitespace-nowrap text-secondary">
                      {v.createdAt.slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {v.status === "draft" ? (
                        <Button
                          variant="primary"
                          data-testid={`agent-version-${v.version}-publish`}
                          disabled={action.busy}
                          onClick={() => publish(v)}
                        >
                          Publish
                        </Button>
                      ) : v.id !== liveId ? (
                        confirming === v.id ? (
                          <Button
                            data-testid={`agent-version-${v.version}-rollback-confirm`}
                            disabled={action.busy}
                            onClick={() => rollback(v)}
                          >
                            Roll back to v{v.version}?
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            data-testid={`agent-version-${v.version}-rollback`}
                            onClick={() => setConfirming(v.id)}
                          >
                            Roll back
                          </Button>
                        )
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        {selected ? (
          <VersionDiff agentId={agent.id} versionId={selected} versions={versions} />
        ) : null}
      </div>

      {agent.kind === "client" && agent.templateId ? (
        <CustomizationsCard agentId={agent.id} />
      ) : null}
    </div>
  );
}

function VersionDiff({
  agentId,
  versionId,
  versions,
}: {
  agentId: string;
  versionId: string;
  versions: VersionSummary[];
}) {
  const diff = useApi(apiRoutes.opsVersionDiff, { params: { id: agentId, vid: versionId } });
  const v = versions.find((x) => x.id === versionId);
  return (
    <Card className="p-5" testId="agent-version-diff">
      <SectionLabel>
        {v ? `What v${v.version} changed` : "Changes"}
        {diff.data?.from ? ` · against v${diff.data.from.version}` : ""}
      </SectionLabel>
      {diff.error ? <ErrorNotice error={diff.error} onRetry={diff.reload} /> : null}
      {!diff.data && !diff.error ? <Loading /> : null}
      {diff.data ? (
        <ChangeList
          changes={diff.data.changes}
          labels={diff.data.labels}
          testId="agent-version-diff-changes"
          empty={
            diff.data.from
              ? "Nothing changed in the bundle (only its template base)."
              : "The first version: nothing to compare against."
          }
        />
      ) : null}
    </Card>
  );
}

function LineageCard({
  agent,
  update,
  templateName,
  baseVersion,
}: {
  agent: AgentSummary;
  update: AgentDetail["update"];
  templateName: string | null;
  baseVersion: number | null;
}) {
  if (!agent.templateId) {
    return (
      <Card className="p-5" testId="agent-lineage">
        <SectionLabel>Lineage</SectionLabel>
        <p className="text-body">Written for this client from scratch: no template.</p>
      </Card>
    );
  }
  return (
    <Card className="p-5" testId="agent-lineage">
      <SectionLabel>Lineage</SectionLabel>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-body" data-testid="agent-lineage-base">
          Based on {templateName ? `template “${templateName}”` : "a template"}
          {baseVersion ? ` v${baseVersion}` : ""}
          {agent.linked ? "" : " · detached: it takes no template updates"}
        </p>
        {update?.available ? (
          <Badge tone="accent" testId="agent-lineage-update">
            Update available · {plural(update.behind, "version")} behind
          </Badge>
        ) : agent.linked ? (
          <Badge tone="positive">Up to date</Badge>
        ) : null}
      </div>
      {update?.available && update.releaseNote ? (
        <p className="mt-2 text-sm text-secondary">Release note: {update.releaseNote}</p>
      ) : null}
      {update?.available ? (
        <p className="mt-2 text-sm text-secondary">
          Applying an update merges the template's changes with this client's customizations in the
          merge view.
        </p>
      ) : null}
    </Card>
  );
}

function CustomizationsCard({ agentId }: { agentId: string }) {
  const res = useApi(apiRoutes.opsCustomizations, { params: { id: agentId } });
  return (
    <Card className="p-5" testId="agent-customizations">
      <SectionLabel>
        Customizations
        {res.data?.base && res.data.version
          ? ` · v${res.data.version.version} against template v${res.data.base.version}`
          : ""}
      </SectionLabel>
      {res.error ? <ErrorNotice error={res.error} onRetry={res.reload} /> : null}
      {!res.data && !res.error ? <Loading /> : null}
      {res.data ? (
        <ChangeList
          changes={res.data.changes}
          labels={res.data.labels}
          testId="agent-customizations-changes"
          empty="No customizations: it is the template as forked."
        />
      ) : null}
    </Card>
  );
}

function UsedByCard({ templateId }: { templateId: string }) {
  const res = useApi(apiRoutes.opsUsedBy, { params: { id: templateId } });
  return (
    <Card className="overflow-hidden" testId="template-used-by">
      <div className="px-5 pt-4">
        <SectionLabel>
          Used by
          {res.data ? ` · ${plural(res.data.agents.length, "client agent")}` : ""}
        </SectionLabel>
      </div>
      {res.error ? (
        <div className="px-5 pb-4">
          <ErrorNotice error={res.error} onRetry={res.reload} />
        </div>
      ) : null}
      {!res.data && !res.error ? (
        <div className="px-5">
          <Loading />
        </div>
      ) : null}
      {res.data && res.data.agents.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-secondary">
          Not forked into any client yet. Fork it from a client's “New agent” page.
        </p>
      ) : null}
      {res.data && res.data.agents.length > 0 ? (
        <table className="w-full text-left" data-testid="template-used-by-table">
          <thead className="border-y border-edge bg-subtle">
            <tr className="label-caps text-secondary">
              <th className="px-5 py-2.5 font-medium">Client agent</th>
              <th className="px-4 py-2.5 font-medium">Base</th>
              <th className="px-4 py-2.5 font-medium">Behind</th>
              <th className="px-4 py-2.5 font-medium">Customizations</th>
              <th className="px-4 py-2.5 font-medium">Conflicts</th>
            </tr>
          </thead>
          <tbody>
            {res.data.agents.map((u) => (
              <tr
                key={u.agent.id}
                className="border-b border-divider last:border-0"
                data-testid={`template-used-by-${u.agent.slug}`}
              >
                <td className="px-5 py-3">
                  <Link
                    to={`/ops/clients/${u.client.id}/agents/${u.agent.slug}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {u.agent.serviceName ?? u.agent.name}
                  </Link>
                  <span className="block text-sm text-secondary">
                    {u.client.name}
                    {u.agent.linked ? "" : " · detached"}
                    {u.agent.runStatus ? ` · ${u.agent.runStatus}` : ""}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono">{u.baseVersion ? `v${u.baseVersion}` : "—"}</td>
                <td className="px-4 py-3">
                  {u.behind > 0 ? (
                    <Badge tone="accent">{u.behind} behind</Badge>
                  ) : (
                    <span className="text-secondary">up to date</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono">{u.customizations}</td>
                <td className="px-4 py-3">
                  {u.conflicts === null ? (
                    <span className="text-secondary">—</span>
                  ) : u.conflicts > 0 ? (
                    <Badge tone="warning">{u.conflicts}</Badge>
                  ) : (
                    <span className="font-mono">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Card>
  );
}
