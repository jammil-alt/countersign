// An automation's page (`/ops/skills/automations/:id`; ARCHITECTURE §10.7): its step chain, what
// it takes in and needs, how clean its live uses ran in the last 30 days, its versions (publish,
// roll back) and the agents that use it. Agents move to a new version only by their own new
// version; versions are immutable, a rollback copies an older one as a new live version.
// Automations are made in the workflow builder, from selected steps ("Save as automation").
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Columns, Loaded, Page } from "../../ui/page";
import { Badge, Button, Card, PageHeader, Tag } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { agentPath } from "../agents/BuilderParts";
import { errorText, Notice, plural, useAction } from "../agents/ui";
import { toolTitle } from "../builder/model";
import { Chain, percent, SchemaCard, stepChain } from "./parts";
import { SKILLS_PATH } from "./SkillsLibrary";

export function AutomationPage() {
  const { id = "" } = useParams();
  const state = useApi(apiRoutes.opsAutomation, { params: { id } });
  const action = useAction();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <Loaded state={state}>
      {({ automation: a, versions, usedBy }) => {
        const latest = versions[0];
        const shown = versions.find((v) => v.version === a.liveVersion) ?? latest;

        async function publish(vid: string, version: number) {
          const res = await action.call(apiRoutes.opsPublishAutomation, {
            params: { id: a.id, vid },
          });
          if (res.ok) {
            setMessage(`v${version} is live. Agents move to it with their own next version.`);
            state.reload();
          }
        }
        async function rollback(vid: string, version: number) {
          const res = await action.call(apiRoutes.opsRollbackAutomation, {
            params: { id: a.id },
            body: { versionId: vid },
          });
          if (res.ok) {
            setMessage(
              `Rolled back to v${version}: it is live again as v${res.data.version.version}.`,
            );
            state.reload();
          }
        }

        return (
          <Page testId="automation-page">
            <div>
              <p className="mb-2 text-sm text-ink-muted">
                <Link to={SKILLS_PATH} className="hover:underline">
                  Skills and automations
                </Link>{" "}
                / {a.name}
              </p>
              <PageHeader
                title={a.name}
                badge={
                  <span className="flex gap-1.5">
                    {a.liveVersion ? <Badge tone="positive">Live · v{a.liveVersion}</Badge> : null}
                    {latest && latest.status === "draft" ? (
                      <Tag>Draft v{latest.version}</Tag>
                    ) : null}
                  </span>
                }
                subtitle={[
                  a.description,
                  a.source === "client"
                    ? `Only ${a.clientName ?? "one client"}'s agents.`
                    : "Shared.",
                ]
                  .filter(Boolean)
                  .join(" ")}
                actions={
                  latest && latest.status === "draft" ? (
                    <Button
                      variant="primary"
                      data-testid="automation-publish-latest"
                      disabled={action.busy}
                      onClick={() => void publish(latest.id, latest.version)}
                    >
                      Publish v{latest.version}
                    </Button>
                  ) : null
                }
              />
            </div>
            {message ? (
              <Notice tone="positive" testId="automation-message">
                {message}
              </Notice>
            ) : null}
            {action.error ? <Notice tone="warning">{errorText(action.error)}</Notice> : null}

            <Card
              title="Steps"
              meta={
                a.health.cleanRunRate !== null ? (
                  <StatusChip state="done" testId="automation-health">
                    {percent(a.health.cleanRunRate)} clean · {plural(a.health.uses, "use")} in 30
                    days
                  </StatusChip>
                ) : (
                  "No live runs in 30 days"
                )
              }
              pad
            >
              {shown && shown.definition.steps.length > 0 ? (
                <Chain items={stepChain(shown.definition.steps)} testId="automation-steps" />
              ) : (
                <p className="text-sm text-ink-muted">No steps.</p>
              )}
              <p className="mt-3 text-sm text-ink-muted">
                <span className="reference">{a.slug}</span> ·{" "}
                {a.usedBy === 0 ? "not used yet" : `used by ${plural(a.usedBy, "agent")}`}
              </p>
            </Card>

            <Columns count={2}>
              <SchemaCard title="Takes in" schema={shown?.definition.input} />
              <Card title="Needs from the agent" pad>
                <dl className="flex flex-col gap-3 text-sm">
                  {(
                    [
                      ["Skills", a.requires.skills],
                      ["Tools", a.requires.tools.map((id) => toolTitle({ id }))],
                      ["Connectors", a.requires.connectors],
                    ] as const
                  ).map(([label, list]) => (
                    <div key={label} className="flex flex-col gap-1.5">
                      <dt className="text-ink-muted">{label}</dt>
                      <dd className="flex flex-wrap gap-1.5">
                        {list.length === 0 ? (
                          <span className="text-ink-muted">None</span>
                        ) : (
                          list.map((x) => <Tag key={x}>{x}</Tag>)
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </Columns>

            <Columns count={2}>
              <Card title="Versions" testId="automation-versions">
                <ul className="divide-y divide-line">
                  {versions.map((v) => (
                    <li key={v.id} className="flex items-start justify-between gap-3 px-6 py-3.5">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-ink">
                          <span className="font-medium figures">v{v.version}</span>
                          <Badge tone={v.status === "live" ? "positive" : "neutral"}>
                            {v.status === "live"
                              ? "Live"
                              : v.status === "draft"
                                ? "Draft"
                                : "Retired"}
                          </Badge>
                        </p>
                        <p className="text-sm text-ink-muted">
                          {v.changeNote ?? "No note"} · {v.createdAt.slice(0, 10)}
                        </p>
                      </div>
                      {v.status === "draft" ? (
                        <Button
                          size="sm"
                          variant="primary"
                          data-testid={`automation-publish-${v.version}`}
                          disabled={action.busy}
                          onClick={() => void publish(v.id, v.version)}
                        >
                          Publish
                        </Button>
                      ) : v.status === "retired" && a.liveVersion ? (
                        <Button
                          size="sm"
                          data-testid={`automation-rollback-${v.version}`}
                          disabled={action.busy}
                          onClick={() => void rollback(v.id, v.version)}
                        >
                          Roll back
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title="Used by" testId="automation-used-by" pad>
                {usedBy.length === 0 ? (
                  <p className="text-sm text-ink-muted">No agent uses it yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {usedBy.map((u) => (
                      <li key={u.agentId} className="text-sm">
                        <Link
                          className="text-ink hover:underline"
                          to={agentPath({ ...u, tenantId: u.clientId })}
                        >
                          {u.name}
                        </Link>{" "}
                        <span className="text-ink-muted">
                          {u.kind === "template" ? "template" : u.clientName} · v{u.version}
                          {u.ref.includes("@")
                            ? ` · pins v${u.ref.slice(u.ref.indexOf("@") + 1)}`
                            : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </Columns>
          </Page>
        );
      }}
    </Loaded>
  );
}
