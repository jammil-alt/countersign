// The skills library (ARCHITECTURE §9.2, §15 `/ops/skills`; design screen 3): every skill an agent
// can use, by category, with what it does, its tools, in → out and how many agents use it.
// Built-in skills come with the platform and packs; operator skills are written here, shared by
// every agent or for one client, and versioned: save a draft, publish, roll back.
import type { SkillListItem } from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useSession } from "../../session/session";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  Tag,
} from "../../ui/primitives";
import { agentPath } from "../agents/BuilderParts";
import { errorText, Field, Notice, Select, TextInput, useAction } from "../agents/ui";
import { parseBundle } from "../versions";
import { SkillEditor } from "./SkillEditor";
import {
  CATEGORIES,
  categoryLabel,
  clean,
  definitionFromForm,
  EMPTY_FORM,
  formFromDefinition,
  type SkillForm,
  validateSkillForm,
} from "./skill-form";

type Library = ResponseOf<typeof apiRoutes.opsSkills>;

function connectorName(id: string, library: Library | undefined): string {
  return library?.connectors.find((c) => c.id === id)?.name ?? id;
}

function statusBadge(s: SkillListItem) {
  if (s.source === "builtin") return <Badge tone="neutral">Built in</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {s.liveVersion ? <Badge tone="positive">Live · v{s.liveVersion}</Badge> : null}
      {s.latestVersion && s.latestVersion !== s.liveVersion ? (
        <Badge tone="neutral">Draft · v{s.latestVersion}</Badge>
      ) : null}
    </span>
  );
}

function scopeLabel(s: SkillListItem): string {
  return s.source === "builtin"
    ? "Built in"
    : s.source === "shared"
      ? "Shared"
      : (s.clientName ?? "One client");
}

