// O4 Skills and automations (`#O4-Skills` → `/ops/skills`; ARCHITECTURE §9.2, §10.7): the steps
// agents are built from, in two tabs. Skills (the default) as cards or a list (category, version,
// what it does, in → out, how many agents use it); Automations (`?tab=automations`: reusable step
// chains, versioned, with their clean-run rate in live runs). Built-in skills come with the
// platform and packs; operator skills and automations open their own pages for versions, publish,
// rollback and tests.
import type { AutomationListItem, SkillListItem, ToolSpec } from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { Select, TextInput } from "../../ui/forms";
import { Icon, type IconName } from "../../ui/icons";
import { Page } from "../../ui/page";
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
  Tabs,
  Tag,
} from "../../ui/primitives";
import { SheetSection, SideSheet } from "../../ui/sheet";
import { StatusChip } from "../../ui/status";
import { errorText, plural, useAction } from "../agents/ui";
import { toolTitle } from "../builder/model";
import { TableCard } from "../screens/business";
import { Chain, inOut, percent, stepChain, versionText } from "./parts";
import { CATEGORIES, categoryLabel } from "./skill-form";

export const SKILLS_PATH = "/ops/skills";
export const skillPath = (id: string) => `/ops/skills/${id}`;
export const automationPath = (id: string) => `/ops/skills/automations/${id}`;

const ALL = "all";

type View = "cards" | "list";
const VIEW_KEY = "mezonas.skills.view";

/** Cards or a list, remembered per viewer in this browser (a convenience: cards when unknown). */
function useSkillsView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "cards";
    } catch {
      return "cards";
    }
  });
  const choose = (v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  };
  return [view, choose];
}

function matches(q: string, ...texts: (string | null)[]): boolean {
  return !q || texts.some((t) => t?.toLowerCase().includes(q));
}

export function SkillsScreen() {
  const library = useApi(apiRoutes.opsSkills);
  const automations = useApi(apiRoutes.opsAutomations);
  const [params] = useSearchParams();
  // DECISION: skills and automations are two tabs, not two stacked sections (2026-11-10): each is
  // a long list of its own, and the category filter only means something for skills.
  const tab = params.get("tab") === "automations" ? "automations" : "skills";
  const [category, setCategory] = useState(ALL);
  const [search, setSearch] = useState("");
  const [view, setView] = useSkillsView();
  const [openId, setOpenId] = useState<string | null>(null);
  const skills = library.data?.skills ?? [];
  const autos = automations.data?.automations ?? [];
  const tools = library.data?.tools ?? [];
  const q = search.trim().toLowerCase();

  const categories = [
    ...new Set([...CATEGORIES.map(([id]) => id), ...skills.map((s) => s.category)]),
  ].filter((c) => skills.some((s) => s.category === c));
  const shownSkills = skills.filter(
    (s) =>
      (category === ALL || s.category === category) &&
      matches(q, s.name, s.description, s.ref, s.clientName),
  );
  const shownAutos = autos.filter((a) => matches(q, a.name, a.description, a.slug, a.clientName));

  const opened = openId ? skills.find((s) => s.id === openId) : undefined;
  const searchLabel = tab === "skills" ? "Search skills" : "Search automations";

  return (
    <Page testId="skills-library">
      {opened ? <SkillSheet skill={opened} tools={tools} onClose={() => setOpenId(null)} /> : null}
      <PageHeader
        title="Skills and automations"
        subtitle="The steps agents are built from. A skill does one thing; an automation chains steps you reuse across agents."
        actions={
          <Link to="/ops/skills/new" className={buttonClass("primary")} data-testid="skills-new">
            Make a skill
          </Link>
        }
      />
      <div className="-mt-2" data-testid="skills-tabs">
        <Tabs
          items={[
            {
              to: SKILLS_PATH,
              label: "Skills",
              ...(library.data ? { count: skills.length } : {}),
              active: tab === "skills",
            },
            {
              to: `${SKILLS_PATH}?tab=automations`,
              label: "Automations",
              ...(automations.data ? { count: autos.length } : {}),
              active: tab === "automations",
            },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {tab === "skills" ? (
          // A dropdown, not a row of buttons: the categories grow with each pack (2026-11-10).
          <Select
            aria-label="Category"
            data-testid="skills-filter"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full sm:w-64"
          >
            <option value={ALL}>All categories · {skills.length}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)} · {skills.filter((s) => s.category === c).length}
              </option>
            ))}
          </Select>
        ) : null}
        <div className="w-full sm:w-64">
          <TextInput
            aria-label={searchLabel}
            placeholder={searchLabel}
            data-testid="skills-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {tab === "skills" ? (
          <fieldset className="ds-seg m-0 sm:ml-auto" data-testid="skills-view">
            <legend className="sr-only">View as</legend>
            {(
              [
                ["cards", "Cards"],
                ["list", "List"],
              ] as const
            ).map(([v, text]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                data-testid={`skills-view-${v}`}
                onClick={() => setView(v)}
                className="hover:text-ink"
              >
                {text}
              </button>
            ))}
          </fieldset>
        ) : null}
      </div>

      {tab === "automations" ? (
        <AutomationsCard state={automations} shown={shownAutos} />
      ) : (
        <div className="flex flex-col gap-4" data-testid="skills-list">
          {library.error ? <ErrorNotice error={library.error} onRetry={library.reload} /> : null}
          {!library.data && !library.error ? <Loading /> : null}
          {library.data && skills.length === 0 ? (
            <EmptyState>No skills yet. Make one with the Builder.</EmptyState>
          ) : null}
          {library.data && skills.length > 0 && shownSkills.length === 0 ? (
            <EmptyState>No skill matches.</EmptyState>
          ) : null}
          {shownSkills.length > 0 && view === "cards" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {shownSkills.map((s) => (
                <SkillCard key={s.id} skill={s} tools={tools} onOpen={() => setOpenId(s.id)} />
              ))}
            </div>
          ) : null}
          {shownSkills.length > 0 && view === "list" ? (
            <SkillTable skills={shownSkills} tools={tools} onOpen={setOpenId} />
          ) : null}
        </div>
      )}
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
      titleAbove
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

