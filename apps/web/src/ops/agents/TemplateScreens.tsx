// Templates (ARCHITECTURE §9.3, §15): `/ops/templates` lists them, `/ops/templates/new` makes one
// from scratch or from a description (the Builder), and
// `/ops/templates/:slug` is the agent screen shared with client agents.
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  AgentAvatar,
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { summaryBadge } from "../versions";
import { AgentScreen } from "./AgentScreen";
import { BuilderDescribe, BuilderDraftResult } from "./BuilderParts";
import {
  blankBundle,
  DEFAULT_MODEL,
  type NewAgentFields,
  SLUG_RE,
  slugify,
} from "./definition-form";
import {
  BuilderOption,
  type JobErrors,
  JobFields,
  StartOption,
  Stepper,
  validateJob,
  WorkflowPreview,
} from "./NewAgentParts";
import { errorText, Field, isCode, Notice, notifyAgentsChanged, TextInput, useAction } from "./ui";

export function TemplatesScreen() {
  const [showDiscarded, setShowDiscarded] = useState(false);
  const { data, error, loading, reload } = useApi(
    apiRoutes.opsTemplates,
    showDiscarded ? { query: { include: "discarded" } } : {},
  );
  return (
    <div>
      <PageHeader
        title="Templates"
        subtitle="Reusable agents. Fork one into a client to make that client's own agent."
        actions={
          <Link
            to="/ops/templates/new"
            className={buttonClass("primary")}
            data-testid="templates-new"
          >
            New template
          </Link>
        }
      />
      <SectionLabel
        action={
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              className="size-4 accent-slate"
              data-testid="templates-show-discarded"
              checked={showDiscarded}
              onChange={(e) => setShowDiscarded(e.target.checked)}
            />
            Show discarded drafts
          </label>
        }
      >
        Templates
      </SectionLabel>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.templates.length === 0 ? <EmptyState>No templates yet.</EmptyState> : null}
      {data && data.templates.length > 0 ? (
        <div className="dt dt-ana">
          <table data-testid="templates-table">
            <thead>
              <tr className="dt-cols">
                <th>Template</th>
                <th>Area</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.templates.map((t) => {
                const badge =
                  t.status === "disabled"
                    ? { tone: "neutral" as const, label: "Discarded" }
                    : summaryBadge(t);
                return (
                  <tr key={t.id}>
                    <td>
                      <Link
                        to={`/ops/templates/${t.slug}`}
                        data-testid={`templates-row-${t.slug}`}
                        className="flex items-center gap-3"
                      >
                        <AgentAvatar name={t.name} seed={t.slug} size="md" />
                        <span>
                          <span className="block font-medium text-ink hover:underline">
                            {t.name}
                          </span>
                          <span className="block reference text-ink-muted">{t.slug}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="text-ink">{t.role ?? "—"}</td>
                    <td>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </td>
                    <td className="text-sm figures">{t.createdAt.slice(0, 10)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

type Draft = ResponseOf<typeof apiRoutes.opsDraftAgent>;

const EMPTY_JOB: NewAgentFields = {
  name: "",
  role: "",
  mission: "",
  instructions: "",
  modelId: DEFAULT_MODEL,
};

export function NewTemplateScreen() {
  const navigate = useNavigate();
  const [fields, setFields] = useState<NewAgentFields>(EMPTY_JOB);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [releaseNote, setReleaseNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [useBuilder, setUseBuilder] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const action = useAction();

  const startCard = (
    <Card className="p-5">
      <SectionLabel>Start from</SectionLabel>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <BuilderOption selected={useBuilder} onSelect={() => setUseBuilder(true)} />
        <StartOption
          selected={!useBuilder}
          title="Blank workflow"
          text="Start empty and add skills, actions and people yourself."
          onSelect={() => setUseBuilder(false)}
          testId="new-template-start-blank"
        />
      </div>
    </Card>
  );

  if (useBuilder) {
    return (
      <div>
        <PageHeader
          title="New template"
          subtitle="Say what the job is. The Builder drafts a starting workflow you can rearrange step by step."
          actions={<Stepper />}
        />
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex flex-col gap-5">
            {startCard}
            <BuilderDescribe onDrafted={setDraft} />
          </div>
          <BuilderDraftResult draft={draft} />
        </div>
      </div>
    );
  }

  const effectiveSlug = slugEdited ? slug : slugify(fields.name);
  const errors: JobErrors = validateJob(fields);
  if (!SLUG_RE.test(effectiveSlug)) {
    errors.slug = "Lowercase letters, digits and dashes, starting with a letter or digit.";
  }
  const shown = touched ? errors : {};

  async function create() {
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    const res = await action.call(apiRoutes.opsCreateTemplate, {
      body: {
        slug: effectiveSlug,
        bundle: blankBundle(fields),
        changeNote: "Created",
        ...(releaseNote.trim() ? { releaseNote: releaseNote.trim() } : {}),
      },
    });
    if (res.ok) {
      notifyAgentsChanged();
      navigate(`/ops/templates/${res.data.agent.slug}`);
    }
  }

  return (
    <div>
      <PageHeader
        title="New template"
        subtitle="A reusable agent. It starts as a draft with a blank workflow you build step by step."
        actions={<Stepper />}
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-5">
          <Card className="p-5">
            <SectionLabel>The job</SectionLabel>
            <JobFields
              fields={fields}
              errors={shown}
              onChange={setFields}
              testPrefix="new-template"
            />
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Slug"
                error={shown.slug}
                hint="Its address. It can't change later."
                testId="new-template-slug"
              >
                <TextInput
                  data-testid="new-template-slug-input"
                  value={effectiveSlug}
                  invalid={Boolean(shown.slug)}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setSlug(e.target.value);
                  }}
                />
              </Field>
              <Field label="Release note" hint="Shown to clients' update reviews once published.">
                <TextInput
                  data-testid="new-template-release-note-input"
                  value={releaseNote}
                  onChange={(e) => setReleaseNote(e.target.value)}
                />
              </Field>
            </div>
          </Card>
          {startCard}
        </div>
        <div className="flex flex-col gap-4">
          <WorkflowPreview
            bundle={blankBundle(
              { ...fields, name: fields.name.trim() || "New agent" },
              () => "preview",
            )}
            note={
              <p className="text-sm text-ink-muted">
                It starts by hand. Add steps in the workflow builder, then test-run it in the
                Sandbox client and publish.
              </p>
            }
          />
          {action.error ? (
            <Notice tone="warning" testId="new-template-error">
              {isCode(action.error, "conflict")
                ? `A template called “${effectiveSlug}” exists already: choose another slug.`
                : errorText(action.error)}
            </Notice>
          ) : null}
          <div className="flex justify-end gap-3">
            <Link to="/ops/templates" className={buttonClass("ghost")}>
              Cancel
            </Link>
            <Button
              variant="primary"
              data-testid="new-template-create"
              disabled={action.busy}
              onClick={create}
            >
              {action.busy ? "Creating…" : "Create template"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TemplatePage() {
  const { slug = "" } = useParams();
  const list = useApi(apiRoutes.opsTemplates, { query: { include: "discarded" } });
  const template = list.data?.templates.find((t) => t.slug === slug);
  if (list.error) return <ErrorNotice error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  if (!template) return <ErrorNotice error={new Error(`No template "${slug}".`)} />;
  return <AgentScreen agentId={template.id} base={`/ops/templates/${slug}`} />;
}
