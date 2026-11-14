// O4 Skills and automations (`#O4-Skills`; ARCHITECTURE §9.2, §10.7): the steps agents are built
// from, in two tabs. Skills (the default) as cards or a list (category, version, what it does,
// in → out, how many agents use it); Automations (`?tab=automations`: reusable step chains,
// versioned, with their clean-run rate in live runs). Built-in skills come with the platform and
// packs; operator skills and automations open their own pages for versions, publish, rollback and
// tests.
//
// R8 (docs/plan.md §1.86): the Library's Skills bank (`/ops/library/skills`; `/ops/skills`
// redirects there). Each card says what the skill reads and the sites it browses. In the Library
// the automations are processes, so they show in the Processes bank (`automations` off: no tabs,
// and the automations aren't asked for).
//
// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14): two kinds of skill, Deterministic and
// AI, each card and row labelled with its kind and the list filtered by it. Skills that only wrap
// a tool are no longer listed (the API leaves them out): a process uses the tool as a read or
// write step.
import {
  type AutomationListItem,
  SKILL_KIND_LABEL,
  type SkillKind,
  type SkillListItem,
  type ToolSpec,
} from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { brief, saysMore } from "../../ui/brief";
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
import { toolName } from "../library/plain";
import { KIND_LINE } from "../library/words";
import { TableCard } from "../screens/business";
import { Chain, inOut, percent, stepChain, versionText } from "./parts";
import { CATEGORIES, categoryLabel } from "./skill-form";

export const SKILLS_PATH = "/ops/library/skills";
export const skillPath = (id: string) => `/ops/skills/${id}`;
export const automationPath = (id: string) => `/ops/skills/automations/${id}`;

const ALL = "all";

/** The kind filter: every skill, or one kind. */
export const KIND_FILTERS = [
  ["all", "All"],
  ["deterministic", "Deterministic"],
  ["ai", "AI"],
] as const;
type KindFilter = (typeof KIND_FILTERS)[number][0];

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

