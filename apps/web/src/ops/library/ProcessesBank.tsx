// R8: the Library's Processes bank (`/ops/library/processes`; ARCHITECTURE §10.14): the templates
// a client's agent is forked from, each with its versions and its workflows read as v4 processes
// (triggers, steps by kind, the checks they carry), opening in the builder; then the processes
// used inside others (today's automations, the Skills screen's card). A stored v3 version is read,
// never rewritten (invariant 3): saving in the builder makes a new version.
import type { LibraryProcess, LibraryProcessWorkflow } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Loaded, Section } from "../../ui/page";
import {
  Badge,
  buttonClass,
  Card,
  EmptyState,
  PageHeader,
  StepKindTag,
  Tag,
} from "../../ui/primitives";
import type { AgentLinkState } from "../screens/AgentPage";
import { AutomationsCard } from "../skills/SkillsLibrary";
import { TRIGGER_KIND_LABEL } from "../workflow/describe";
import { BankSearch, LibraryFrame } from "./LibraryFrame";
import { counted, matches } from "./paths";
import { kindLabel, PROCESS_KIND_LABEL } from "./words";

const templatePath = (slug: string) => `/ops/templates/${slug}`;
/** The builder, open on one of the template's workflows. */
export const builderPath = (slug: string, workflow: string) =>
  `${templatePath(slug)}/workflows/${workflow}`;

/** The template's id travels with links to its page, so the page needn't look it up by slug. */
const handOver = (id: string): AgentLinkState => ({ agentId: id });

export function ProcessesBank() {
  const state = useApi(apiRoutes.opsLibraryProcesses);
  const automations = useApi(apiRoutes.opsAutomations);
  const [search, setSearch] = useState("");
  const autos = (automations.data?.automations ?? []).filter((a) =>
    matches(search, a.name, a.description, a.slug, a.clientName),
  );
  return (
    <LibraryFrame>
      <PageHeader
        title="Processes"
        subtitle="Triggers, then steps top to bottom, each step able to carry checks. An agent is one process and its owner."
        actions={
          <Link to="/ops/templates/new" className={buttonClass("primary")}>
            Make a template
          </Link>
        }
      />
      <div className="-mt-2 flex justify-end">
        <BankSearch
          value={search}
          onChange={setSearch}
          label="Search processes"
          testId="processes-search"
        />
      </div>
      <Loaded state={state}>
        {(data) => {
          const shown = data.processes.filter((p) =>
            matches(
              search,
              p.name,
              p.slug,
              p.description,
              ...p.workflows.flatMap((w) => [w.name, ...w.triggers.map((t) => t.event)]),
            ),
          );
          return (
            <Section title="Templates" meta={counted(data.processes.length, "template")}>
              {data.processes.length === 0 ? (
                <EmptyState
                  line="No templates yet. Make one with the Builder, or from a client's agent in the Agent lab."
                  action={{ label: "Make a template", to: "/ops/templates/new" }}
                />
              ) : shown.length === 0 ? (
                <EmptyState>No template matches.</EmptyState>
              ) : (
                <div className="flex flex-col gap-4">
                  {shown.map((p) => (
                    <TemplateCard key={p.id} process={p} />
                  ))}
                </div>
              )}
            </Section>
          );
        }}
      </Loaded>
      <AutomationsCard
        state={automations}
        shown={autos}
        title="Used inside other processes"
        line="Versioned step lists a process uses as one step, pinned to a version"
      />
    </LibraryFrame>
  );
}

