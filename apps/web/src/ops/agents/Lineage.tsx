// Which agent this is, at a glance, under the agent bar's title (the owner's review: "two Bill
// clerks"). A client agent says whose copy of which template it is, with links to the template
// and to "Update from template" (the merge view) when it is behind; a template says that editing
// it changes no client's agent until each merges it in, and lists its client copies; a template's
// test copy points back at the template, where it should be edited.
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import type { ApiState } from "../../api/useApi";
import { useApi } from "../../api/useApi";
import { Badge } from "../../ui/primitives";
import { plural } from "./ui";

type AgentDetail = ResponseOf<typeof apiRoutes.opsAgent>;

/** "Template", "Client copy", "Test copy" or "Client agent": the badge beside the agent's name. */
export function agentKindBadge(view: AgentSummary): { label: string; tone: "accent" | "neutral" } {
  if (view.kind === "template") return { label: "Template", tone: "accent" };
  if (view.testCopy) return { label: "Test copy", tone: "neutral" };
  return { label: view.templateId ? "Client copy" : "Client agent", tone: "neutral" };
}

/** The template a client agent's version is based on, as a number ("v3"), when it is known. */
export function baseTemplateVersion(
  detail: Pick<AgentDetail, "live" | "latest" | "update">,
  template: Pick<AgentDetail, "versions"> | undefined,
): number | null {
  const baseId =
    detail.update?.baseVersionId ??
    detail.live?.basedOnTemplateVersionId ??
    detail.latest?.basedOnTemplateVersionId ??
    null;
  if (!baseId || !template) return null;
  return template.versions.find((v) => v.id === baseId)?.version ?? null;
}

export function AgentLineage({
  view,
  detail,
  clientName,
  template,
}: {
  view: AgentSummary;
  detail: Pick<AgentDetail, "live" | "latest" | "update">;
  clientName: string | undefined;
  /** The client agent's template (GET /api/ops/agents/:templateId), fetched by the page. */
  template: ApiState<AgentDetail> | null;
}) {
  if (view.kind === "template") return <TemplateLineage view={view} />;

  const client = clientName ?? "This client";
  if (!view.templateId) {
    return (
      <p className="text-sm text-ink-muted" data-testid="agent-lineage-line">
        Written for {client} from no template. Edits here change only this agent.
      </p>
    );
  }

  const templateName = template?.data?.agent.name ?? null;
  const templateSlug = template?.data?.agent.slug ?? null;
  const version = baseTemplateVersion(detail, template?.data);
  const name = templateName ? `the ${templateName} template` : "its template";
  const templateLink = templateSlug ? (
    <Link
      to={`/ops/templates/${templateSlug}`}
      className="text-link hover:underline"
      data-testid="agent-lineage-template"
    >
      {name}
      {version ? `, v${version}` : ""}
    </Link>
  ) : (
    <>
      {name}
      {version ? `, v${version}` : ""}
    </>
  );

  if (view.testCopy) {
    return (
      <p className="text-sm text-ink-muted" data-testid="agent-lineage-line">
        The test copy of {templateLink} in {client}. It only test-runs: edit the template, not this
        copy.
      </p>
    );
  }

  const update = detail.update;
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted"
      data-testid="agent-lineage-line"
    >
      <span>
        {client}'s copy of {templateLink}.{" "}
        {view.linked
          ? "Edits here change only this client's agent."
          : "Detached: it takes no template updates."}
      </span>
      {view.linked && update?.available ? (
        <Link
          to={`/ops/agents/${view.id}/merge?mode=update`}
          className="text-link hover:underline"
          data-testid="agent-lineage-update-link"
        >
          Update from template ({plural(update.behind, "version")} behind)
        </Link>
      ) : null}
    </p>
  );
}

function TemplateLineage({ view }: { view: AgentSummary }) {
  const usedBy = useApi(apiRoutes.opsUsedBy, { params: { id: view.id } });
  const copies = usedBy.data?.agents ?? [];
  return (
    <div className="flex flex-col gap-1 text-sm text-ink-muted" data-testid="agent-lineage-line">
      <p>Template. Edits here don't change clients' agents until you merge them in.</p>
      {copies.length > 0 ? (
        <p data-testid="agent-lineage-copies">
          {`Client ${copies.length === 1 ? "copy" : "copies"}: `}
          {copies.map((u, i) => (
            <span key={u.agent.id}>
              {i > 0 ? ", " : ""}
              <Link
                to={`/ops/clients/${u.client.id}/agents/${u.agent.slug}`}
                className="text-link hover:underline"
              >
                {u.client.name}
              </Link>
              {u.behind > 0 ? (
                <Badge tone="accent" className="ml-1.5">
                  {u.behind} behind
                </Badge>
              ) : null}
            </span>
          ))}
        </p>
      ) : usedBy.data ? (
        <p data-testid="agent-lineage-copies">No client has a copy yet.</p>
      ) : null}
    </div>
  );
}
