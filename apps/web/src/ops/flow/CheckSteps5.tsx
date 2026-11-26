// Check the steps in the step model (docs/step-model-plan.md §4, §5, §9, §13a; stream Q): the same
// screen as for a v4 draft (./CheckSteps, ./checkParts), over a v5 workflow (./checkModel5).
//
// - A line typed by hand is a Do that is "Not built yet". Under it, "Pick what it does" matches it
//   with the steps builder's own Uses picker: a Do done by rules, AI or a person, using an action,
//   a skill or an automation (a Change or a Send starts with its approver on, invariant 8).
// - Every path that doesn't rejoin ends on an End, which the builder keeps; each End picks the
//   declared outputs it delivers (§9). The four way-out cards declare outputs; the outputs editor
//   is the steps builder's own.
// - The checks are core's `validateWorkflow`, in the steps builder's words and list. Build it waits
//   only on the ending ones (no silent deaths); the rest are for the chart, the Builder and Publish.

import { canonicalJson, steps } from "@countersign/core";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Select } from "../../ui/forms";
import { Button, Loading } from "../../ui/primitives";
import { Notice } from "../agents/ui";
import type { NewId } from "../builder/model";
import { NO_PEOPLE } from "../builder/people";
import { triggerFields, useStepsCatalog } from "../builder/steps/catalog";
import type { StepFormEnv } from "../builder/steps/form-kit";
import { workflowIssues } from "../builder/steps/issues";
import { kindLabel, ROOT } from "../builder/steps/model";
import { OutputsEditor } from "../builder/steps/OutputsEditor";
import {
  DONE_BY_CHOICES,
  doneByLabel,
  NO_USES_CONTEXT,
  type UsesContext,
  usesLabel,
} from "../builder/steps/options";
import { PublishIssues, withWorkflow } from "../builder/steps/StepsBuilder";
import { guardedSuggestion, type SuggestFn, suggestBody } from "../builder/steps/suggest";
import type { DoneBy, EndStep, Step, Workflow } from "../builder/steps/types";
import { UsesPicker } from "../builder/steps/UsesPicker";
import { OPS_PATHS } from "../paths";
import { opsAgentHref } from "../screens/AgentRedirect";
import { type EndKind, fillRequest, startWordsAll } from "./checkModel";
import {
  addDecision,
  addEnding,
  addLine,
  addPath,
  afterPaths,
  blankWorkflow,
  countLines,
  decisionPaths,
  ENDING_CODES,
  endingOf,
  endWords,
  type ForkStep,
  findLine,
  finishLines,
  hadStep,
  handAdded,
  isHandLine,
  lineToDecision,
  listWords,
  matchLine,
  moveLine,
  movePathBelow,
  pathEnds,
  readWorkflow,
  removeLine,
  removePath,
  renameLine,
  setAfterPaths,
  setCondition,
  setPathEnd,
  toggleEndOutput,
} from "./checkModel5";
import {
  AddButtons,
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
  TopLine,
  useCheckSensors,
  useFocusLine,
  useStart,
} from "./checkParts";

/** The catalog a draft's lines are matched against; none for a build with no draft yet. */
export function CheckBody5(props: CheckBodyProps) {
  if (!props.agent?.latest) return <Body5 {...props} uses={NO_USES_CONTEXT} catalog={null} />;
  return <WithCatalog {...props} agentId={props.agent.agent.id} />;
}

function WithCatalog(props: CheckBodyProps & { agentId: string }) {
  const catalog = useStepsCatalog(props.agentId);
  if (catalog.error) return <ErrorNotice error={catalog.error} onRetry={catalog.reload} />;
  if (!catalog.ready) return <Loading />;
  return <Body5 {...props} uses={catalog.uses} catalog={catalog} />;
}

interface Loaded5 {
  slug: string | null;
  workflowName: string;
  /** The draft's workflow as stored and read (null: no draft, the lines are the operator's). */
  start: Workflow | null;
  workflow: Workflow;
  /** Why a stored v5 workflow didn't read. */
  error: string | null;
}

interface StoredBundle {
  workflows?: { slug: string; name: string; workflow?: unknown }[];
}