export function SkillsScreen() {
  const library = useApi(apiRoutes.opsSkills);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const skills = library.data?.skills ?? [];
  const categories = [
    ...new Set([...CATEGORIES.map(([id]) => id), ...skills.map((s) => s.category)]),
  ].filter((c) => skills.some((s) => s.category === c) || CATEGORIES.some(([id]) => id === c));
  const q = search.trim().toLowerCase();
  const shown = skills.filter(
    (s) =>
      (category === "all" || s.category === category) &&
      (!q ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.ref.toLowerCase().includes(q)),
  );
  const groups = categories
    .map((c) => [c, shown.filter((s) => s.category === c)] as const)
    .filter(([, list]) => list.length > 0);

  return (
    <div>
      <PageHeader
        title="Skills"
        subtitle="Building blocks for agents. Place any of these in an agent's workflow. Actions change something in a client's tools."
        actions={
          <Link to="/ops/skills/new" className={buttonClass("primary")} data-testid="skills-new">
            New skill
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <nav className="flex gap-5 border-b border-line" aria-label="Categories">
          {[["all", "All"] as const, ...categories.map((c) => [c, categoryLabel(c)] as const)].map(
            ([id, label]) => (
              <button
                type="button"
                key={id}
                data-testid={`skills-tab-${id}`}
                onClick={() => setCategory(id)}
                className={cx(
                  "-mb-px inline-flex items-center gap-1.5 border-b-2 py-3 text-sm leading-none font-medium",
                  category === id
                    ? "border-slate text-ink"
                    : "border-transparent text-ink-muted hover:text-ink",
                )}
              >
                {label}
                <span className="text-xs text-ink-muted figures">
                  {id === "all" ? skills.length : skills.filter((s) => s.category === id).length}
                </span>
              </button>
            ),
          )}
        </nav>
        <div className="w-full max-w-xs">
          <TextInput
            aria-label="Search skills"
            placeholder="Search skills"
            data-testid="skills-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          {library.error ? <ErrorNotice error={library.error} onRetry={library.reload} /> : null}
          {!library.data && !library.error ? <Loading /> : null}
          {library.data && skills.length === 0 ? (
            <EmptyState>No skills yet. Write one with New skill.</EmptyState>
          ) : null}
          {library.data && skills.length > 0 && shown.length === 0 ? (
            <EmptyState>No skill matches.</EmptyState>
          ) : null}
          {groups.length > 0 ? (
            <div className="dt dt-ana">
              <table data-testid="skills-table">
                <thead>
                  <tr className="dt-cols">
                    <th>Skill</th>
                    <th>What it does</th>
                    <th>Tools</th>
                    <th>In → out</th>
                    <th>Status</th>
                    <th className="text-right">Used by</th>
                  </tr>
                </thead>
                {groups.map(([c, list]) => (
                  <tbody key={c}>
                    <tr>
                      <th
                        colSpan={6}
                        className="eyebrow bg-surface-subtle text-left text-ink-muted"
                      >
                        {categoryLabel(c)}
                      </th>
                    </tr>
                    {list.map((s) => (
                      <tr key={s.id} data-testid={`skills-row-${s.ref}`}>
                        <td>
                          {s.source === "builtin" ? (
                            <span className="block font-medium text-ink">{s.name}</span>
                          ) : (
                            <Link
                              to={`/ops/skills/${s.id}`}
                              className="block font-medium text-ink hover:underline"
                            >
                              {s.name}
                            </Link>
                          )}
                          <span className="block text-sm text-ink-muted">{scopeLabel(s)}</span>
                        </td>
                        <td className="text-ink">{s.description}</td>
                        <td>
                          {s.connectors.length === 0 ? (
                            <span className="text-ink-muted">None</span>
                          ) : (
                            <span className="flex flex-wrap gap-1">
                              {s.connectors.map((c) => (
                                <Tag key={c}>{connectorName(c, library.data ?? undefined)}</Tag>
                              ))}
                            </span>
                          )}
                        </td>
                        <td className="reference text-ink-muted">
                          {s.inputs.join(", ") || "nothing"} → {s.outputs.join(", ") || "nothing"}
                        </td>
                        <td>{statusBadge(s)}</td>
                        <td className="text-right figures">{s.usedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          ) : null}
        </div>
        <Card className="h-fit p-5">
          <SectionLabel>Make a skill</SectionLabel>
          <p className="text-sm text-ink">
            Write what it should know or do, pick the tools it needs and give it an input and an
            output, so it fits in any workflow.
          </p>
          <p className="mt-3 text-sm text-ink-muted">
            Skills are versioned like agents. An agent that names a skill uses its live version; a
            client agent keeps the version it was published with until its next publish.
          </p>
          <Link to="/ops/skills/new" className={cx(buttonClass("secondary"), "mt-4")}>
            New skill
          </Link>
        </Card>
      </div>
    </div>
  );
}

export function NewSkillScreen() {
  const navigate = useNavigate();
  const session = useSession();
  const library = useApi(apiRoutes.opsSkills);
  const [form, setForm] = useState<SkillForm>(EMPTY_FORM);
  const [clientId, setClientId] = useState("");
  const [touched, setTouched] = useState(false);
  const action = useAction();
  const errors = validateSkillForm(form);
  const shown = touched ? errors : {};
  const clients = [...new Map(session.tenants.map((t) => [t.id, t])).values()];

  async function create() {
    setTouched(true);
    if (Object.keys(errors).length > 0 || !library.data) return;
    const res = await action.call(apiRoutes.opsCreateSkill, {
      body: {
        definition: clean(definitionFromForm(form, library.data.tools)),
        ...(clientId ? { clientId } : {}),
        changeNote: "Created",
      },
    });
    if (res.ok) navigate(`/ops/skills/${res.data.skill.id}`);
  }

  if (library.error) return <ErrorNotice error={library.error} onRetry={library.reload} />;
  if (!library.data) return <Loading />;
  return (
    <div>
      <PageHeader
        title="New skill"
        subtitle="It starts as a draft. Publish it to let agents use it."
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <SkillEditor
          form={form}
          errors={shown}
          tools={library.data.tools}
          connectors={library.data.connectors}
          slugLocked={false}
          onChange={setForm}
        />
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <SectionLabel>Who can use it</SectionLabel>
            <Field
              label="Agents"
              hint="A client's own skill is used only by that client's agents and never shared."
            >
              <Select
                data-testid="skill-scope-select"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                <option value="">Every agent (shared)</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    Only {c.name}'s agents
                  </option>
                ))}
              </Select>
            </Field>
          </Card>
          {touched && Object.keys(errors).length > 0 ? (
            <Notice tone="warning" testId="skill-form-errors">
              Some fields need a look before it can be saved.
            </Notice>
          ) : null}
          {action.error ? (
            <Notice tone="warning" testId="skill-create-error">
              {errorText(action.error)}
            </Notice>
          ) : null}
          <div className="flex justify-end gap-3">
            <Link to="/ops/skills" className={buttonClass("ghost")}>
              Cancel
            </Link>
            <Button
              variant="primary"
              data-testid="skill-create"
              disabled={action.busy}
              onClick={create}
            >
              {action.busy ? "Saving…" : "Save draft"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SkillPage() {
  const { id = "" } = useParams();
  const detail = useApi(apiRoutes.opsSkill, { params: { id } });
  const library = useApi(apiRoutes.opsSkills);
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
      onChanged={() => {
        detail.reload();
        library.reload();
      }}
    />
  );
}

function SkillPageBody({
  detail,
  library,
  onChanged,
}: {
  detail: ResponseOf<typeof apiRoutes.opsSkill>;
  library: Library;
  onChanged(): void;
}) {
  const { skill, versions, usedBy } = detail;
  const latest = versions[0];
  const [form, setForm] = useState<SkillForm>(() =>
    latest ? formFromDefinition(latest.definition) : EMPTY_FORM,
  );
  const [changeNote, setChangeNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const save = useAction();
  const versionAction = useAction();
  const errors = validateSkillForm(form);
  const shown = touched ? errors : {};

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
      setMessage(`Saved v${res.data.version.version} as a draft. Publish it to let agents use it.`);
      onChanged();
    }
  }

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

  return (
    <div>
      <PageHeader
        title={skill.name}
        badge={<span className="flex gap-1.5">{statusBadge(skill)}</span>}
        subtitle={`${scopeLabel(skill)} · ${categoryLabel(skill.category)} · ${skill.ref}`}
      />
      {message ? (
        <div className="mb-4">
          <Notice tone="positive" testId="skill-message">
            {message}
          </Notice>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-5">
          <SkillEditor
            form={form}
            errors={shown}
            tools={library.tools}
            connectors={library.connectors}
            slugLocked
            onChange={setForm}
          />
          <Card className="p-5">
            <SectionLabel>Save as a draft</SectionLabel>
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
        <div className="flex flex-col gap-4">
          <Card className="p-5" testId="skill-versions">
            <SectionLabel>Versions</SectionLabel>
            {versionAction.error ? (
              <div className="mb-3">
                <Notice tone="warning">{errorText(versionAction.error)}</Notice>
              </div>
            ) : null}
            <ul className="flex flex-col divide-y divide-line">
              {versions.map((v) => (
                <li key={v.id} className="flex items-start justify-between gap-3 py-2.5">
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
          <Card className="p-5" testId="skill-used-by">
            <SectionLabel>Used by</SectionLabel>
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
                        ? ` · pinned ${u.ref.slice(u.ref.indexOf("@") + 1)}`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <AssignCard skill={skill} onAssigned={onChanged} />
        </div>
      </div>
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
  const action = useAction();
  const agents = clientId
    ? (clientAgents.data?.agents ?? []).filter((a) => !a.testCopy && a.runStatus !== "retired")
    : (templates.data?.templates ?? []);

  async function assign() {
    const target = agents.find((a) => a.id === agentId);
    if (!target) return;
    const page = await action.call(apiRoutes.opsAgent, { params: { id: target.id } });
    if (!page.ok || !page.data.latest) return;
    const parsed = parseBundle(page.data.latest);
    if (!parsed.ok) return;
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
    <Card className="p-5" testId="skill-assign">
      <SectionLabel>Add to an agent</SectionLabel>
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