const MODE_TEXT: Record<SkillListItem["mode"], string> = {
  tool: "Runs code, no model. Built in, so it can't be cloned.",
  task: "A task on its own model: the same in every agent that uses it.",
  agent: "Runs as the agent, on the agent's model and instructions.",
};

/** The icon for a skill's category: what area of the business it works in. */
const CATEGORY_ICONS: [RegExp, IconName][] = [
  [/account|client/, "customer"],
  [/bank|card|ramp|plaid|payment/, "bank"],
  [/bookkeep|ledger|quickbooks|invoice|bill/, "invoice"],
  [/text|whatsapp|comms|email|gmail|outlook|slack|message/, "message"],
  [/people|directory|contact|hubspot|zoho|podio|crm/, "team"],
  [/writing/, "worksheet"],
  [/knowledge/, "info"],
  [/marketing|news|search|report/, "report"],
  [/material|purchas|vendor|price/, "price-change"],
  [/supervis|alert|health/, "alert"],
  [/website|browser|login/, "sign"],
  [/data|sheet|table|testkit/, "table"],
];

function categoryIcon(category: string): IconName {
  const c = categoryLabel(category).toLowerCase();
  return CATEGORY_ICONS.find(([re]) => re.test(c))?.[1] ?? "document";
}

/** How a skill runs, as a short word on its card. Slate where a model does the work. */
const MODE_CHIP: Record<SkillListItem["mode"], { label: string; tone: "neutral" | "accent" }> = {
  tool: { label: "Code", tone: "neutral" },
  task: { label: "Task", tone: "accent" },
  agent: { label: "Agent", tone: "accent" },
};

/**
 * A skill in the library: its category (a slate tile with the area's icon), name, two lines of
 * what it does, how it runs, whether a person signs its writes (copper, the brand's colour for
 * people and sign-offs), and three numbers (client agents using it, tools, fields in → out). The
 * whole card opens its side sheet.
 */
