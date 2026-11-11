// The Versions tab (ARCHITECTURE §9.3, §10.5 "Versions"): history with change notes and status
// badges, each version's readable diff against its parent, publish a draft, roll back to an older
// version. On a client agent: "Based on template vN", update available, and its customizations
// against the template; on a template: "Used by", with versions behind and open conflicts. The
// test bench sits with them (the owner's review: test before you publish, beside the versions).
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionSummary } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../../ui/primitives";
import { ChangeList } from "./ChangeList";
import { detailMessages, errorText, Notice, plural, Select, useAction } from "./ui";

export type AgentDetail = ResponseOf<typeof apiRoutes.opsAgent>;

const RUN_WORDS: Record<string, string> = {
  active: "running",
  paused: "paused",
  retired: "retired",
  draft: "not started",
};

/** "retired" → "Retired": statuses read in sentence case. */
function sentence(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Who made a version, in words: "the Builder", "a template update". */
export const AUTHOR_WORDS: Record<string, string> = {
  operator: "us",
  builder: "the Builder",
  pack: "its pack",
  merge: "a template update",
  promote: "a promotion",
};

function statusBadge(v: VersionSummary, liveId: string | null) {
  if (v.id === liveId) return <Badge tone="positive">Live</Badge>;
  if (v.status === "draft") return <Badge tone="neutral">Draft</Badge>;
  return <Badge tone="neutral">{sentence(v.status)}</Badge>;
}

export function VersionsTab({
  agent,
  versions,
  liveId,
  base,
  update,
  template,
  tests,
  onChanged,
}: {
  agent: AgentSummary;
  versions: VersionSummary[];
  liveId: string | null;
  base: string;
  update: AgentDetail["update"];
  /**
   * A client agent's template (GET /api/ops/agents/:templateId) when the agent page has fetched
   * it already; left out, the tab fetches it itself.
   */
  template?: ApiState<AgentDetail> | null;
  /** The test bench, shown with the versions. */
  tests?: ReactNode;
  onChanged(): void;
}) {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const [selected, setSelected] = useState<string | null>(sorted[0]?.id ?? null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The version whose button was pressed: it says "Publishing…" until the server answers (1.8).
  const [pressed, setPressed] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();
  const own = useApi(
    apiRoutes.opsAgent,
    template === undefined && agent.kind === "client" && agent.templateId
      ? { params: { id: agent.templateId } }
      : null,
  );
  const tpl = template === undefined ? own : template;
  const templateVersion = (id: string | null) =>
    id ? tpl?.data?.versions.find((v) => v.id === id) : undefined;
  const live = versions.find((v) => v.id === liveId) ?? null;

  if (versions.length === 0) return <EmptyState>No versions yet.</EmptyState>;

  async function publish(v: VersionSummary) {
    setPressed(v.id);
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
    setPressed(v.id);
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
          hasLive={liveId !== null}
          templateVersions={tpl?.data?.versions ?? []}
          onChanged={onChanged}
          templateName={tpl?.data?.agent.name ?? null}
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
        <div className="dt dt-ana self-start">
          <table data-testid="agent-versions">
            <thead>
              <tr className="dt-cols">
                <th>Version</th>
                <th>Status</th>
                <th>Change</th>
                <th>{agent.kind === "client" ? "Template" : "By"}</th>
                <th>Created</th>
                <th aria-label="Actions" />
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
                    className={isSelected ? "[&>td]:bg-slate-tint" : undefined}
                  >
                    <td className="figures">
                      <Link
                        to={`${base}/workflow?version=${v.version}`}
                        className="text-link hover:underline"
                      >
                        v{v.version}
                      </Link>
                    </td>
                    <td>{statusBadge(v, liveId)}</td>
                    <td className="text-ink">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        data-testid={`agent-version-${v.version}-diff`}
                        onClick={() => setSelected(v.id)}
                      >
                        {v.changeNote ?? "No change note"}
                      </button>
                      {v.releaseNote ? (
                        <span className="block text-sm text-ink-muted">
                          Release note: {v.releaseNote}
                        </span>
                      ) : null}
                      {v.authorType !== "operator" ? (
                        <span className="block text-sm text-ink-muted">
                          by {AUTHOR_WORDS[v.authorType] ?? v.authorType}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {agent.kind === "client"
                        ? v.basedOnTemplateVersionId
                          ? tv
                            ? `v${tv.version}`
                            : "template"
                          : "—"
                        : (AUTHOR_WORDS[v.authorType] ?? v.authorType)}
                    </td>
                    <td className="text-sm whitespace-nowrap figures">
                      {v.createdAt.slice(0, 10)}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {v.status === "draft" && v.id !== liveId ? (
                        <Button
                          variant="primary"
                          data-testid={`agent-version-${v.version}-publish`}
                          disabled={action.busy}
                          onClick={() => publish(v)}
                        >
                          {action.busy && pressed === v.id ? "Publishing…" : "Publish"}
                        </Button>
                      ) : v.id !== liveId ? (
                        // The confirm stays, disabled and saying so, until the answer (1.8).
                        confirming === v.id || (action.busy && pressed === v.id) ? (
                          <Button
                            data-testid={`agent-version-${v.version}-rollback-confirm`}
                            disabled={action.busy}
                            onClick={() => rollback(v)}
                          >
                            {action.busy && pressed === v.id
                              ? "Rolling back…"
                              : `Roll back to v${v.version}?`}
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
        </div>
        {selected ? (
          <VersionDiff agentId={agent.id} versionId={selected} versions={versions} />
        ) : null}
      </div>

      {tests ? (
        <section className="flex flex-col gap-4" id="tests" data-testid="agent-versions-tests">
          <div>
            <h2 className="type-subheading text-ink">Test before you publish</h2>
            <p className="text-sm text-ink-muted">
              Run the cases against a version. Test runs never write to a client's tools.
            </p>
          </div>
          {tests}
        </section>
      ) : null}

      {agent.kind === "client" && agent.templateId ? (
        <CustomizationsCard key={liveId ?? "none"} agentId={agent.id} />
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
  hasLive,
  templateVersions,
  onChanged,
  templateName,
  baseVersion,
}: {
  agent: AgentSummary;
  update: AgentDetail["update"];
  hasLive: boolean;
  templateVersions: VersionSummary[];
  onChanged(): void;
  templateName: string | null;
  baseVersion: number | null;
}) {
  const action = useAction();
  const [confirmDetach, setConfirmDetach] = useState(false);
  const published = [...templateVersions]
    .filter((v) => v.status !== "draft")
    .sort((a, b) => b.version - a.version);
  const [relinkTo, setRelinkTo] = useState<string>("");
  const relinkChoice = relinkTo || published[0]?.id || "";

  if (!agent.templateId) {
    return (
      <Card className="p-5" testId="agent-lineage">
        <SectionLabel>Lineage</SectionLabel>
        <p className="text-ink">Written for this client from scratch: no template.</p>
      </Card>
    );
  }

  async function detach() {
    setConfirmDetach(false);
    const res = await action.call(apiRoutes.opsDetach, { params: { id: agent.id } });
    if (res.ok) onChanged();
  }
  async function relink() {
    const res = await action.call(apiRoutes.opsRelink, {
      params: { id: agent.id },
      body: { templateVersionId: relinkChoice },
    });
    if (res.ok) onChanged();
  }

  return (
    <Card className="p-5" testId="agent-lineage">
      <SectionLabel>Lineage</SectionLabel>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-ink" data-testid="agent-lineage-base">
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
        <p className="mt-2 text-sm text-ink-muted">Release note: {update.releaseNote}</p>
      ) : null}
      {update?.available ? (
        <p className="mt-2 text-sm text-ink-muted">
          Applying an update merges the template's changes with this client's customizations in the
          merge view.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {agent.linked && update?.available ? (
          <Link
            to={`/ops/agents/${agent.id}/merge?mode=update`}
            className={buttonClass("primary")}
            data-testid="agent-lineage-review-update"
          >
            Review update
          </Link>
        ) : null}
        {hasLive ? (
          <Link
            to={`/ops/agents/${agent.id}/merge?mode=promote`}
            className={buttonClass("secondary")}
            data-testid="agent-lineage-promote"
          >
            Promote to template
          </Link>
        ) : null}
        {agent.linked ? (
          confirmDetach ? (
            <Button
              data-testid="agent-lineage-detach-confirm"
              disabled={action.busy}
              onClick={detach}
            >
              {action.busy ? "Detaching…" : "Detach? It will take no more updates"}
            </Button>
          ) : (
            <Button
              variant="ghost"
              data-testid="agent-lineage-detach"
              onClick={() => setConfirmDetach(true)}
            >
              Detach
            </Button>
          )
        ) : hasLive && published.length > 0 ? (
          <span className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Template version"
              className="w-40"
              value={relinkChoice}
              onChange={(e) => setRelinkTo(e.target.value)}
              data-testid="agent-lineage-relink-version"
            >
              {published.map((v) => (
                <option key={v.id} value={v.id}>
                  Template v{v.version}
                  {v.status === "live" ? " (live)" : ""}
                </option>
              ))}
            </Select>
            <Button
              data-testid="agent-lineage-relink"
              disabled={action.busy || !relinkChoice}
              onClick={relink}
            >
              {action.busy ? "Re-linking…" : "Re-link as its base"}
            </Button>
          </span>
        ) : null}
      </div>
      {action.error ? (
        <div className="mt-3">
          <Notice tone="warning" testId="agent-lineage-error">
            {errorText(action.error)}
          </Notice>
        </div>
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
        <p className="px-5 pb-4 text-sm text-ink-muted">
          Not forked into any client yet. Fork it from a client's “New agent” page.
        </p>
      ) : null}
      {res.data && res.data.agents.length > 0 ? (
        <div className="dt dt-ana rounded-none border-x-0 border-b-0">
          <table data-testid="template-used-by-table">
            <thead>
              <tr className="dt-cols">
                <th>Client agent</th>
                <th>Base</th>
                <th>Behind</th>
                <th className="n">Customizations</th>
                <th>Conflicts</th>
              </tr>
            </thead>
            <tbody>
              {res.data.agents.map((u) => (
                <tr key={u.agent.id} data-testid={`template-used-by-${u.agent.slug}`}>
                  <td>
                    <Link
                      to={`/ops/clients/${u.client.id}/agents/${u.agent.slug}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {u.agent.serviceName ?? u.agent.name}
                    </Link>
                    <span className="block text-sm text-ink-muted">
                      {u.client.name}
                      {u.agent.linked ? "" : " · detached"}
                      {u.agent.runStatus
                        ? ` · ${RUN_WORDS[u.agent.runStatus] ?? u.agent.runStatus}`
                        : ""}
                    </span>
                  </td>
                  <td className="figures">{u.baseVersion ? `v${u.baseVersion}` : "—"}</td>
                  <td>
                    {u.behind > 0 ? (
                      <Badge tone="accent">{u.behind} behind</Badge>
                    ) : (
                      <span className="text-ink-muted">Up to date</span>
                    )}
                  </td>
                  <td className="figures">{u.customizations}</td>
                  <td>
                    {u.conflicts === null ? (
                      <span className="text-ink-muted">—</span>
                    ) : u.conflicts > 0 ? (
                      <Badge tone="warning">{plural(u.conflicts, "conflict")}</Badge>
                    ) : (
                      <span className="figures">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
