// The Loop designer (docs/step-model-plan.md §8, owner 2026-11-25), in the Agent lab, laid out as
// the skill page is: its address, the live or draft version, Run the test set and Publish; tabs for
// the design, the test and the versions. A Loop is a model working toward a goal with read actions,
// choosing each next call from what the last one returned, until it is done or out of turns. It is
// saved as a skill (agent mode, reads only) and used as a Loop step, or as the whole workflow.
// Versions are immutable (invariant 3): every save is a new draft. It can't be published until its
// whole test set passes on that version. A Loop never writes: a step after it saves what it decides.
import { isUuid, type SkillDefinition, type ToolSpec } from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../../api/client";
import { apiRoutes } from "../../../api/routes";
import { type ApiState, useApi } from "../../../api/useApi";
import { EN } from "../../../i18n/i18n";
import { useSession } from "../../../session/session";
import { Page } from "../../../ui/page";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  Tabs,
  Tag,
} from "../../../ui/primitives";
import { errorText, Field, Notice, Select, TextArea, TextInput, useAction } from "../../agents/ui";
import { OPS_PATHS } from "../../paths";
import { FieldsEditor } from "../../skills/SkillEditor";
import { slugify } from "../../skills/skill-form";
import { LoopTest } from "./LoopTest";
import {
  AT_LIMIT_LABEL,
  type AtLimit,
  EMPTY_LOOP,
  formFromLoop,
  type LoopForm,
  type LoopReview,
  loopDefinition,
  loopProblems,
  REVIEW_LABEL,
  validateLoop,
} from "./loop-form";
import { loopPath, NEW_LOOP_PATH } from "./paths";
import { ReadsPicker } from "./ReadsPicker";

const TABS = ["design", "test", "versions"] as const;
type Tab = (typeof TABS)[number];

function Breadcrumb({ name }: { name: string }) {
  return (
    <p className="mb-2 text-sm text-ink-muted">
      <Link to={OPS_PATHS.lab} className="hover:underline">
        Agent lab
      </Link>{" "}
      / Loop designer / {name}
    </p>
  );
}

/** `/ops/lab/loops/new`: a Loop written from nothing, saved as a draft. */
export function NewLoopScreen() {
  const library = useApi(apiRoutes.opsSkills);
  const navigate = useNavigate();
  const session = useSession();
  const [form, setForm] = useState<LoopForm>(EMPTY_LOOP);
  const [clientId, setClientId] = useState("");
  const [touched, setTouched] = useState(false);
  const action = useAction();
  const clients = [...new Map(session.tenants.map((t) => [t.id, t])).values()];
  if (library.error) return <ErrorNotice error={library.error} onRetry={library.reload} />;
  if (!library.data) return <Loading />;
  const { tools } = library.data;
  const errors = validateLoop(form);

  async function create() {
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    const res = await action.call(apiRoutes.opsCreateSkill, {
      body: {
        definition: loopDefinition(form),
        ...(clientId ? { clientId } : {}),
        changeNote: "Created",
      },
    });
    if (res.ok) navigate(`${loopPath(res.data.skill.id)}?tab=test`);
  }

  return (
    <Page testId="new-loop">
      <div>
        <Breadcrumb name="New Loop" />
        <PageHeader
          title="New Loop"
          subtitle="A model works toward a goal with read actions, choosing each next call from what the last one returned. It never changes anything: a step after it saves what it decides."
        />
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="min-w-0 flex-[999_1_560px]">
          <DesignForm
            form={form}
            errors={touched ? errors : {}}
            library={library.data}
            slugLocked={false}
            onChange={setForm}
          />
        </div>
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <Card title="Who can use it" pad>
            <Field
              label="Agents"
              hint="A client's own Loop is used only by that client's agents and never shared."
            >
              <Select
                data-testid="loop-scope"
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
          <Problems form={form} tools={tools} />
          {action.error ? (
            <Notice tone="warning" testId="loop-create-error">
              {errorText(action.error)}
            </Notice>
          ) : null}
          <div className="flex justify-end gap-3">
            <Link to={OPS_PATHS.lab} className={buttonClass("ghost")}>
              Cancel
            </Link>
            <Button
              variant="primary"
              data-testid="loop-create"
              disabled={action.busy}
              onClick={create}
            >
              {action.busy ? "Saving…" : "Save draft"}
            </Button>
          </div>
        </div>
      </div>
    </Page>
  );
}