function SkillCard({
  skill: s,
  tools,
  onOpen,
}: {
  skill: SkillListItem;
  tools: readonly ToolSpec[];
  onOpen: () => void;
}) {
  const draft = s.source !== "builtin" && s.liveVersion === null;
  const mode = MODE_CHIP[s.mode];
  return (
    <Card
      dashed={draft}
      testId={`skills-card-${s.ref}`}
      className="flex overflow-hidden transition-colors hover:border-slate"
    >
      <button
        type="button"
        onClick={onOpen}
        data-testid={`skills-card-${s.ref}-open`}
        aria-haspopup="dialog"
        className="flex w-full flex-col text-left focus-visible:outline-2 focus-visible:outline-slate"
      >
        <span className="flex w-full flex-1 flex-col gap-2.5 px-5 pt-4 pb-4">
          <span className="flex w-full items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden className="ui-skilltile">
                <Icon name={categoryIcon(s.category)} size={16} />
              </span>
              <span className="truncate text-sm text-ink-muted">{categoryLabel(s.category)}</span>
            </span>
            {draft ? (
              <Tag>Draft</Tag>
            ) : s.liveVersion !== null ? (
              <span className="reference text-ink-muted">v{s.liveVersion}</span>
            ) : null}
          </span>
          <span className="font-medium text-ink">{s.name}</span>
          <span className="line-clamp-2 text-sm text-ink-muted">{s.description}</span>
          <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
            <Badge tone={mode.tone}>{mode.label}</Badge>
            {writes(s, tools) ? <Badge tone="person">Sign-off</Badge> : null}
          </span>
        </span>
        <span className="grid w-full grid-cols-3 gap-2 border-t border-line bg-surface-subtle px-5 py-3">
          <Stat
            label="Agents"
            value={String(s.usedBy)}
            strong={s.usedBy > 0}
            title={s.usedByNames?.length ? s.usedByNames.join("\n") : undefined}
            testId={`skills-card-${s.ref}-used-by`}
          />
          <Stat label="Tools" value={String(s.tools.length)} />
          <Stat label="In → out" value={`${s.inputs.length} → ${s.outputs.length}`} />
        </span>
      </button>
    </Card>
  );
}

/**
 * The skills as a list: one row each, the same facts as the cards, for scanning many at once. The
 * name opens the same side sheet.
 */
