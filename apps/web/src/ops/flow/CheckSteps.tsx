// Check the steps (docs/builder-plan.md §12.5 F5, docs/plan.md §1.170 "Check the steps"; design:
// docs/design/builder.html `stepsHTML`, `rowsHTML`, `pathHTML`): a new build's draft as a list of
// lines before the chart. The draft is made as today ("Draft it now", saved); this list is shown
// over that saved version and edits it (ids made once, never regenerated). How it starts maps onto
// the triggers; each top-level step is a line; a decision is a block with its paths. Build it saves
// the edited bundle as a new version and asks the Builder once to fill the lines typed by hand,
// then opens the agent's workflow. A build with no draft yet (List the steps myself) is drafted
// from the lines' words on Build it.
//
// The step model (docs/step-model-plan.md; stream Q): an agent whose workflow is v5, and a build
// with no draft yet, are checked in the step model (./CheckSteps5, ./checkModel5). An agent whose
// workflow is still v4 keeps the v4 body below (./checkModel) until wave 4 deletes it. Both render
// the same parts (./checkParts): only the model underneath differs.

import { AnyAgentBundle, canonicalJson, type ProcessAgentBundle } from "@countersign/core";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Page } from "../../ui/page";
import { Loading } from "../../ui/primitives";
import {
  editWorkflow,
  locate,
  type NewId,
  ROOT,
  readProcessBundle,
  withStepModelWorkflows,
} from "../builder/model";
import { OPS_PATHS } from "../paths";
import { opsAgentHref } from "../screens/AgentRedirect";
import { processKindLabel } from "../workflow/describe";
import { CheckBody5, isStepModelBundle } from "./CheckSteps5";
import {
  addDecision,
  addEnding,
  addLine,
  addPath,
  afterPaths,
  blankProcess,
  countLines,
  decisionPaths,
  type EndKind,
  endingOf,
  fillRequest,
  finishLines,
  handAdded,
  type IfStep,
  lineToDecision,
  listWords,
  moveLine,
  movePathBelow,
  pathEnds,
  removeLine,
  removePath,
  renameLine,
  setAfterPaths,
  setCondition,
  setPathEnd,
  startWordsAll,
  wayOutWords,
} from "./checkModel";
import {
  AddButtons,
  type AgentData,
  askBuilderToFill,
  type CheckBodyProps,
  CheckFoot,
  CheckHeader,
  DecisionBlock,
  describeAgain,
  EndCards,
  type LineEvents,
  LineInput,
  LinesHelp,
  type LineView,
  LoopBlock,
  type PathView,
  quoted,
  TopLine,
  useCheckSensors,
  useFocusLine,
  useStart,
} from "./checkParts";
import type { CheckStepsState } from "./DescribeScreen";
import type { Process, Step } from "./types";

/** The route's screen: `/ops/lab/check/:id`, with the words Describe passed in its state. */
export function CheckStepsScreen() {
  const { id = "" } = useParams();
  const location = useLocation();
  const words = (location.state as Partial<CheckStepsState> | null)?.words;
  return (
    <Page width="narrow" testId="flow-check-page">
      <CheckSteps buildId={id} words={words} />
    </Page>
  );
}

export interface CheckStepsProps {
  buildId: string;
  /** The words the draft was made from; else the build's first message, else its goal. */
  words?: string | undefined;
  /** New ids (tests pass a counter); core's uuidv7 by default. */
  newId?: NewId | undefined;
}