function TemplateCard({ process: p }: { process: LibraryProcess }) {
  const draft = p.liveVersion === null;
  return (
    <Card dashed={draft} testId={`process-${p.slug}`}>
      <div className="flex flex-col gap-4 px-6 pt-5 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="flex flex-wrap items-center gap-2 type-subheading text-ink">
              <Link to={templatePath(p.slug)} state={handOver(p.id)} className="hover:underline">
                {p.name}
              </Link>
              {draft ? (
                <Tag>Draft</Tag>
              ) : (
                <Badge tone="positive" testId={`process-${p.slug}-live`}>
                  Live · v{p.liveVersion}
                </Badge>
              )}
              {p.latestVersion !== null && p.latestVersion !== p.liveVersion && !draft ? (
                <Tag>Draft v{p.latestVersion}</Tag>
              ) : null}
            </h3>
            {p.description ? <p className="text-sm text-ink-muted">{p.description}</p> : null}
          </div>
          <span className="text-sm text-ink" data-testid={`process-${p.slug}-used-by`}>
            {p.usedBy === 0 ? "No client agents yet" : counted(p.usedBy, "client agent")}
          </span>
        </div>
        {p.workflows.length === 0 ? (
          <p className="text-sm text-ink-muted">This version has no workflow yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {p.workflows.map((w) => (
              <WorkflowRow key={w.slug} process={p} workflow={w} />
            ))}
          </ul>
        )}
      </div>
      <Versions process={p} />
    </Card>
  );
}

function checksText(w: LibraryProcessWorkflow): string | null {
  const parts = [
    w.checks.confer > 0 ? counted(w.checks.confer, "confer") : null,
    w.checks.approval > 0 ? counted(w.checks.approval, "approval") : null,
    w.checks.notify > 0
      ? counted(w.checks.notify, "step that notifies", "steps that notify")
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** One workflow: its triggers, its steps by kind and its checks, and a link into the builder. */
function WorkflowRow({
  process: p,
  workflow: w,
}: {
  process: LibraryProcess;
  workflow: LibraryProcessWorkflow;
}) {
  const kinds = Object.keys(PROCESS_KIND_LABEL).filter((k) => (w.kinds[k] ?? 0) > 0);
  const checks = checksText(w);
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
      data-testid={`process-${p.slug}-workflow-${w.slug}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium text-ink">{w.name}</span>
          <span className="text-sm text-ink-muted">
            {w.triggers
              .map((t) =>
                t.event
                  ? `${TRIGGER_KIND_LABEL[t.kind as keyof typeof TRIGGER_KIND_LABEL] ?? t.kind}: ${t.event}`
                  : (TRIGGER_KIND_LABEL[t.kind as keyof typeof TRIGGER_KIND_LABEL] ?? t.kind),
              )
              .join(" · ")}
          </span>
          {w.enabled ? null : <Tag>Off</Tag>}
          {w.schemaVersion === 3 ? (
            <span className="text-xs text-ink-muted" title="Stored before processes; read as one">
              Stored as a v3 workflow
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-ink figures">{counted(w.steps, "step")}</span>
          {kinds.map((k) => (
            <StepKindTag key={k} kind={k} label={`${kindLabel(k)} ${w.kinds[k]}`} />
          ))}
          {checks ? <span className="text-ink-muted">· {checks}</span> : null}
        </div>
      </div>
      <Link
        to={builderPath(p.slug, w.slug)}
        state={handOver(p.id)}
        className={buttonClass("secondary", undefined, "sm")}
        data-testid={`process-${p.slug}-open-${w.slug}`}
      >
        Open in the builder
      </Link>
    </li>
  );
}

/** The template's versions, newest first, folded until asked for. */
function Versions({ process: p }: { process: LibraryProcess }) {
  if (p.versions.length === 0) return null;
  return (
    <details className="border-t border-line px-6 py-3 text-sm">
      <summary className="cursor-pointer text-ink" data-testid={`process-${p.slug}-versions`}>
        {counted(p.versions.length, "version")}
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {p.versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-baseline gap-2">
            <span className="reference text-ink">v{v.version}</span>
            <span className="text-ink-muted">{v.status}</span>
            <span className="text-ink-muted figures">{shortTime(v.createdAt)}</span>
            {v.changeNote ? <span className="text-ink">{v.changeNote}</span> : null}
          </li>
        ))}
      </ul>
      <Link
        to={`${templatePath(p.slug)}/versions`}
        state={handOver(p.id)}
        className="mt-2 inline-block text-ink underline"
      >
        Compare and publish versions
      </Link>
    </details>
  );
}
