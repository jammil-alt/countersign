// `/ops/clients/:clientId/agents/new` (design screen 4; ARCHITECTURE §9.3 "Forking"): a client
// agent from a template version (fork: ids and base version kept), from scratch, or copied from
// another client's agent (its live bundle without that client's values or bindings). The Builder's
// "my description" option is shown, not built yet.
import type { AgentBundle } from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useSession } from "../../session/session";
import {
  Button,
  buttonClass,
  Card,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { parseBundle } from "../versions";
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
import {
  errorText,
  Field,
  isCode,
  Notice,
  notifyAgentsChanged,
  Select,
  TextArea,
  TextInput,
  useAction,
} from "./ui";

type Start = { kind: "blank" } | { kind: "template"; id: string } | { kind: "copy" };

export function NewClientAgentScreen() {
  const { clientId = "" } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  const templates = useApi(apiRoutes.opsTemplates);

  const [start, setStart] = useState<Start>({ kind: "blank" });
  const [fields, setFields] = useState<NewAgentFields>({
    name: "",
    role: "",
    mission: "",
    instructions: "",
    modelId: DEFAULT_MODEL,
  });
  const [slug, setSlug] = useState<string | null>(null);
  const [serviceName, setServiceName] = useState("");
  const [serviceDescription, setServiceDescription] = useState("");
  const [versionId, setVersionId] = useState<string | null>(null);
  const [copyClient, setCopyClient] = useState("");
  const [copyAgent, setCopyAgent] = useState("");
  const [touched, setTouched] = useState(false);
  const action = useAction();

  const template =
    start.kind === "template"
      ? templates.data?.templates.find((t) => t.id === start.id)
      : undefined;
  const templateDetail = useApi(
    apiRoutes.opsAgent,
    template ? { params: { id: template.id } } : null,
  );
  const chosenVersionId =
    versionId ?? template?.liveVersionId ?? templateDetail.data?.latest?.id ?? null;
  const templateVersion = useApi(
    apiRoutes.opsAgentVersion,
    template && chosenVersionId ? { params: { id: template.id, vid: chosenVersionId } } : null,
  );
  const otherClients = [...new Map(session.tenants.map((t) => [t.id, t])).values()].filter(
    (t) => t.id !== clientId,
  );
  const copyAgents = useApi(
    apiRoutes.opsClientAgents,
    start.kind === "copy" && copyClient ? { params: { id: copyClient } } : null,
  );
  const copySource = copyAgents.data?.agents.find((a) => a.id === copyAgent);
  const copyDetail = useApi(
    apiRoutes.opsAgent,
    copySource ? { params: { id: copySource.id } } : null,
  );

  if (client.error) return <ErrorNotice error={client.error} onRetry={client.reload} />;
  if (!client.data) return <Loading />;

  const defaultSlug =
    start.kind === "template"
      ? (template?.slug ?? "")
      : start.kind === "copy"
        ? (copySource?.slug ?? "")
        : slugify(fields.name);
  const effectiveSlug = slug ?? defaultSlug;
  const taken = client.data.agents.some((a) => a.slug === effectiveSlug);

  const errors: JobErrors & { source?: string } = start.kind === "blank" ? validateJob(fields) : {};
  if (!SLUG_RE.test(effectiveSlug)) {
    errors.slug = "Lowercase letters, digits and dashes, starting with a letter or digit.";
  } else if (taken) {
    errors.slug = "This client already has an agent with this slug.";
  }
  if (start.kind === "template" && !chosenVersionId) errors.source = "Choose a template version.";
  if (start.kind === "copy" && !copySource) errors.source = "Choose the agent to copy.";
  const shown = touched ? errors : {};

  let preview: AgentBundle | null = null;
  if (start.kind === "blank")
    preview = blankBundle({ ...fields, name: fields.name.trim() || "New agent" }, () => "preview");
  if (start.kind === "template" && templateVersion.data) {
    const p = parseBundle(templateVersion.data.version);
    preview = p.ok ? p.bundle : null;
  }
  if (start.kind === "copy" && copyDetail.data?.live) {
    const p = parseBundle(copyDetail.data.live);
    preview = p.ok ? p.bundle : null;
  }

  const choose = (next: Start) => {
    setStart(next);
    setSlug(null);
    setVersionId(null);
    action.clear();
  };

  async function create() {
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    const service = {
      ...(serviceName.trim() ? { serviceName: serviceName.trim() } : {}),
      ...(serviceDescription.trim() ? { serviceDescription: serviceDescription.trim() } : {}),
    };
    const res =
      start.kind === "template" && template && chosenVersionId
        ? await action.call(apiRoutes.opsFork, {
            params: { id: template.id },
            body: { clientId, versionId: chosenVersionId, slug: effectiveSlug, ...service },
          })
        : start.kind === "copy" && copySource
          ? await action.call(apiRoutes.opsCreateClientAgent, {
              params: { id: clientId },
              body: { slug: effectiveSlug, copyFrom: copySource.id, ...service },
            })
          : await action.call(apiRoutes.opsCreateClientAgent, {
              params: { id: clientId },
              body: {
                slug: effectiveSlug,
                bundle: blankBundle(fields),
                changeNote: "Created",
                ...service,
              },
            });
    if (res.ok) {
      notifyAgentsChanged();
      navigate(`/ops/clients/${clientId}/agents/${res.data.agent.slug}`);
    }
  }

  return (
    <div>
      <PageHeader
        title="New agent"
        subtitle={`An agent for ${client.data.client.name}: start from a template, or blank, and build its workflow step by step.`}
        actions={<Stepper />}
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-5">
          <Card className="p-5">
            <SectionLabel>Start from</SectionLabel>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="new-agent-start">
              <BuilderOption />
              <StartOption
                selected={start.kind === "blank"}
                title="Blank workflow"
                text="Start empty and add skills, actions and people yourself."
                onSelect={() => choose({ kind: "blank" })}
                testId="new-agent-start-blank"
              />
              {templates.data?.templates.map((t) => (
                <StartOption
                  key={t.id}
                  selected={start.kind === "template" && start.id === t.id}
                  title={`Template · ${t.name}`}
                  text={t.role ?? "A template"}
                  onSelect={() => choose({ kind: "template", id: t.id })}
                  testId={`new-agent-start-template-${t.slug}`}
                />
              ))}
              {otherClients.length > 0 ? (
                <StartOption
                  selected={start.kind === "copy"}
                  title="Another client's agent"
                  text="Copied without that client's settings, records or connections."
                  onSelect={() => choose({ kind: "copy" })}
                  testId="new-agent-start-copy"
                />
              ) : null}
            </div>
            {templates.error ? (
              <div className="mt-3">
                <ErrorNotice error={templates.error} onRetry={templates.reload} />
              </div>
            ) : null}
          </Card>

          {start.kind === "blank" ? (
            <Card className="p-5">
              <SectionLabel>The job</SectionLabel>
              <JobFields
                fields={fields}
                errors={shown}
                onChange={setFields}
                testPrefix="new-agent"
              />
            </Card>
          ) : null}

          {start.kind === "template" && templateDetail.data ? (
            <Card className="p-5">
              <SectionLabel>Template version</SectionLabel>
              <Field
                label="Version"
                error={shown.source}
                hint="Forked as this client's v1, steps and ids kept."
              >
                <Select
                  data-testid="new-agent-template-version-select"
                  value={chosenVersionId ?? ""}
                  onChange={(e) => setVersionId(e.target.value)}
                >
                  {templateDetail.data.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version} ·{" "}
                      {v.id === templateDetail.data?.agent.liveVersionId ? "live" : v.status}
                      {v.releaseNote
                        ? ` · ${v.releaseNote}`
                        : v.changeNote
                          ? ` · ${v.changeNote}`
                          : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            </Card>
          ) : null}

          {start.kind === "copy" ? (
            <Card className="p-5">
              <SectionLabel>Copy from</SectionLabel>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Client">
                  <Select
                    data-testid="new-agent-copy-client-select"
                    value={copyClient}
                    onChange={(e) => {
                      setCopyClient(e.target.value);
                      setCopyAgent("");
                    }}
                  >
                    <option value="">Choose a client…</option>
                    {otherClients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Agent" error={shown.source}>
                  <Select
                    data-testid="new-agent-copy-agent-select"
                    value={copyAgent}
                    disabled={!copyAgents.data}
                    onChange={(e) => setCopyAgent(e.target.value)}
                  >
                    <option value="">Choose an agent…</option>
                    {copyAgents.data?.agents
                      .filter((a) => !a.testCopy && a.liveVersionId)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.serviceName ?? a.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
            </Card>
          ) : null}

          <Card className="p-5">
            <SectionLabel>In {client.data.client.name}</SectionLabel>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Slug"
                error={shown.slug}
                hint="Its address in this client. It can't change later."
                testId="new-agent-slug"
              >
                <TextInput
                  data-testid="new-agent-slug-input"
                  value={effectiveSlug}
                  invalid={Boolean(shown.slug)}
                  onChange={(e) => setSlug(e.target.value)}
                />
              </Field>
              <Field label="Service name" hint="What the client sees in the portal.">
                <TextInput
                  data-testid="new-agent-service-name-input"
                  value={serviceName}
                  onChange={(e) => setServiceName(e.target.value)}
                />
              </Field>
              <Field
                label="Service description"
                className="md:col-span-2"
                hint="What it does for them, in plain language."
              >
                <TextArea
                  data-testid="new-agent-service-description-input"
                  rows={2}
                  value={serviceDescription}
                  onChange={(e) => setServiceDescription(e.target.value)}
                />
              </Field>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <WorkflowPreview
            bundle={preview}
            title={start.kind === "blank" ? "Starting workflow" : "Workflow it starts with"}
            note={
              <p className="text-sm text-ink-muted">
                It starts as a draft, with suggest-only permissions and approval on for every step
                that changes a tool. Bind its connections, test-run and publish before activating.
              </p>
            }
          />
          {action.error ? (
            <Notice tone="warning" testId="new-agent-error">
              {isCode(action.error, "conflict")
                ? `This client already has an agent “${effectiveSlug}”: choose another slug.`
                : errorText(action.error)}
            </Notice>
          ) : null}
          <div className="flex justify-end gap-3">
            <Link to={`/ops/clients/${clientId}`} className={buttonClass("ghost")}>
              Cancel
            </Link>
            <Button
              variant="primary"
              data-testid="new-agent-create"
              disabled={action.busy}
              onClick={create}
            >
              {action.busy
                ? "Creating…"
                : start.kind === "template"
                  ? "Fork into this client"
                  : "Create agent"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
