// An operator skill's page (`/ops/skills/:id`), laid out as O8 (`#O8-NewSkill`): its address in
// mono, the live or draft version, Run tests and Publish; tabs for the definition (takes in, gives
// back, how it works, and the editor that saves a new draft), its tests (cases, the latest suite
// run, whether publishing needs them), versions (publish, roll back) and the agents that use it.
// Versions are immutable (invariant 3): every save is a new draft; a rollback copies an older one.
import type { SkillListItem } from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { useSession } from "../../session/session";
import { Columns, Page } from "../../ui/page";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  Tabs,
  Tag,
} from "../../ui/primitives";
import { agentPath } from "../agents/BuilderParts";
import { errorText, Field, Notice, plural, Select, TextInput, useAction } from "../agents/ui";
import { parseAnyBundle } from "../versions";
import { SchemaCard } from "./parts";
import { SkillEditor } from "./SkillEditor";
import { SKILLS_PATH, skillPath } from "./SkillsLibrary";
import {
  categoryLabel,
  clean,
  definitionFromForm,
  EMPTY_FORM,
  formFromDefinition,
  type SkillForm,
  validateSkillForm,
} from "./skill-form";
import { TestsPanel } from "./TestsPanel";

type Library = ResponseOf<typeof apiRoutes.opsSkills>;
type Detail = ResponseOf<typeof apiRoutes.opsSkill>;
export type TestsData = ResponseOf<typeof apiRoutes.opsTests>;

const TABS = ["definition", "tests", "versions", "used-by"] as const;
type Tab = (typeof TABS)[number];

export function scopeLabel(s: SkillListItem): string {
  return s.source === "builtin"
    ? "Built in"
    : s.source === "shared"
      ? "Every agent"
      : `Only ${s.clientName ?? "one client"}'s agents`;
}

export function SkillPage() {
  const { id = "" } = useParams();
  const detail = useApi(apiRoutes.opsSkill, { params: { id } });
  const library = useApi(apiRoutes.opsSkills);
  const tests = useApi(apiRoutes.opsTests, { query: { target: `skill:${id}` } });
  if (detail.error) return <ErrorNotice error={detail.error} onRetry={detail.reload} />;
  if (library.error) return <ErrorNotice error={library.error} onRetry={library.reload} />;
  if (!detail.data || !library.data) return <Loading />;
  const latest = detail.data.versions[0];
  if (!latest) return <EmptyState>This skill has no versions.</EmptyState>;
  return (
    <SkillPageBody
      // A new latest version (saved, published, rolled back) resets the form to it.
      key={latest.id}
      detail={detail.data}
      library={library.data}
      tests={tests}
      onChanged={() => {
        detail.reload();
        library.reload();
        tests.reload();
      }}
    />
  );
}

