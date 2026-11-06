// O4 Skills and automations (`#O4-Skills` → `/ops/skills`; ARCHITECTURE §9.2, §10.7): the steps
// agents are built from. Automations first (reusable step chains, versioned, with their clean-run
// rate in live runs), then the skills as cards (category, version, what it does, in → out, how
// many agents use it). Built-in skills come with the platform and packs; operator skills and
// automations open their own pages for versions, publish, rollback and tests.
import type { AutomationListItem, SkillListItem, ToolSpec } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { TextInput } from "../../ui/forms";
import { Page, Section } from "../../ui/page";
import {
  Badge,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Tag,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { plural } from "../agents/ui";
import { Chain, inOut, percent, stepChain, versionText } from "./parts";
import { CATEGORIES, categoryLabel } from "./skill-form";

export const SKILLS_PATH = "/ops/skills";
export const skillPath = (id: string) => `/ops/skills/${id}`;
export const automationPath = (id: string) => `/ops/skills/automations/${id}`;

const AUTOMATIONS = "automations";

function matches(q: string, ...texts: (string | null)[]): boolean {
  return !q || texts.some((t) => t?.toLowerCase().includes(q));
}

export function SkillsScreen() {
  const library = useApi(apiRoutes.opsSkills);
  const automations = useApi(apiRoutes.opsAutomations);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const skills = library.data?.skills ?? [];
  const autos = automations.data?.automations ?? [];
  const q = search.trim().toLowerCase();

  const categories = [
    ...new Set([...CATEGORIES.map(([id]) => id), ...skills.map((s) => s.category)]),
  ].filter((c) => skills.some((s) => s.category === c));
  const shownSkills =
    tab === AUTOMATIONS
      ? []
      : skills.filter(
          (s) =>
            (tab === "all" || s.category === tab) &&
            matches(q, s.name, s.description, s.ref, s.clientName),
        );
  const shownAutos =
    tab === "all" || tab === AUTOMATIONS
      ? autos.filter((a) => matches(q, a.name, a.description, a.slug, a.clientName))
      : [];

  const tabs: [string, string][] = [
    ["all", "All"],
    ...categories.map((c): [string, string] => [
      c,
      `${categoryLabel(c)} · ${skills.filter((s) => s.category === c).length}`,
    ]),
    [AUTOMATIONS, `Automations · ${autos.length}`],
  ];

  return (
    <Page testId="skills-library">
      <PageHeader
        title="Skills and automations"
        subtitle="The steps agents are built from. A skill does one thing; an automation chains steps you reuse across agents."
        actions={
          <Link to="/ops/skills/new" className={buttonClass("primary")} data-testid="skills-new">
            Make a skill
          </Link>
        }
      />
      <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
        <div className="ds-seg flex-wrap" data-testid="skills-tabs">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              data-testid={`skills-tab-${id}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="w-full sm:w-64">
          <TextInput
            aria-label="Search skills"
            placeholder="Search skills"
            data-testid="skills-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {tab === "all" || tab === AUTOMATIONS ? (
        <AutomationsCard state={automations} shown={shownAutos} />
      ) : null}

      {tab !== AUTOMATIONS ? (
        <Section title="Skills">
          {library.error ? <ErrorNotice error={library.error} onRetry={library.reload} /> : null}
          {!library.data && !library.error ? <Loading /> : null}
          {library.data && skills.length === 0 ? (
            <EmptyState>No skills yet. Make one with the Builder.</EmptyState>
          ) : null}
          {library.data && skills.length > 0 && shownSkills.length === 0 ? (
            <EmptyState>No skill matches.</EmptyState>
          ) : null}
          {shownSkills.length > 0 ? (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
              {shownSkills.map((s) => (
                <SkillCard key={s.id} skill={s} tools={library.data?.tools ?? []} />
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}
    </Page>
  );
}

function AutomationsCard({
  state,
  shown,
}: {
  state: ApiState<ResponseOf<typeof apiRoutes.opsAutomations>>;
  shown: AutomationListItem[];
}) {
  return (
    <Card
      testId="automations"
      title={
        <span className="flex flex-col">
          Automations
          <span className="text-sm font-normal text-ink-muted">
            Step chains, versioned, dropped into a workflow as one block
          </span>
        </span>
      }
    >
      {state.error ? (
        <div className="ui-card__body">
          <ErrorNotice error={state.error} onRetry={state.reload} />
        </div>
      ) : !state.data ? (
        <div className="ui-card__body">
          <Loading />
        </div>
      ) : shown.length === 0 ? (
        <p className="ui-card__body text-sm text-ink-muted">
          {state.data.automations.length === 0
            ? "No automations yet. Select steps in an agent's workflow and save them as an automation."
            : "No automation matches."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((a) => (
            <AutomationRow key={a.id} automation={a} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** One automation: name, version, who uses it, its step chain and how clean its live uses ran. */
function AutomationRow({ automation: a }: { automation: AutomationListItem }) {
  // The list has no steps: the chain comes from the automation's own page data.
  const detail = useApi(apiRoutes.opsAutomation, { params: { id: a.id } });
  const versions = detail.data?.versions ?? [];
  const shownVersion =
    versions.find((v) => v.version === a.liveVersion) ?? versions[0] ?? undefined;
  return (
    <li
      data-testid={`automation-row-${a.slug}`}
      className="flex flex-wrap items-center justify-between gap-4 px-6 py-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex flex-wrap items-baseline gap-2">
          <Link to={automationPath(a.id)} className="font-medium text-ink hover:underline">
            {a.name}
          </Link>
          <span className="reference text-ink-muted">
            {versionText(a.liveVersion, a.latestVersion)}
          </span>
          <span className="text-sm text-ink-muted">
            · {a.usedBy === 0 ? "not used yet" : `used by ${plural(a.usedBy, "agent")}`}
            {a.source === "client" && a.clientName ? ` · ${a.clientName} only` : ""}
          </span>
        </p>
        {shownVersion && shownVersion.definition.steps.length > 0 ? (
          <Chain items={stepChain(shownVersion.definition.steps)} />
        ) : null}
      </div>
      {a.health.cleanRunRate !== null ? (
        <StatusChip state="done" testId={`automation-health-${a.slug}`}>
          {percent(a.health.cleanRunRate)} clean
        </StatusChip>
      ) : a.liveVersion === null ? (
        <Badge>Draft</Badge>
      ) : (
        <span className="text-sm text-ink-muted">No live runs yet</span>
      )}
    </li>
  );
}

function writes(skill: SkillListItem, tools: readonly ToolSpec[]): boolean {
  return skill.tools.some((id) => tools.find((t) => t.id === id)?.sideEffect === "external");
}

function sourceText(s: SkillListItem): string {
  return s.source === "builtin"
    ? "Built in"
    : s.source === "shared"
      ? "Shared"
      : (s.clientName ?? "One client");
}

function SkillCard({ skill: s, tools }: { skill: SkillListItem; tools: readonly ToolSpec[] }) {
  const draft = s.source !== "builtin" && s.liveVersion === null;
  return (
    <Card dashed={draft} testId={`skills-card-${s.ref}`} className="flex flex-col">
      <div className="flex flex-1 flex-col gap-3 px-6 pt-5 pb-4">
        <div className="flex items-center justify-between gap-3">
          <Tag>{categoryLabel(s.category)}</Tag>
          {draft ? (
            <Tag>Draft</Tag>
          ) : s.liveVersion !== null ? (
            <span className="reference text-ink-muted">v{s.liveVersion}</span>
          ) : null}
        </div>
        <h3 className="type-subheading text-ink">
          {s.source === "builtin" ? (
            s.name
          ) : (
            <Link to={skillPath(s.id)} className="hover:underline">
              {s.name}
            </Link>
          )}
        </h3>
        <p className="text-sm text-ink-muted">{s.description}</p>
        <Chain items={inOut(s.inputs, s.outputs)} />
      </div>
      <div
        className={cx(
          "flex flex-wrap items-center justify-between gap-2 border-t border-line px-6 py-3 text-sm",
        )}
      >
        <span className="text-ink">
          {s.usedBy === 0 ? "No agents yet" : plural(s.usedBy, "agent")}
        </span>
        <span className="text-ink-muted">
          {writes(s, tools) ? "Writes · signed by default" : sourceText(s)}
        </span>
      </div>
    </Card>
  );
}