/** Loads the build and its draft's latest version, then the list over it, v4 or v5. */
export function CheckSteps({ buildId, words, newId }: CheckStepsProps) {
  const build = useApi(apiRoutes.opsBuild, { params: { id: buildId } });
  const agentId = build.data?.build.agentId ?? null;
  const agent = useApi(apiRoutes.opsAgent, agentId ? { params: { id: agentId } } : null);
  if (build.error) return <ErrorNotice error={build.error} onRetry={build.reload} />;
  if (!build.data) return <Loading />;
  if (agentId && agent.error) return <ErrorNotice error={agent.error} onRetry={agent.reload} />;
  if (agentId && !agent.data) return <Loading />;
  const detail = build.data;
  const said =
    words ??
    detail.messages.find((m) => m.role === "operator")?.text ??
    detail.build.brief.goal?.text ??
    "";
  const data = agent.data ?? null;
  // DECISION (stream Q): no draft yet, or a draft whose workflow is v5, is checked in the step
  // model (the Builder drafts v5, and every new workflow starts as v5); a v4 draft keeps v4.
  const v5 = !data?.latest || isStepModelBundle(data.latest.bundle);
  const Body = v5 ? CheckBody5 : CheckBody;
  return (
    <Body
      // Read once: a refresh after Build it saves must not reset the lines under way.
      key={agentId ?? "none"}
      detail={detail}
      agent={data}
      words={said}
      newId={newId}
    />
  );
}

interface Loaded {
  bundle: ProcessAgentBundle | null;
  slug: string | null;
  workflowName: string;
  process: Process;
}

function load(agent: AgentData | null, newId: NewId | undefined): Loaded {
  const parsed = agent?.latest ? AnyAgentBundle.safeParse(agent.latest.bundle) : null;
  const bundle = parsed?.success ? readProcessBundle(parsed.data, {}) : null;
  const first = bundle?.workflows[0];
  return {
    bundle,
    slug: first?.slug ?? null,
    workflowName: first?.name ?? agent?.agent.name ?? "",
    process: first?.workflow ?? blankProcess(newId),
  };
}

// ── The v4 body ──────────────────────────────────────────────────────────────────────────────────

/** A v4 step as a line. */
function lineOf(step: Step): LineView {
  return {
    id: step.id,
    name: step.name,
    typed: step.kind === "missing",
    tag: step.kind === "missing" ? null : { kind: step.kind, label: processKindLabel(step) },
    reports:
      step.kind === "collect"
        ? step.items.map(
            (it) =>
              `${it.name}, from ${it.owner.replace(/^seat:/, "").replaceAll("-", " ")}, due ${it.due}`,
          )
        : undefined,
  };
}

/** A v4 decision's paths as the block shows them; a path's Stop at its end is "ends here". */
function pathsOf(step: IfStep): PathView[] {
  return decisionPaths(step).map((p, i) => {
    const ends = pathEnds(p.steps);
    const path = p.otherwise ? null : step.paths[i];
    return {
      key: p.key,
      container: p.container,
      pathId: path?.id ?? null,
      condition: path?.name ?? "",
      otherwise: p.otherwise,
      lines: (ends ? p.steps.slice(0, -1) : p.steps).map(lineOf),
      ends,
    };
  });
}