function SkillPageBody({
  detail,
  library,
  tests,
  onChanged,
}: {
  detail: Detail;
  library: Library;
  tests: ApiState<TestsData>;
  onChanged(): void;
}) {
  const { skill, versions, usedBy } = detail;
  const latest = versions[0];
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "")
    ? (params.get("tab") as Tab)
    : "definition";
  const [message, setMessage] = useState<string | null>(null);
  const versionAction = useAction();
  const runAction = useAction();
  const builder = useAction();

  async function publish(vid: string, version: number) {
    const res = await versionAction.call(apiRoutes.opsPublishSkill, {
      params: { id: skill.id, vid },
    });
    if (res.ok) {
      setMessage(`v${version} is live.`);
      onChanged();
    }
  }

  async function rollback(vid: string, version: number) {
    const res = await versionAction.call(apiRoutes.opsRollbackSkill, {
      params: { id: skill.id },
      body: { versionId: vid },
    });
    if (res.ok) {
      setMessage(`Rolled back to v${version}: it is live again as v${res.data.version.version}.`);
      onChanged();
    }
  }

  async function runTests() {
    if (!latest) return;
    const res = await runAction.call(apiRoutes.opsRunTests, {
      body: {
        targetKind: "skill",
        targetId: skill.id,
        versionId: latest.id,
        ...(skill.clientId ? { clientId: skill.clientId } : {}),
      },
    });
    if (res.ok) {
      const r = res.data.suiteRun;
      setMessage(`Tests on v${latest.version}: ${r.passed} of ${r.total} pass.`);
      tests.reload();
    }
  }

  async function openBuilder() {
    const res = await builder.call(apiRoutes.opsStartBuilderSession, {
      body: { kind: "skill", skillId: skill.id },
    });
    if (res.ok) navigate(`/ops/skills/new?session=${res.data.session.id}`);
  }

  const lastRun = tests.data?.runs[0];
  const base = skillPath(skill.id);
  const draft = latest?.status === "draft" ? latest : null;

  return (
    <Page testId="skill-page">
      <div>
        <p className="mb-2 text-sm text-ink-muted">
          <Link to={SKILLS_PATH} className="hover:underline">
            Library · Skills
          </Link>{" "}
          / {skill.name}
        </p>
        <PageHeader
          title={<span className="reference">{skill.ref.replace(/^custom:/, "")}</span>}
          badge={
            <span className="flex gap-1.5">
              {skill.liveVersion ? (
                <Badge tone="positive">Live · v{skill.liveVersion}</Badge>
              ) : null}
              {draft ? <Tag>Draft v{draft.version}</Tag> : null}
            </span>
          }
          subtitle={`${skill.name}. ${skill.description} ${scopeLabel(skill)}.`}
          actions={
            <>
              <Button
                variant="ghost"
                data-testid="skill-open-builder"
                disabled={builder.busy}
                onClick={openBuilder}
              >
                Change with the Builder
              </Button>
              <Button data-testid="skill-run-tests" disabled={runAction.busy} onClick={runTests}>
                {runAction.busy ? "Running…" : "Run tests"}
              </Button>
              {draft ? (
                <Button
                  variant="primary"
                  data-testid="skill-publish-latest"
                  disabled={versionAction.busy}
                  onClick={() => publish(draft.id, draft.version)}
                >
                  Publish v{draft.version}
                </Button>
              ) : null}
            </>
          }
        />
      </div>
      {message ? (
        <Notice tone="positive" testId="skill-message">
          {message}
        </Notice>
      ) : null}
      {[versionAction.error, runAction.error, builder.error].map((e, i) =>
        e ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: three fixed slots.
          <Notice key={i} tone="warning" testId="skill-action-error">
            {errorText(e)}
          </Notice>
        ) : null,
      )}
      <div className="flex flex-col gap-6">
        <Tabs
          items={[
            { to: `${base}`, label: "Definition", active: tab === "definition", end: true },
            {
              to: `${base}?tab=tests`,
              label: lastRun ? `Tests · ${lastRun.passed}/${lastRun.total}` : "Tests",
              active: tab === "tests",
            },
            {
              to: `${base}?tab=versions`,
              label: "Versions",
              count: versions.length,
              active: tab === "versions",
            },
            {
              to: `${base}?tab=used-by`,
              label: "Used by",
              // Client agents only, as the library counts them (templates are listed apart).
              count: usedBy.filter((u) => u.kind === "client").length,
              active: tab === "used-by",
            },
          ]}
        />
        {tab === "definition" ? (
          <DefinitionTab detail={detail} library={library} onChanged={onChanged} />
        ) : tab === "tests" ? (
          <TestsPanel skill={skill} tests={tests} onChanged={tests.reload} />
        ) : tab === "versions" ? (
          <Card testId="skill-versions">
            <ul className="divide-y divide-line">
              {versions.map((v) => (
                <li key={v.id} className="flex items-start justify-between gap-3 px-6 py-3.5">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-ink">
                      <span className="font-medium figures">v{v.version}</span>
                      <Badge tone={v.status === "live" ? "positive" : "neutral"}>
                        {v.status === "live" ? "Live" : v.status === "draft" ? "Draft" : "Retired"}
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
                      data-testid={`skill-publish-${v.version}`}
                      disabled={versionAction.busy}
                      onClick={() => publish(v.id, v.version)}
                    >
                      Publish
                    </Button>
                  ) : v.status === "retired" && skill.liveVersion ? (
                    <Button
                      size="sm"
                      data-testid={`skill-rollback-${v.version}`}
                      disabled={versionAction.busy}
                      onClick={() => rollback(v.id, v.version)}
                    >
                      Roll back
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Columns count={2}>
            <Card title="Agents that use it" testId="skill-used-by" pad>
              {usedBy.length === 0 ? (
                <p className="text-sm text-ink-muted">No agent uses it yet.</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {(["client", "template"] as const).map((kind) => {
                    const list = usedBy.filter((u) => u.kind === kind);
                    if (list.length === 0) return null;
                    return (
                      <div key={kind} data-testid={`skill-used-by-${kind}`}>
                        <SectionLabel>
                          {kind === "client"
                            ? plural(list.length, "client agent")
                            : `${plural(list.length, "template")} · not counted as uses`}
                        </SectionLabel>
                        <ul className="flex flex-col gap-1.5">
                          {list.map((u) => (
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
                                  ? ` · pinned ${u.ref.slice(u.ref.indexOf("@") + 1)}`
                                  : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
            <AssignCard skill={skill} onAssigned={onChanged} />
          </Columns>
        )}
      </div>
    </Page>
  );
}

function DefinitionTab({
  detail,
  library,
  onChanged,
}: {
  detail: Detail;
  library: Library;
  onChanged(): void;
}) {
  const { skill, versions } = detail;
  const latest = versions[0];
  const [form, setForm] = useState<SkillForm>(() =>
    latest ? formFromDefinition(latest.definition) : EMPTY_FORM,
  );
  const [changeNote, setChangeNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useAction();
  const errors = validateSkillForm(form);
  const def = latest?.definition;
  const toolNames = (def?.tools ?? []).map(
    (id) => library.tools.find((t) => t.id === id)?.description ?? id,
  );

  async function saveDraft() {
    setTouched(true);
    if (Object.keys(errors).length > 0 || !latest) return;
    const res = await save.call(apiRoutes.opsSaveSkillVersion, {
      params: { id: skill.id },
      body: {
        definition: clean(definitionFromForm(form, library.tools, latest.definition)),
        parentVersionId: latest.id,
        ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
      },
    });
    if (res.ok) {
      setSaved(`Saved v${res.data.version.version} as a draft. Publish it to let agents use it.`);
      onChanged();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Columns count={2}>
        <SchemaCard
          title="Takes in"
          schema={def?.input}
          badge={<Tag>{categoryLabel(skill.category)}</Tag>}
          testId="skill-takes-in"
        />
        <SchemaCard title="Gives back" schema={def?.output} testId="skill-gives-back" />
      </Columns>
      <p className="text-sm text-ink-muted" data-testid="skill-tools-line">
        {toolNames.length === 0
          ? "Tools it may use: none. It only reads what the step gives it."
          : `Tools it may use: ${toolNames.join(", ")}.`}
      </p>
      <SkillEditor
        form={form}
        errors={touched ? errors : {}}
        tools={library.tools}
        connectors={library.connectors}
        slugLocked
        onChange={setForm}
      />
      <Card title="Save as a draft" pad>
        <Field label="Change note" hint="What changed, for the version history.">
          <TextInput
            data-testid="skill-change-note-input"
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
          />
        </Field>
        {save.error ? (
          <div className="mt-3">
            <Notice tone="warning" testId="skill-save-error">
              {(save.error as { code?: string }).code === "no_op"
                ? `Nothing changed since v${latest?.version}, so no version was saved.`
                : errorText(save.error)}
            </Notice>
          </div>
        ) : null}
        {saved ? (
          <div className="mt-3">
            <Notice tone="positive" testId="skill-saved">
              {saved}
            </Notice>
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            data-testid="skill-save"
            disabled={save.busy}
            onClick={saveDraft}
          >
            {save.busy ? "Saving…" : "Save draft"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** Adds the skill to an agent: a new draft of that agent with the skill in its list. */
function AssignCard({ skill, onAssigned }: { skill: SkillListItem; onAssigned(): void }) {
  const session = useSession();
  const templates = useApi(apiRoutes.opsTemplates);
  const clients = [...new Map(session.tenants.map((t) => [t.id, t])).values()];
  const [clientId, setClientId] = useState(skill.clientId ?? "");
  const clientAgents = useApi(
    apiRoutes.opsClientAgents,
    clientId ? { params: { id: clientId } } : null,
  );
  const [agentId, setAgentId] = useState("");
  const [done, setDone] = useState<{ path: string; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const action = useAction();
  const agents = clientId
    ? (clientAgents.data?.agents ?? []).filter((a) => !a.testCopy && a.runStatus !== "retired")
    : (templates.data?.templates ?? []);

  async function assign() {
    const target = agents.find((a) => a.id === agentId);
    if (!target) return;
    setProblem(null);
    const page = await action.call(apiRoutes.opsAgent, { params: { id: target.id } });
    if (!page.ok || !page.data.latest) return;
    // Wave 3b: a v4 version is read and saved back as v4; only `definition.skills` changes.
    const parsed = parseAnyBundle(page.data.latest);
    if (!parsed.ok) {
      setProblem(`We couldn't read ${target.name}'s latest version. ${parsed.message}`);
      return;
    }
    const bundle = parsed.bundle;
    if (bundle.definition.skills.some((s) => s.skill.split("@")[0] === skill.ref)) {
      setDone({ path: agentPath(target), text: `${target.name} already uses it.` });
      return;
    }
    bundle.definition.skills.push({ skill: skill.ref, settings: {} });
    const res = await action.call(apiRoutes.opsSaveVersion, {
      params: { id: target.id },
      body: {
        bundle,
        parentVersionId: page.data.latest.id,
        changeNote: `Added the skill ${skill.name}`,
      },
    });
    if (res.ok) {
      setDone({
        path: `${agentPath(target)}/settings`,
        text: `Saved v${res.data.version.version} of ${target.name} as a draft with ${skill.name}.`,
      });
      onAssigned();
    }
  }

  return (
    <Card title="Add to an agent" pad testId="skill-assign">
      {!skill.liveVersion ? (
        <p className="text-sm text-ink-muted">Publish a version first.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {skill.clientId ? null : (
            <Field label="Where">
              <Select
                data-testid="skill-assign-client-select"
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setAgentId("");
                }}
              >
                <option value="">Templates</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Agent">
            <Select
              data-testid="skill-assign-agent-select"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="">Choose an agent…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.serviceName ?? a.name}
                </option>
              ))}
            </Select>
          </Field>
          {action.error ? <Notice tone="warning">{errorText(action.error)}</Notice> : null}
          {problem ? (
            <Notice tone="warning" testId="skill-assign-problem">
              {problem}
            </Notice>
          ) : null}
          {done ? (
            <Notice tone="positive" testId="skill-assign-done">
              {done.text}{" "}
              <Link className="underline" to={done.path}>
                Open it
              </Link>
            </Notice>
          ) : null}
          <div className="flex justify-end">
            <Button
              data-testid="skill-assign-submit"
              disabled={!agentId || action.busy}
              onClick={assign}
            >
              {action.busy ? "Adding…" : "Add as a draft"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
