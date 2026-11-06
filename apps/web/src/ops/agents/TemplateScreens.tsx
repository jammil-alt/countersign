// Templates (ARCHITECTURE §9.3, §15): the Agent lab (`/ops/lab`, ../lab) lists them,
// `/ops/templates/new` makes one by conversation with the Builder (O5) or from scratch, and
// `/ops/templates/:slug` is the agent screen shared with client agents.
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  Button,
  buttonClass,
  Card,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { AgentScreen } from "./AgentScreen";
import {
  blankBundle,
  DEFAULT_MODEL,
  type NewAgentFields,
  SLUG_RE,
  slugify,
} from "./definition-form";
import { NewAgentConversation } from "./NewAgentConversation";
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
  const [useBuilder, setUseBuilder] = useState(true);
  const action = useAction();

  const startChoices = (
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
  );
  const startCard = (
    <Card className="p-5">
      <SectionLabel>Start from</SectionLabel>
      {startChoices}
    </Card>
  );

  if (useBuilder) return <NewAgentConversation other={startChoices} />;

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
        actions={<Stepper current={0} />}
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