/** What the server would refuse on a save, as it is typed. */
function Problems({ form, tools }: { form: LoopForm; tools: ToolSpec[] }) {
  const problems = loopProblems(form, tools).filter((p) => !p.startsWith("Pick at least"));
  if (problems.length === 0) return null;
  return (
    <Notice tone="warning" testId="loop-problems">
      {problems.join(" ")}
    </Notice>
  );
}

/** `/ops/lab/loops/:id`: a saved Loop. */
export function LoopPage() {
  const { id = "" } = useParams();
  const known = isUuid(id);
  const detail = useApi(apiRoutes.opsSkill, known ? { params: { id } } : null);
  const library = useApi(apiRoutes.opsSkills);
  const tests = useApi(apiRoutes.opsTests, known ? { query: { target: `skill:${id}` } } : null);
  if (!known)
    return <EmptyState testId="loop-not-found">There is no Loop at this address.</EmptyState>;
  if (detail.error) return <ErrorNotice error={detail.error} onRetry={detail.reload} />;
  if (library.error) return <ErrorNotice error={library.error} onRetry={library.reload} />;
  if (!detail.data || !library.data) return <Loading />;
  const latest = detail.data.versions[0];
  if (!latest) return <EmptyState>This Loop has no versions.</EmptyState>;
  const def = latest.definition as SkillDefinition;
  if (!def.loop) {
    return (
      <EmptyState testId="loop-not-a-loop">
        This skill isn't a Loop.{" "}
        <Link to={`/ops/skills/${id}`} className="underline">
          Open it as a skill
        </Link>
        .
      </EmptyState>
    );
  }
  return (
    <LoopBody
      // A new latest version (saved, published) resets the form to it.
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

function LoopBody({
  detail,
  library,
  tests,
  onChanged,
}: {
  detail: ResponseOf<typeof apiRoutes.opsSkill>;
  library: ResponseOf<typeof apiRoutes.opsSkills>;
  tests: ApiState<ResponseOf<typeof apiRoutes.opsTests>>;
  onChanged(): void;
}) {
  const { skill, versions } = detail;
  const latest = versions[0];
  const def = latest?.definition as SkillDefinition;
  const [params] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "")
    ? (params.get("tab") as Tab)
    : "design";
  const [form, setForm] = useState<LoopForm>(() => formFromLoop(def));
  const [touched, setTouched] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const save = useAction();
  const publishing = useAction();
  const base = loopPath(skill.id);
  const draft = latest?.status === "draft" ? latest : null;
  const errors = validateLoop(form);
  const lastRun = tests.data?.runs[0];

  async function saveDraft() {
    setTouched(true);
    if (Object.keys(errors).length > 0 || !latest) return;
    const res = await save.call(apiRoutes.opsSaveSkillVersion, {
      params: { id: skill.id },
      body: {
        definition: loopDefinition(form),
        parentVersionId: latest.id,
        changeNote: "Changed in the Loop designer",
      },
    });
    if (res.ok) {
      setMessage(
        `Saved as draft v${res.data.version.version}. Run its test set before publishing.`,
      );
      onChanged();
    }
  }

  async function publish(vid: string, version: number) {
    const res = await publishing.call(apiRoutes.opsPublishSkill, {
      params: { id: skill.id, vid },
    });
    if (res.ok) {
      setMessage(`v${version} is live.`);
      onChanged();
    }
  }

  return (
    <Page testId="loop-page">
      <div>
        <Breadcrumb name={skill.name} />
        <PageHeader
          title={<span className="reference">{skill.ref.replace(/^custom:/, "")}</span>}
          badge={
            <span className="flex gap-1.5">
              <Tag testId="loop-page-kind">Loop</Tag>
              {skill.liveVersion ? (
                <Badge tone="positive">Live · v{skill.liveVersion}</Badge>
              ) : null}
              {draft ? <Tag>Draft v{draft.version}</Tag> : null}
            </span>
          }
          subtitle={`${skill.name}. ${skill.description}`}
          actions={
            draft ? (
              <Button
                variant="primary"
                data-testid="loop-publish-latest"
                disabled={publishing.busy}
                onClick={() => publish(draft.id, draft.version)}
              >
                Publish v{draft.version}
              </Button>
            ) : null
          }
        />
      </div>
      {message ? (
        <Notice tone="positive" testId="loop-message">
          {message}
        </Notice>
      ) : null}
      {publishing.error ? (
        <Notice tone="warning" testId="loop-publish-error">
          {errorText(publishing.error)}
        </Notice>
      ) : null}
      <div className="flex flex-col gap-6">
        <Tabs
          items={[
            { to: base, label: "Design", active: tab === "design", end: true },
            {
              to: `${base}?tab=test`,
              label: lastRun ? `Test · ${lastRun.passed}/${lastRun.total}` : "Test",
              active: tab === "test",
            },
            {
              to: `${base}?tab=versions`,
              label: "Versions",
              count: versions.length,
              active: tab === "versions",
            },
          ]}
        />
        {tab === "design" ? (
          <div className="flex flex-wrap items-start gap-6">
            <div className="min-w-0 flex-[999_1_560px]">
              <DesignForm
                form={form}
                errors={touched ? errors : {}}
                library={library}
                slugLocked
                onChange={setForm}
              />
            </div>
            <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
              <Problems form={form} tools={library.tools} />
              {save.error ? (
                <Notice tone="warning" testId="loop-save-error">
                  {errorText(save.error)}
                </Notice>
              ) : null}
              <div className="flex justify-end gap-3">
                <Button
                  variant="primary"
                  data-testid="loop-save"
                  disabled={save.busy}
                  onClick={saveDraft}
                >
                  {save.busy ? "Saving…" : "Save as a new draft"}
                </Button>
              </div>
            </div>
          </div>
        ) : tab === "test" ? (
          <LoopTest skill={skill} version={latest} tests={tests} onChanged={tests.reload} />
        ) : (
          <Card testId="loop-versions">
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
                      {v.changeNote ?? "No note"} · {EN.fmt.date(v.createdAt)}
                    </p>
                  </div>
                  {v.status === "draft" ? (
                    <Button
                      size="sm"
                      variant="primary"
                      data-testid={`loop-publish-${v.version}`}
                      disabled={publishing.busy}
                      onClick={() => publish(v.id, v.version)}
                    >
                      Publish
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="border-t border-line px-6 py-3 text-sm text-ink-muted">
              A Loop publishes only when its whole test set passes on that version. An older version
              comes back as a new draft, tested again.
            </p>
          </Card>
        )}
      </div>
    </Page>
  );
}

function DesignForm({
  form,
  errors,
  library,
  slugLocked,
  onChange,
}: {
  form: LoopForm;
  errors: Record<string, string>;
  library: { tools: ToolSpec[]; connectors: { id: string; name: string }[] };
  slugLocked: boolean;
  onChange(next: LoopForm): void;
}) {
  const [slugEdited, setSlugEdited] = useState(false);
  const set = <K extends keyof LoopForm>(key: K, value: LoopForm[K]) =>
    onChange({ ...form, [key]: value });
  return (
    <div className="flex flex-col gap-5" data-testid="loop-design">
      <Card className="p-5">
        <SectionLabel>What it does</SectionLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" error={errors.name}>
            <TextInput
              data-testid="loop-name"
              value={form.name}
              invalid={Boolean(errors.name)}
              onChange={(e) =>
                onChange({
                  ...form,
                  name: e.target.value,
                  ...(slugEdited || slugLocked ? {} : { slug: slugify(e.target.value) }),
                })
              }
            />
          </Field>
          <Field
            label="Id"
            error={errors.slug}
            hint={
              slugLocked ? "Steps name it by this; it can't change." : "Steps name it custom:<id>."
            }
          >
            <TextInput
              data-testid="loop-slug"
              value={form.slug}
              disabled={slugLocked}
              invalid={Boolean(errors.slug)}
              onChange={(e) => {
                setSlugEdited(true);
                set("slug", e.target.value);
              }}
            />
          </Field>
          <Field label="In one sentence" error={errors.description} className="md:col-span-2">
            <TextInput
              data-testid="loop-description"
              value={form.description}
              invalid={Boolean(errors.description)}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
          <Field
            label="Goal"
            error={errors.goal}
            className="md:col-span-2"
            hint="What 'done' means. It keeps going until it can say this."
          >
            <TextArea
              data-testid="loop-goal"
              rows={3}
              value={form.goal}
              invalid={Boolean(errors.goal)}
              onChange={(e) => set("goal", e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <SectionLabel>What it gets</SectionLabel>
        <FieldsEditor
          side="input"
          rows={form.input}
          errors={errors}
          onChange={(r) => set("input", r)}
        />
      </Card>

      <Card className="p-5">
        <SectionLabel>What it hands back</SectionLabel>
        <FieldsEditor
          side="output"
          rows={form.output}
          errors={errors}
          onChange={(r) => set("output", r)}
        />
      </Card>

      <Card className="p-5">
        <SectionLabel>What it may read with</SectionLabel>
        <p className="mb-3 text-sm text-ink-muted">
          Read actions only, through the client's connections and our areas. It never changes
          anything: a step after it saves what it decides.
        </p>
        <ReadsPicker
          tools={library.tools}
          connectors={library.connectors}
          value={form.reads}
          error={errors.reads}
          onChange={(r) => set("reads", r)}
        />
      </Card>

      <Card className="p-5">
        <SectionLabel>How it works</SectionLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Instructions"
            className="md:col-span-2"
            hint="How to look into it, in plain language: what to check first, what to leave alone."
          >
            <TextArea
              data-testid="loop-instructions"
              rows={6}
              value={form.instructions}
              onChange={(e) => set("instructions", e.target.value)}
            />
          </Field>
          <Field label="Most turns" error={errors.maxTurns} hint="Each turn is one model call.">
            <TextInput
              data-testid="loop-max-turns"
              type="number"
              min={1}
              max={50}
              value={String(form.maxTurns)}
              invalid={Boolean(errors.maxTurns)}
              onChange={(e) => set("maxTurns", Number(e.target.value))}
            />
          </Field>
          <Field label="At the limit">
            <Select
              data-testid="loop-at-limit"
              value={form.atLimit}
              onChange={(e) => set("atLimit", e.target.value as AtLimit)}
            >
              {(Object.keys(AT_LIMIT_LABEL) as AtLimit[]).map((k) => (
                <option key={k} value={k}>
                  {AT_LIMIT_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <SectionLabel>Checks</SectionLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Confer"
            className="md:col-span-2"
            hint="A second model gives its view of the result, in this focus. Leave it empty for none. Add a person in the step."
          >
            <TextInput
              data-testid="loop-confer"
              value={form.conferFocus}
              maxLength={500}
              onChange={(e) => set("conferFocus", e.target.value)}
            />
          </Field>
          <Field label="Review" hint="Whether the owner looks over what it did.">
            <Select
              data-testid="loop-review"
              value={form.review}
              onChange={(e) => set("review", e.target.value as LoopReview)}
            >
              {(Object.keys(REVIEW_LABEL) as LoopReview[]).map((k) => (
                <option key={k} value={k}>
                  {REVIEW_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>
    </div>
  );
}

export { NEW_LOOP_PATH };