function CheckBody({ detail, agent, words, newId }: CheckBodyProps) {
  const api = useApiClient();
  const navigate = useNavigate();
  const [loaded] = useState(() => load(agent, newId));
  // No saved draft to check: the lines are the operator's own, drafted on Build it.
  const mine = !loaded.bundle || !loaded.slug || !agent;
  const [process, setProcess] = useState<Process>(() =>
    mine && loaded.process.steps.length === 0
      ? addLine(loaded.process, ROOT, 0, "", newId).process
      : loaded.process,
  );
  const start = useStart(process, setProcess, mine, newId);
  const [, setFocus] = useFocusLine();
  // The way out picked for a line added under How it ends, until the Builder fills that line.
  const [endChosen, setEndChosen] = useState<Record<string, EndKind>>({});
  const [busy, setBusy] = useState<"build" | "fill" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const counts = countLines(loaded.process);
  const lines = finishLines(process);
  const empty = lines.steps.length === 0;
  const ending = endingOf(lines, endChosen);
  // A run that can end with nothing reported is a dead end: it isn't built until it has a way out.
  const deadEnd = ending.dead.length > 0;
  const workflows = loaded.bundle?.workflows ?? [];

  const edit = (fn: (p: Process) => Process) => setProcess((p) => fn(p));
  const add = (container: string, index: number, words = "") => {
    const out = addLine(process, container, index, words, newId);
    setProcess(out.process);
    setFocus(out.stepId);
  };
  const workflowHref = () =>
    agent && loaded.slug ? `${opsAgentHref(agent.agent)}/workflows/${loaded.slug}` : null;

  function backToDescription() {
    const back = describeAgain(detail, words, mine);
    navigate(back.to, { state: back.state });
  }

  async function buildIt() {
    setBusy("build");
    setError(null);
    try {
      if (mine) {
        // List the steps myself: the build has no draft, so it is drafted from the list's words.
        const out = await api.call(apiRoutes.opsDraftBuildNow, {
          params: { id: detail.build.id },
          body: { description: listWords(lines, start.said) },
        });
        const made = out.draft?.agentId ?? out.build.agentId;
        navigate(made ? `/ops/agents/${made}/workflow` : OPS_PATHS.build(detail.build.id));
        return;
      }
      if (!agent?.latest || !loaded.bundle || !loaded.slug) return;
      const slug = loaded.slug;
      const next = editWorkflow(loaded.bundle, slug, () => lines);
      let from = agent.latest.id;
      if (canonicalJson(next) !== canonicalJson(loaded.bundle)) {
        const saved = await api.call(apiRoutes.opsSaveVersion, {
          params: { id: agent.agent.id },
          body: {
            // The agent's v5 workflows (set aside when read) are saved back as they were.
            bundle: withStepModelWorkflows(next, agent.latest.bundle),
            parentVersionId: from,
            changeNote: "Checked the steps",
          },
        });
        from = saved.version.id;
      }
      const waysInChanged =
        canonicalJson(lines.triggers) !== canonicalJson(loaded.process.triggers);
      const text = fillRequest({
        workflowName: loaded.workflowName,
        added: handAdded(loaded.process, lines),
        starts:
          start.edited || waysInChanged
            ? startWordsAll(lines.triggers, start.edited ? start.words : null)
            : null,
      });
      if (text) {
        // Asked once; when it fails, the lines stay missing steps and show on the chart.
        setBusy("fill");
        await askBuilderToFill(api, agent.agent.id, from, text);
      }
      navigate(workflowHref() ?? OPS_PATHS.build(detail.build.id));
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  }

  const sensors = useCheckSensors();
  const onDragEnd = (e: DragEndEvent) => {
    const to = e.over ? process.steps.findIndex((s) => s.id === e.over?.id) : -1;
    if (to < 0 || e.active.id === e.over?.id) return;
    edit((p) => moveLine(p, String(e.active.id), to));
  };

  const lineProps: LineEvents = {
    rename: (id, w) => edit((p) => renameLine(p, id, w)),
    commit: (id) => edit((p) => lineToDecision(p, id, newId)),
    remove: (id) => edit((p) => removeLine(p, id)),
    enter: (id, container, index) => {
      const turned = lineToDecision(process, id, newId);
      if (turned === process) return add(container, index + 1);
      setProcess(turned);
      const made = locate(turned, id)?.step;
      if (made?.kind === "if" && made.paths[0]) setFocus(`cond:${made.paths[0].id}`);
    },
    isNew: (id) => !loaded.bundle || !hadStep(loaded.process, id),
  };

  return (
    <div className="flex flex-col gap-6" data-testid="flow-check">
      <CheckHeader mine={mine} counts={counts} words={words} onEdit={backToDescription} />
      {start.section}

      <section className="flex flex-col gap-3 rounded-md border border-line bg-surface p-5">
        <LinesHelp />
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <SortableContext
            items={process.steps.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol className="flex flex-col gap-2" data-testid="flow-check-lines">
              {process.steps.map((s, i) => (
                <TopLine key={s.id} id={s.id} name={s.name} number={i + 1}>
                  {s.kind === "if" ? (
                    <DecisionBlock
                      paths={pathsOf(s)}
                      after={afterPaths(s)}
                      below={process.steps.slice(i + 1).length}
                      events={lineProps}
                      onRemove={() => edit((p) => removeLine(p, s.id))}
                      onCondition={(pathId, w) => edit((p) => setCondition(p, s.id, pathId, w))}
                      onAddPath={() => {
                        const out = addPath(process, s.id, newId);
                        setProcess(out.process);
                        if (out.pathId) setFocus(`cond:${out.pathId}`);
                      }}
                      onRemovePath={(pathId) => edit((p) => removePath(p, s.id, pathId))}
                      onAddStep={(container, index) => add(container, index)}
                      onEnd={(container, end) => edit((p) => setPathEnd(p, container, end, newId))}
                      onAfter={(how) => edit((p) => setAfterPaths(p, s.id, how, newId))}
                      onMoveBelow={(container) => edit((p) => movePathBelow(p, s.id, container))}
                    />
                  ) : s.kind === "for_each" || s.kind === "repeat" ? (
                    <LoopBlock
                      line={lineOf(s)}
                      each={s.kind === "for_each"}
                      inner={s.steps.map(lineOf)}
                      number={i + 1}
                      index={i}
                      events={lineProps}
                      onAddStep={(container, index) => add(container, index)}
                    />
                  ) : (
                    <LineInput
                      line={lineOf(s)}
                      container={ROOT}
                      index={i}
                      label={`Step ${i + 1}`}
                      events={lineProps}
                    />
                  )}
                </TopLine>
              ))}
            </ol>
          </SortableContext>
        </DndContext>
        <AddButtons
          onStep={() => add(ROOT, process.steps.length)}
          onDecision={() => {
            const out = addDecision(process, ROOT, process.steps.length, "", newId);
            setProcess(out.process);
            const made = out.process.steps.find((x) => x.id === out.stepId);
            if (made?.kind === "if" && made.paths[0]) setFocus(`cond:${made.paths[0].id}`);
          }}
        />
      </section>

      <section
        className="flex flex-col gap-3 rounded-md border border-line bg-surface p-5"
        data-testid="flow-check-ending"
      >
        <h2 className="text-lg font-medium text-ink">How it ends</h2>
        <p className="ds-help text-sm">
          Where the result goes. Every run ends by changing a tool, handing off to another agent or
          reaching a person, so nothing it finds is left with nowhere to go.
        </p>
        <EndCards
          on={ending.kinds}
          onPick={(k) => {
            const out = addEnding(process, k, newId);
            setProcess(out.process);
            setEndChosen((was) => ({ ...was, [out.stepId]: k }));
            setFocus(out.stepId);
          }}
        />
        {deadEnd ? (
          <p className="text-sm text-signal-ink" data-testid="flow-check-dead-end">
            Waiting on you: a run can end on {quoted(ending.dead.map((s) => s.name))} with nothing
            reported out. Choose where the result goes; it adds the last step.
          </p>
        ) : null}
        {ending.ways.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-ink" data-testid="flow-check-ways-out">
            {ending.ways.map((w) => (
              <li
                key={w.step.id}
                className="flex items-start gap-2"
                data-testid="flow-check-way-out"
                data-how={w.how}
              >
                <span className="text-ink-muted" aria-hidden>
                  ·
                </span>
                <span>{wayOutWords(w, workflows)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {error ? <ErrorNotice error={error} /> : null}
      <CheckFoot
        busy={busy}
        disabled={(mine && empty) || deadEnd}
        mine={mine}
        onBuild={() => void buildIt()}
        onBack={backToDescription}
        onQuestions={() => navigate(OPS_PATHS.build(detail.build.id))}
        onBlank={() => navigate(workflowHref() ?? OPS_PATHS.build(detail.build.id))}
      />
    </div>
  );
}

function hadStep(process: Process, id: string): boolean {
  let found = false;
  const visit = (steps: readonly Step[]) => {
    for (const s of steps) {
      if (s.id === id) found = true;
      if (s.kind === "if") {
        for (const p of s.paths) visit(p.steps);
        visit(s.otherwise.steps);
      }
      if (s.kind === "for_each" || s.kind === "repeat") visit(s.steps);
    }
  };
  visit(process.steps);
  return found;
}