function load5(agent: CheckBodyProps["agent"], newId: NewId | undefined): Loaded5 {
  const first = (agent?.latest?.bundle as StoredBundle | null)?.workflows?.[0];
  if (!agent?.latest || !first) {
    return {
      slug: null,
      workflowName: agent?.agent.name ?? "",
      start: null,
      workflow: blankWorkflow(newId),
      error: null,
    };
  }
  const read = readWorkflow(first.workflow, newId);
  const parsed = read ? null : steps.Workflow.safeParse(first.workflow);
  return {
    slug: first.slug,
    workflowName: first.name,
    start: read,
    workflow: read ?? blankWorkflow(newId),
    error: parsed && !parsed.success ? (parsed.error.issues[0]?.message ?? "see its JSON") : null,
  };
}

function Body5({
  detail,
  agent,
  words,
  newId,
  uses,
  catalog,
}: CheckBodyProps & { uses: UsesContext; catalog: ReturnType<typeof useStepsCatalog> | null }) {
  const api = useApiClient();
  const navigate = useNavigate();
  const [loaded] = useState(() => load5(agent, newId));
  // No saved draft to check: the lines are the operator's own, drafted on Build it.
  const mine = !loaded.start || !loaded.slug || !agent;
  const [workflow, setWorkflow] = useState<Workflow>(() =>
    mine && countLines(loaded.workflow).steps + countLines(loaded.workflow).decisions === 0
      ? addLine(loaded.workflow, ROOT, 0, "", newId).workflow
      : loaded.workflow,
  );
  const start = useStart(workflow, setWorkflow, mine, newId);
  const [, setFocus] = useFocusLine();
  // The card picked for a line added under How it ends (a person finishing it).
  const [endChosen, setEndChosen] = useState<Record<string, EndKind>>({});
  const [matching, setMatching] = useState<string | null>(null);
  const [busy, setBusy] = useState<"build" | "fill" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const counts = countLines(loaded.workflow);
  const lines = useMemo(() => finishLines(workflow), [workflow]);
  const empty = countLines(lines).steps + countLines(lines).decisions === 0;
  const ending = endingOf(lines, endChosen);
  const issues = useMemo(() => workflowIssues(lines, uses), [lines, uses]);
  // No silent deaths (§9): a path that ends with nothing delivered waits on the operator.
  const blocking = issues.filter((i) => ENDING_CODES.has(i.code));

  const edit = (fn: (w: Workflow) => Workflow) => setWorkflow((w) => fn(w));
  const add = (container: string, index: number, w = "") => {
    const out = addLine(workflow, container, index, w, newId);
    setWorkflow(out.workflow);
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
      if (!agent?.latest || !loaded.start || !loaded.slug) return;
      let from = agent.latest.id;
      if (canonicalJson(lines) !== canonicalJson(loaded.start)) {
        const saved = await api.call(apiRoutes.opsSaveVersion, {
          params: { id: agent.agent.id },
          body: {
            // Only this workflow changes; the rest of the bundle goes as stored.
            bundle: withWorkflow(agent.latest.bundle, loaded.slug, lines),
            parentVersionId: from,
            changeNote: "Checked the steps",
          },
        });
        from = saved.version.id;
      }
      const waysInChanged = canonicalJson(lines.triggers) !== canonicalJson(loaded.start.triggers);
      const text = fillRequest({
        workflowName: loaded.workflowName,
        added: handAdded(loaded.start, lines),
        starts:
          start.edited || waysInChanged
            ? startWordsAll(lines.triggers, start.edited ? start.words : null)
            : null,
      });
      if (text) {
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
    const to = e.over ? workflow.steps.findIndex((s) => s.id === e.over?.id) : -1;
    if (to < 0 || e.active.id === e.over?.id) return;
    edit((w) => moveLine(w, String(e.active.id), to));
  };

  const lineOf = (step: Step): LineView => lineView(step, uses);
  const lineProps: LineEvents = {
    rename: (id, w) => edit((x) => renameLine(x, id, w)),
    commit: (id) => edit((x) => lineToDecision(x, id, newId)),
    remove: (id) => edit((x) => removeLine(x, id)),
    enter: (id, container, index) => {
      const turned = lineToDecision(workflow, id, newId);
      if (turned === workflow) return add(container, index + 1);
      setWorkflow(turned);
      const made = findLine(turned, id);
      if (made?.kind === "fork" && made.paths[0]) setFocus(`cond:${made.paths[0].id}`);
    },
    isNew: (id) => !hadStep(loaded.start, id),
    // Matching a typed line needs the catalog: a draft's, not a list with no agent yet.
    extra: catalog
      ? (line) =>
          line.typed ? (
            <MatchLine
              open={matching === line.id}
              onOpen={(on) => setMatching(on ? line.id : null)}
              stepId={line.id}
              workflow={workflow}
              uses={uses}
              onPick={(pick) => {
                edit((w) => matchLine(w, line.id, pick, uses));
                setMatching(null);
              }}
            />
          ) : null
      : undefined,
  };

  const endRow = (end: EndStep) => (
    <EndRow
      end={end}
      workflow={workflow}
      onToggle={(o) => edit((w) => toggleEndOutput(w, end.id, o))}
    />
  );
  const pathsOf = (s: ForkStep): PathView[] =>
    decisionPaths(s).map((p, i) => {
      const ends = pathEnds(p.steps);
      const path = p.otherwise ? null : s.paths[i];
      const last = p.steps.at(-1);
      return {
        key: p.key,
        container: p.container,
        pathId: path?.id ?? null,
        condition: path?.name ?? "",
        otherwise: p.otherwise,
        lines: (ends ? p.steps.slice(0, -1) : p.steps).map(lineOf),
        ends,
        endSlot: ends && last?.kind === "end" ? endRow(last) : undefined,
      };
    });

  // The main line's steps are numbered without its Ends, which stay where they are.
  let n = 0;
  const numbered = workflow.steps.map((s) => (s.kind === "end" ? null : ++n));
  const sortable = workflow.steps.filter((s) => s.kind !== "end").map((s) => s.id);

  return (
    <div className="flex flex-col gap-6" data-testid="flow-check">
      <CheckHeader mine={mine} counts={counts} words={words} onEdit={backToDescription} />
      {loaded.error ? (
        <Notice tone="warning">
          This workflow doesn't read in the step model: {loaded.error}. Check it in the builder.
        </Notice>
      ) : null}
      {start.section}

      <section className="flex flex-col gap-3 rounded-md border border-line bg-surface p-5">
        <LinesHelp />
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <SortableContext items={sortable} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col gap-2" data-testid="flow-check-lines">
              {workflow.steps.map((s, i) => {
                const number = numbered[i] ?? 0;
                if (s.kind === "end") {
                  return (
                    <li key={s.id} className="flex items-start gap-2 pl-11" data-step-id={s.id}>
                      <div className="min-w-0 flex-1">{endRow(s)}</div>
                    </li>
                  );
                }
                const below = workflow.steps.slice(i + 1).filter((x) => x.kind !== "end").length;
                return (
                  <TopLine key={s.id} id={s.id} name={s.name} number={number}>
                    {s.kind === "fork" ? (
                      <DecisionBlock
                        paths={pathsOf(s)}
                        after={afterPaths(s)}
                        below={below}
                        events={lineProps}
                        onRemove={() => edit((w) => removeLine(w, s.id))}
                        onCondition={(pathId, w) => edit((x) => setCondition(x, s.id, pathId, w))}
                        onAddPath={() => {
                          const out = addPath(workflow, s.id, newId);
                          setWorkflow(out.workflow);
                          if (out.pathId) setFocus(`cond:${out.pathId}`);
                        }}
                        onRemovePath={(pathId) => edit((w) => removePath(w, s.id, pathId))}
                        onAddStep={(container, index) => add(container, index)}
                        onEnd={(container, end) =>
                          edit((w) => setPathEnd(w, container, end, newId))
                        }
                        onAfter={(how) => edit((w) => setAfterPaths(w, s.id, how, newId))}
                        onMoveBelow={(container) => edit((w) => movePathBelow(w, s.id, container))}
                      />
                    ) : s.kind === "for_each" || s.kind === "repeat" ? (
                      <LoopBlock
                        line={lineOf(s)}
                        each={s.kind === "for_each"}
                        inner={s.steps.map(lineOf)}
                        number={number}
                        index={i}
                        events={lineProps}
                        onAddStep={(container, index) => add(container, index)}
                      />
                    ) : (
                      <LineInput
                        line={lineOf(s)}
                        container={ROOT}
                        index={i}
                        label={`Step ${number}`}
                        events={lineProps}
                      />
                    )}
                  </TopLine>
                );
              })}
            </ol>
          </SortableContext>
        </DndContext>
        <AddButtons
          onStep={() => add(ROOT, workflow.steps.length)}
          onDecision={() => {
            const out = addDecision(workflow, ROOT, workflow.steps.length, "", newId);
            setWorkflow(out.workflow);
            const made = findLine(out.workflow, out.stepId);
            if (made?.kind === "fork" && made.paths[0]) setFocus(`cond:${made.paths[0].id}`);
          }}
        />
      </section>

      <section
        className="flex flex-col gap-3 rounded-md border border-line bg-surface p-5"
        data-testid="flow-check-ending"
      >
        <h2 className="text-lg font-medium text-ink">How it ends</h2>
        <p className="ds-help text-sm">
          Where the result goes. Every path ends on an End that delivers one of the workflow's
          outputs: a change to a tool, a hand-off, a report, or nothing to do and why. Nothing it
          finds is left with nowhere to go.
        </p>
        <EndCards
          on={ending.kinds}
          onPick={(k) => {
            const out = addEnding(workflow, k, newId);
            setWorkflow(out.workflow);
            if (k === "person" && out.stepId) {
              const id = out.stepId;
              setEndChosen((was) => ({ ...was, [id]: k }));
              setFocus(id);
            }
          }}
        />
        {blocking.length > 0 ? (
          <p className="text-sm text-signal-ink" data-testid="flow-check-dead-end">
            Waiting on you: {blocking[0]?.message}
            {blocking.length > 1 ? ` And ${blocking.length - 1} more about how it ends.` : ""}
          </p>
        ) : null}
        {ending.ends.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-ink" data-testid="flow-check-ways-out">
            {ending.ends.map((e) => (
              <li
                key={e.end.id}
                className="flex items-start gap-2"
                data-testid="flow-check-way-out"
                data-how="end"
              >
                <span className="text-ink-muted" aria-hidden>
                  ·
                </span>
                <span>{endWords(e)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {catalog ? (
          <OutputsSection
            workflow={workflow}
            uses={uses}
            catalog={catalog}
            people={NO_PEOPLE}
            agentId={agent?.agent.id ?? ""}
            issues={issues}
            onChange={setWorkflow}
          />
        ) : null}
      </section>

      {catalog && issues.length > 0 ? (
        <PublishIssues
          issues={issues}
          show
          name={(id) => findLine(workflow, id)?.name.trim() || "A step"}
          outputName={(id) => workflow.outputs.find((o) => o.id === id)?.name ?? id}
          onToggle={() => {}}
          onPick={(id) => setFocus(id)}
        />
      ) : null}

      {error ? <ErrorNotice error={error} /> : null}
      <CheckFoot
        busy={busy}
        disabled={(mine && empty) || blocking.length > 0}
        mine={mine}
        onBuild={() => void buildIt()}
        onBack={backToDescription}
        onQuestions={() => navigate(OPS_PATHS.build(detail.build.id))}
        onBlank={() => navigate(workflowHref() ?? OPS_PATHS.build(detail.build.id))}
      />
    </div>
  );
}

// ── Lines ────────────────────────────────────────────────────────────────────────────────────────

/** A v5 step as a line: a Do's tag says what it uses, else who does it; other kinds by name. */
export function lineView(step: Step, uses: UsesContext): LineView {
  if (step.kind === "do") {
    const typed = isHandLine(step);
    const person = step.doneBy === "person" || step.doneBy === "contact";
    const label = step.uses
      ? usesLabel(step, uses)
      : step.doneBy
        ? doneByLabel(step.doneBy)
        : kindLabel("do");
    return {
      id: step.id,
      name: step.name,
      typed,
      tag: typed ? null : { kind: person ? "person" : "do", label },
      reports:
        step.uses?.type === "collect" && step.collect
          ? step.collect.items.map(
              (it) =>
                `${it.name}, from ${it.owner.replace(/^seat:/, "").replaceAll("-", " ")}, due ${it.due}`,
            )
          : undefined,
    };
  }
  return {
    id: step.id,
    name: step.name,
    typed: false,
    tag: { kind: step.kind, label: kindLabel(step.kind) },
  };
}

/**
 * "Pick what it does" under a typed line: who does it, then what it uses, with the steps builder's
 * own Uses picker. "Nothing yet" keeps the work written in the step, for the builder's form.
 */
function MatchLine({
  open,
  onOpen,
  stepId,
  workflow,
  uses,
  onPick,
}: {
  open: boolean;
  onOpen(on: boolean): void;
  stepId: string;
  workflow: Workflow;
  uses: UsesContext;
  onPick(pick: { doneBy: DoneBy; uses: steps.Uses | undefined }): void;
}) {
  const [doneBy, setDoneBy] = useState<DoneBy>("rules");
  const step = findLine(workflow, stepId);
  if (!open) {
    return (
      <div>
        <Button
          variant="link"
          size="sm"
          onClick={() => onOpen(true)}
          data-testid="flow-check-line-match"
        >
          Pick what it does
        </Button>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-line p-3"
      data-testid="flow-check-line-matcher"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
        Done by
        <Select
          value={doneBy}
          aria-label="Done by"
          className="w-48"
          data-testid="flow-check-line-doneby"
          onChange={(e) => setDoneBy(e.target.value as DoneBy)}
        >
          {DONE_BY_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
        <Button variant="ghost" size="sm" onClick={() => onOpen(false)}>
          Cancel
        </Button>
      </div>
      <UsesPicker
        doneBy={doneBy}
        step={{ uses: step?.kind === "do" ? step.uses : undefined }}
        ctx={uses}
        onPick={(u) => onPick({ doneBy, uses: u })}
      />
    </div>
  );
}

/** An End: what it delivers, each declared output a switch (§9). It is filled, never removed. */
function EndRow({
  end,
  workflow,
  onToggle,
}: {
  end: EndStep;
  workflow: Workflow;
  onToggle(outputId: string): void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm"
      data-testid="flow-check-end"
      data-step-id={end.id}
    >
      <span className="ds-pill shrink-0">End</span>
      <span className="text-ink-muted">delivers</span>
      {workflow.outputs.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={end.outputs.includes(o.id)}
          className={
            end.outputs.includes(o.id)
              ? "ds-pill ds-pill--accent"
              : "ds-pill text-ink-muted hover:text-ink"
          }
          onClick={() => onToggle(o.id)}
          data-testid="flow-check-end-output"
        >
          {o.name.trim() || "An output with no name"}
        </button>
      ))}
      {workflow.outputs.length === 0 ? (
        <span className="text-ink-muted">nothing yet. Choose where the result goes below.</span>
      ) : null}
      {end.nothingToDo?.trim() ? (
        <span className="text-ink-muted">nothing to do: {end.nothingToDo.trim()}</span>
      ) : null}
    </div>
  );
}

/** The declared outputs in full, with the steps builder's own editor, folded until opened. */
function OutputsSection({
  workflow,
  uses,
  catalog,
  people,
  agentId,
  issues,
  onChange,
}: {
  workflow: Workflow;
  uses: UsesContext;
  catalog: ReturnType<typeof useStepsCatalog>;
  people: StepFormEnv["people"];
  agentId: string;
  issues: ReturnType<typeof workflowIssues>;
  onChange(next: Workflow): void;
}): ReactNode {
  const api = useApiClient();
  const suggest = useCallback<SuggestFn>(
    async (request) => {
      const answer = await api.call(apiRoutes.opsStepSuggest, {
        params: { id: agentId },
        body: suggestBody(workflow, request),
      });
      return guardedSuggestion(answer, request.step);
    },
    [api, agentId, workflow],
  );
  const env: StepFormEnv = {
    workflow,
    uses,
    trigger: triggerFields(workflow, catalog.events),
    people,
    suggest,
    models: catalog.models,
  };
  return (
    <details className="border-t border-line pt-3" data-testid="flow-check-outputs">
      <summary className="cursor-pointer text-sm font-medium text-ink">
        The outputs, in full · {workflow.outputs.length}
        <span className="ml-2 text-xs font-normal text-ink-muted">
          Which action, who gets the report, and what goes with it.
        </span>
      </summary>
      <div className="pt-3">
        <OutputsEditor
          workflow={workflow}
          env={env}
          issues={issues.filter(
            (i) => i.at !== undefined && workflow.outputs.some((o) => o.id === i.at),
          )}
          onChange={onChange}
        />
      </div>
    </details>
  );
}