function SkillTable({
  skills,
  tools,
  onOpen,
}: {
  skills: SkillListItem[];
  tools: readonly ToolSpec[];
  onOpen: (id: string) => void;
}) {
  return (
    <TableCard title={plural(skills.length, "skill")} testId="skills-table">
      <table>
        <thead>
          <tr className="dt-cols">
            <th>Skill</th>
            <th>Category</th>
            <th>How it runs</th>
            <th className="text-right">Agents</th>
            <th className="text-right">Tools</th>
            <th className="text-right">In → out</th>
            <th>Version</th>
          </tr>
        </thead>
        <tbody>
          {skills.map((s) => {
            const draft = s.source !== "builtin" && s.liveVersion === null;
            const mode = MODE_CHIP[s.mode];
            return (
              <tr key={s.id} data-testid={`skills-row-${s.ref}`}>
                <td>
                  <span className="flex min-w-[16rem] items-center gap-3 py-1.5">
                    <span aria-hidden className="ui-skilltile shrink-0">
                      <Icon name={categoryIcon(s.category)} size={16} />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <button
                        type="button"
                        onClick={() => onOpen(s.id)}
                        aria-haspopup="dialog"
                        data-testid={`skills-row-${s.ref}-open`}
                        className="text-left font-medium text-ink hover:underline"
                      >
                        {s.name}
                      </button>
                      <span className="line-clamp-1 max-w-md text-xs text-ink-muted">
                        {s.description}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="whitespace-nowrap text-ink-muted">{categoryLabel(s.category)}</td>
                <td>
                  <span className="flex gap-1.5">
                    <Badge tone={mode.tone}>{mode.label}</Badge>
                    {writes(s, tools) ? <Badge tone="person">Sign-off</Badge> : null}
                  </span>
                </td>
                <td
                  className={cx(
                    "figures text-right",
                    s.usedBy > 0 ? "font-medium text-slate" : "text-ink",
                  )}
                  title={s.usedByNames?.length ? s.usedByNames.join("\n") : undefined}
                >
                  {s.usedBy}
                </td>
                <td className="figures text-right">{s.tools.length}</td>
                <td className="figures whitespace-nowrap text-right">
                  {s.inputs.length} → {s.outputs.length}
                </td>
                <td className="whitespace-nowrap">
                  {draft ? (
                    <Tag>Draft</Tag>
                  ) : s.liveVersion !== null ? (
                    <span className="reference text-ink-muted">v{s.liveVersion}</span>
                  ) : (
                    <span className="text-ink-muted">Built in</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableCard>
  );
}

function Stat({
  label,
  value,
  strong = false,
  title,
  testId,
}: {
  label: string;
  value: string;
  /** In slate: a number worth noticing (a skill in use). */
  strong?: boolean;
  title?: string | undefined;
  testId?: string;
}) {
  return (
    <span className="flex flex-col gap-0.5" title={title} data-testid={testId}>
      <span className="eyebrow text-ink-muted">{label}</span>
      <span className={cx("figures font-medium", strong ? "text-slate" : "text-ink")}>{value}</span>
    </span>
  );
}

/**
 * A skill's side sheet: all it says about itself (what it does, in and out, tools, connectors, who
 * uses it, how it runs), with Edit for an operator skill and Clone for any that doesn't run code.
 */
function SkillSheet({
  skill: s,
  tools,
  onClose,
}: {
  skill: SkillListItem;
  tools: readonly ToolSpec[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const clone = useAction();
  const version = versionText(s.liveVersion, s.latestVersion);
  // A built-in can't be changed; its clone is an operator skill draft, opened in the editor.
  const onClone = async () => {
    const res = await clone.call(apiRoutes.opsCloneSkill, { params: { id: s.id }, body: {} });
    if (res.ok) navigate(skillPath(res.data.skill.id));
  };
  return (
    <SideSheet
      testId="skill-sheet"
      onClose={onClose}
      eyebrow={
        <span className="flex flex-wrap items-center gap-2.5">
          <span aria-hidden className="ui-skilltile">
            <Icon name={categoryIcon(s.category)} size={16} />
          </span>
          <span className="text-sm text-ink-muted">
            {categoryLabel(s.category)} · {sourceText(s)}
            {version ? ` · ${version}` : ""}
          </span>
        </span>
      }
      title={s.name}
      footer={
        <>
          {s.source !== "builtin" ? (
            <Link
              to={skillPath(s.id)}
              className={buttonClass("primary", undefined, "sm")}
              data-testid={`skills-card-${s.ref}-edit`}
            >
              Edit
            </Link>
          ) : null}
          {s.mode !== "tool" ? (
            <Button
              size="sm"
              disabled={clone.busy}
              onClick={() => void onClone()}
              data-testid={`skills-card-${s.ref}-clone`}
            >
              {clone.busy ? "Cloning" : "Clone"}
            </Button>
          ) : null}
          {clone.error ? (
            <span role="alert" className="text-sm text-risk">
              {errorText(clone.error)}
            </span>
          ) : null}
        </>
      }
    >
      <p className="text-ink">{s.description}</p>
      <div className="grid grid-cols-3 gap-3 rounded-[var(--radius-md)] border border-line p-3">
        <Stat label="Agents" value={String(s.usedBy)} />
        <Stat label="Tools" value={String(s.tools.length)} />
        <Stat label="In → out" value={`${s.inputs.length} → ${s.outputs.length}`} />
      </div>
      <SheetSection label="Takes in → gives back">
        <Chain items={inOut(s.inputs, s.outputs)} />
      </SheetSection>
      <SheetSection label="How it runs">
        <span className="flex flex-wrap gap-1.5">
          <Badge tone={MODE_CHIP[s.mode].tone}>{MODE_CHIP[s.mode].label}</Badge>
          {writes(s, tools) ? <Badge tone="person">Sign-off</Badge> : null}
        </span>
        <p className="text-sm text-ink">{MODE_TEXT[s.mode]}</p>
        {writes(s, tools) ? (
          <p className="text-sm text-ink-muted">
            It writes to a client's tools, so a person signs each change by default.
          </p>
        ) : null}
      </SheetSection>
      {s.tools.length > 0 ? (
        <SheetSection label="Tools">
          <span className="flex flex-wrap gap-1.5">
            {s.tools.map((t) => (
              <Tag key={t}>{toolTitle({ id: t })}</Tag>
            ))}
          </span>
        </SheetSection>
      ) : null}
      {s.connectors.length > 0 ? (
        <SheetSection label="Connectors">
          <span className="flex flex-wrap gap-1.5">
            {s.connectors.map((c) => (
              <Tag key={c}>{c}</Tag>
            ))}
          </span>
        </SheetSection>
      ) : null}
      <SheetSection label="Used by">
        {s.usedByNames?.length ? (
          <ul className="flex flex-col gap-1 text-sm text-ink" data-testid="skill-sheet-used-by">
            {s.usedByNames.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">No client agents yet.</p>
        )}
      </SheetSection>
    </SideSheet>
  );
}