export function SkillsScreen({ automations: withAutomations = true }: { automations?: boolean }) {
  const library = useApi(apiRoutes.opsSkills);
  const automations = useApi(apiRoutes.opsAutomations, withAutomations ? {} : null);
  const [params] = useSearchParams();
  // DECISION: skills and automations are two tabs, not two stacked sections (2026-11-10): each is
  // a long list of its own, and the category filter only means something for skills. In the
  // Library (`automations` off) there is no Automations tab: they are the Processes bank's.
  const tab = withAutomations && params.get("tab") === "automations" ? "automations" : "skills";
  const [category, setCategory] = useState(ALL);
  const [kind, setKind] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useSkillsView();
  const [openId, setOpenId] = useState<string | null>(null);
  // Skill model (2026-11-10): tool wrappers leave the Library (the API no longer lists them; a
  // list from before still hides them). A process reads through the tool directly.
  const skills = (library.data?.skills ?? []).filter((s) => s.retired !== true);
  const autos = withAutomations ? (automations.data?.automations ?? []) : [];
  const tools = library.data?.tools ?? [];
  const q = search.trim().toLowerCase();

  const categories = [
    ...new Set([...CATEGORIES.map(([id]) => id), ...skills.map((s) => s.category)]),
  ].filter((c) => skills.some((s) => s.category === c));
  const shownSkills = skills.filter(
    (s) =>
      (category === ALL || s.category === category) &&
      (kind === "all" || kindOf(s) === kind) &&
      matches(q, s.name, s.description, s.ref, s.clientName),
  );
  const shownAutos = autos.filter((a) => matches(q, a.name, a.description, a.slug, a.clientName));

  const opened = openId ? skills.find((s) => s.id === openId) : undefined;
  const searchLabel = tab === "skills" ? "Search skills" : "Search automations";

  return (
    <Page testId="skills-library">
      {opened ? <SkillSheet skill={opened} tools={tools} onClose={() => setOpenId(null)} /> : null}
      <PageHeader
        title={withAutomations ? "Skills and automations" : "Skills"}
        subtitle={
          withAutomations
            ? "The steps agents are built from. A skill does one thing; an automation chains steps you reuse across agents."
            : "How an agent works something out, such as which bill an invoice belongs to. Deterministic skills follow rules and give the same answer every time; AI skills use a model. A skill never changes anything itself: a tool step after it does."
        }
        actions={
          <Link to="/ops/skills/new" className={buttonClass("primary")} data-testid="skills-new">
            Make a skill
          </Link>
        }
      />
      {withAutomations ? (
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
      ) : null}
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
        {tab === "skills" ? (
          <div className="ds-seg" data-testid="skills-kind">
            {KIND_FILTERS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={kind === id}
                data-testid={`skills-kind-${id}`}
                onClick={() => setKind(id)}
              >
                {label}
              </button>
            ))}
          </div>
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
            <EmptyState
              icon="worksheet"
              title="No skills yet"
              line="A skill is one job an agent can do, such as reading an invoice. Make one with the Builder."
            />
          ) : null}
          {library.data && skills.length > 0 && shownSkills.length === 0 ? (
            <EmptyState
              icon="search"
              title="No skill matches"
              line="Try another word, category or kind."
            />
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

/** The automations as rows; the Library's Processes bank shows it as processes used in others. */
export function AutomationsCard({
  state,
  shown,
  title = "Automations",
  line = "Step chains, versioned, dropped into a workflow as one block",
}: {
  state: ApiState<ResponseOf<typeof apiRoutes.opsAutomations>>;
  shown: AutomationListItem[];
  title?: string;
  line?: string;
}) {
  return (
    <Card
      titleAbove
      testId="automations"
      title={
        <span className="flex flex-col">
          {title}
          <span className="text-sm font-normal text-ink-muted">{line}</span>
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

/**
 * Skill model (2026-11-10): the skill's kind as the API derives it; a list without it reads by
 * its method (a rules skill is deterministic, anything with a model AI).
 */
export function kindOf(s: Pick<SkillListItem, "kind" | "method">): SkillKind {
  if (s.kind) return s.kind;
  return s.method === "rules" ? "deterministic" : "ai";
}

/** Skill model: the skill's kind as a tag, its meaning on hover. */
function KindTag({ skill: s, testId }: { skill: SkillListItem; testId?: string }) {
  const k = kindOf(s);
  return (
    <Tag {...(testId ? { testId } : {})}>
      <span title={KIND_LINE[k]}>{SKILL_KIND_LABEL[k]}</span>
    </Tag>
  );
}

/** R8: what the skill reads and browses. */
function SkillReach({ skill: s }: { skill: SkillListItem }) {
  const reads = s.reads ?? [];
  const browse = s.browse ?? null;
  if (reads.length === 0 && !browse) return null;
  return (
    <span className="flex flex-col gap-1 text-sm" data-testid={`skills-card-${s.ref}-reach`}>
      {reads.length > 0 ? (
        <span className="flex flex-wrap gap-x-2">
          <span className="text-ink-muted">Reads</span>
          <span className="reference text-ink">{reads.join(", ")}</span>
        </span>
      ) : null}
      {browse ? (
        <span className="flex flex-wrap gap-x-2">
          <span className="text-ink-muted">Browses</span>
          <span className="text-ink">
            {browse.sites.join(", ")} · {browse.pages.length}{" "}
            {browse.pages.length === 1 ? "page" : "pages"}
          </span>
        </span>
      ) : null}
    </span>
  );
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
  agent:
    "Runs as the agent, on the agent's model and instructions. Retired for new skills, so it can't be cloned: use an AI skill, then a write step.",
};

/** How the skill runs, in a sentence: an operator's rule rows aren't code. */
function modeText(s: SkillListItem): string {
  if (s.mode === "tool" && s.source !== "builtin") return "Runs its rule rows, no model.";
  return MODE_TEXT[s.mode];
}

/**
 * Whether Clone is offered. Merged with the skill model (2026-11-11): a clone is a new skill, so
 * code, the agent's own reasoning and rules then AI aren't offered; an AI task skill and an
 * operator's deterministic skill are. The server also refuses a skill that writes, and says so.
 */
function cloneable(s: SkillListItem): boolean {
  if (s.method === "rules_then_ai") return false;
  if (s.mode === "task") return true;
  return s.mode === "tool" && s.source !== "builtin";
}

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

/**
 * A skill in the library: its category (a slate tile with the area's icon), name, two lines of
 * what it does, its kind (Deterministic or AI), what it reads and browses, whether a person signs
 * its writes (copper, the brand's colour for people and sign-offs), and three numbers (client
 * agents using it, tools, fields in → out). The whole card opens its side sheet.
 */
// DECISION (merge of main): the card's "how it runs" word is the skill model's kind, Deterministic
// or AI, in place of main's Code / Task / Agent; the sheet still says how its mode runs.
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
          <span className="line-clamp-2 text-sm text-ink-muted">{brief(s.description)}</span>
          <SkillReach skill={s} />
          <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
            <KindTag skill={s} testId={`skills-card-${s.ref}-kind`} />
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
            <th>Kind</th>
            <th className="text-right">Agents</th>
            <th className="text-right">Tools</th>
            <th className="text-right">In → out</th>
            <th>Version</th>
          </tr>
        </thead>
        <tbody>
          {skills.map((s) => {
            const draft = s.source !== "builtin" && s.liveVersion === null;
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
                        {brief(s.description)}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="whitespace-nowrap text-ink-muted">{categoryLabel(s.category)}</td>
                <td>
                  <span className="flex gap-1.5">
                    <KindTag skill={s} testId={`skills-row-${s.ref}-kind`} />
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
 * uses it, how it runs), with Edit for an operator skill and Clone for one the skill model allows
 * as a new skill (`cloneable`).
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
          {cloneable(s) ? (
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
      <p className="text-ink">{brief(s.description)}</p>
      {saysMore(s.description) ? (
        <SheetSection label="In full">
          <p className="text-sm whitespace-pre-line text-ink" data-testid="skill-sheet-description">
            {s.description}
          </p>
        </SheetSection>
      ) : null}
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
          <KindTag skill={s} />
          {writes(s, tools) ? <Badge tone="person">Sign-off</Badge> : null}
        </span>
        <p className="text-sm text-ink">{KIND_LINE[kindOf(s)]}</p>
        <p className="text-sm text-ink-muted">{modeText(s)}</p>
        <SkillReach skill={s} />
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
              <Tag key={t}>{toolName(t)}</Tag>
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
