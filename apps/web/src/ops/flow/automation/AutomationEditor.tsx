// An automation in the one-screen builder (docs/builder-plan.md §12.1, F7; docs/plan.md §1.170):
// "Automations and loops should also use this view and this builder; it should just have a clearer
// input and output so it can be embedded into a process" (owner, 2026-11-21). The same parts as an
// agent's builder (the bar, the rail, the chart, the step's side panel around the inspector), with
// no trigger: the chart starts with Takes in (the automation's input fields) and ends with Gives
// back (its output), both edited in the side panel. Edits go through `../../builder/model` and
// its History; a save is a new draft version, and Publish makes it live. Agents move to it only
// by their own next version (versions are immutable).
//
// At `/ops/skills/automations/:id/steps`, opened from the automation's page ("Edit steps"); an
// automation step's box in an agent's chart links here too (`automationStepsPath` in ./paths).
import {
  canonicalJson,
  type OpsConnection,
  type AutomationDefinition,
  parseSkillRef,
  processes,
} from "@countersign/core";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { z } from "zod";
import type { ResponseOf } from "../../../api/client";
import { apiRoutes } from "../../../api/routes";
import { useApi } from "../../../api/useApi";
import { Loaded } from "../../../ui/page";
import { Button } from "../../../ui/primitives";
import { errorText, isCode, Notice, useAction } from "../../agents/ui";
import {
  type BuilderData,
  type BuilderProblem,
  catalogSkillKind,
  connectorName,
  paletteConnectors,
  paletteSections,
  toolConnector,
  typingContext,
  writeLabelOf,
} from "../../builder/catalog";
import { Inspector } from "../../builder/Inspector";
import {
  type ApprovalEnv,
  commit,
  createStep,
  getContainer,
  type History,
  insertStep,
  locate,
  moveStep,
  newPath,
  type PaletteItem,
  type Process,
  ROOT,
  redo,
  removeStep,
  type Step,
  startHistory,
  undo,
  updateStep,
  workflowCounts,
} from "../../builder/model";
import { NO_PEOPLE } from "../../builder/people";
import { readableErrors, stepNamer } from "../../builder/problems";
import { LIBRARY_PATHS } from "../../library/paths";
import {
  PROCESS_KIND_LABEL,
  processKindLabel,
  processStepDetail,
  type StepLabels,
} from "../../workflow/describe";
import { Chart } from "../Chart";
import { FlowDndContext } from "../dnd";
import { FlowBar, type FlowView } from "../FlowBar";
import { FLOW_GIVES_BACK_ID, FLOW_START_ID } from "../layout";
import { Rail } from "../Rail";
import { StepPanel } from "../StepPanel";
import { StepTable } from "../StepTable";
import { buildStatuses, counts, nextOpen, stepOrder } from "../status";
import type { FlowSubject, InsertPoint, SettleItem, StepStatus } from "../types";
import { GivesBackFields, TakesInFields } from "./EndsFields";
import {
  type AutomationDraft,
  type AutomationFace,
  automationEnds,
  draftProcess,
  editable,
  outputPaths,
  toDefinition,
  toDraft,
  withFace,
  withProcess,
} from "./ends";
import { automationPagePath } from "./paths";

type AutomationData = ResponseOf<typeof apiRoutes.opsAutomation>;
type Catalog = ResponseOf<typeof apiRoutes.opsAutomationBuilderCatalog>;
type Connection = z.infer<typeof OpsConnection>;

interface Saved {
  id: string;
  version: number;
  status: string;
  definition: AutomationDefinition;
  canon: string;
}

export function AutomationEditor() {
  const { id = "" } = useParams();
  const state = useApi(apiRoutes.opsAutomation, { params: { id } });
  const catalog = useApi(apiRoutes.opsAutomationBuilderCatalog, {
    params: { id },
    life: "catalog",
  });
  // A client's own automation is built with that client's connected tools only.
  const clientId = state.data?.automation.clientId ?? null;
  const connections = useApi(
    apiRoutes.opsClientConnections,
    clientId ? { params: { id: clientId } } : null,
  );
  return (
    <Loaded state={state}>
      {(loaded) => (
        <Loaded state={catalog}>
          {(c) =>
            clientId ? (
              <Loaded state={connections}>
                {(conn) => (
                  <Opened
                    key={loaded.automation.id}
                    loaded={loaded}
                    catalog={c}
                    connections={conn.connections}
                    onChanged={state.reload}
                  />
                )}
              </Loaded>
            ) : (
              <Opened
                key={loaded.automation.id}
                loaded={loaded}
                catalog={c}
                connections={null}
                onChanged={state.reload}
              />
            )
          }
        </Loaded>
      )}
    </Loaded>
  );
}

function BackLink({ id, name }: { id: string; name: string }) {
  return (
    <p className="text-sm text-ink-muted">
      <Link to={LIBRARY_PATHS.processes} className="hover:underline">
        Library · Workflows
      </Link>{" "}
      /{" "}
      <Link to={automationPagePath(id)} className="hover:underline" data-testid="flow-auto-back">
        {name}
      </Link>{" "}
      / Steps
    </p>
  );
}

function Opened(props: {
  loaded: AutomationData;
  catalog: Catalog;
  connections: readonly Connection[] | null;
  onChanged(): void;
}) {
  const { automation, versions } = props.loaded;
  const latest = versions[0];
  if (!latest || !editable(latest.definition)) {
    return (
      <div className="flex flex-col gap-4" data-testid="flow-auto">
        <BackLink id={automation.id} name={automation.name} />
        <Notice tone="warning" testId="flow-auto-old">
          {latest
            ? "This automation was saved in the older step format, so its steps can't be edited here. Save its steps again from an agent's workflow to edit them."
            : "This automation has no version to open."}
        </Notice>
      </div>
    );
  }
  return (
    <Editor
      {...props}
      start={{
        id: latest.id,
        version: latest.version,
        status: latest.status,
        definition: latest.definition,
      }}
    />
  );
}

const END_TITLE = { [FLOW_START_ID]: "Takes in", [FLOW_GIVES_BACK_ID]: "Gives back" } as const;
type EndId = keyof typeof END_TITLE;
const isEnd = (id: string | null): id is EndId => id === FLOW_START_ID || id === FLOW_GIVES_BACK_ID;

function Editor(props: {
  loaded: AutomationData;
  catalog: Catalog;
  connections: readonly Connection[] | null;
  onChanged(): void;
  start: Omit<Saved, "canon">;
}) {
  const { automation } = props.loaded;
  const subject: FlowSubject = { kind: "automation", automationId: automation.id };
  const data = useMemo<BuilderData>(
    () => ({ catalog: props.catalog, events: [] }),
    [props.catalog],
  );
  const action = useAction();

  const [saved, setSaved] = useState<Saved>(() => ({
    ...props.start,
    canon: canonicalJson(props.start.definition),
  }));
  const [history, setHistory] = useState<History>(() =>
    startHistory(toDraft(props.start.definition)),
  );
  // The History holds bundles; the editor only ever puts its own drafts in it.
  const draft = history.present as AutomationDraft;
  const process = draftProcess(draft);
  const face = draft.automation;
  const definition = useMemo(() => toDefinition(draft, saved.definition), [draft, saved]);
  const dirty = canonicalJson(definition) !== saved.canon;

  const apply = (fn: (d: AutomationDraft) => AutomationDraft, key: string | null = null) =>
    setHistory((h) => commit(h, fn(h.present as AutomationDraft), key));
  const edit = (fn: (p: Process) => Process, key: string | null = null) =>
    apply((d) => withProcess(d, fn(draftProcess(d))), key);
  const setFace = (next: Partial<AutomationFace>, key: string) =>
    apply((d) => withFace(d, next), key);

  // ── What the steps are typed and checked with: the same context the server saves with ──
  const ctx = useMemo<processes.ProcessValidationContext>(
    () => ({ ...typingContext(data), input: face.input }),
    [data, face.input],
  );
  const problems = useMemo<BuilderProblem[]>(() => {
    // Core's validator for an automation, as the server runs it on a save; named for the draft's
    // one process, so its words name the steps.
    const errors = processes
      .validateAnyAutomation(definition, ctx)
      .errors.map((e) => ({ ...e, workflow: definition.slug }));
    return readableErrors(errors, draft);
  }, [definition, ctx, draft]);
  const statuses = useMemo(() => buildStatuses({ process, problems }), [process, problems]);
  // What the validator says about the automation itself, not a step: its input or its output.
  const endProblems = useMemo(() => {
    const own = problems.filter((e) => !e.stepId);
    const at = (root: string) =>
      own.filter((e) => e.field === root || e.field.startsWith(`${root}.`));
    const input = at("input");
    const output = at("output");
    return { input, output, other: own.filter((e) => !input.includes(e) && !output.includes(e)) };
  }, [problems]);
  const open = counts(statuses);
  const endIssues = Number(endProblems.input.length > 0) + Number(endProblems.output.length > 0);

  // ── The rail: the same catalog, with no triggers; a client's own, its connected tools ──
  const connectors = useMemo(
    () =>
      props.connections === null
        ? new Set(data.catalog.connectors.map((c) => c.id))
        : paletteConnectors({
            agent: { kind: "client", testCopy: false },
            bundle: draft,
            data,
            connections: props.connections,
            // The catalog already left the test-only connectors out where they don't belong.
            sandbox: true,
          }),
    [props.connections, data, draft],
  );
  const sections = useMemo(
    () => paletteSections(draft, data, connectors),
    [draft, data, connectors],
  );

  // ── Names for the boxes' second lines ──
  const labels = useMemo<StepLabels>(
    () => ({
      skill: (ref) =>
        data.catalog.skills.find((s) => s.ref === ref || parseSkillRef(s.ref).id === ref)
          ?.definition.name,
      connector: (toolId) => {
        const c = toolConnector(toolId, data);
        return c ? connectorName(data, c) : undefined;
      },
      changesClientTool: (toolId) => {
        const tool = ctx.tools?.[toolId];
        return tool ? tool.sideEffect === "external" : undefined;
      },
      skillKind: (ref) => catalogSkillKind(data, ref),
      writeLabel: (toolId) => writeLabelOf(data, toolId),
    }),
    [data, ctx],
  );
  const label = (step: Step) => ({
    title: step.name.trim() || PROCESS_KIND_LABEL[step.kind],
    kind: processKindLabel(step, labels),
    detail: processStepDetail(step, labels),
  });
  const names = useMemo(() => stepNamer(process, draft), [process, draft]);
  const ends = useMemo(
    () => automationEnds({ input: face.input, output: face.output }, names),
    [face.input, face.output, names],
  );

  // ── Selection, folding, where the next step goes ──
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<FlowView>("chart");
  const [insertAt, setInsertAt] = useState<InsertPoint | null>(null);
  const [notice, setNotice] = useState<{ tone: "positive" | "warning"; body: string } | null>(null);
  const step = selected && !isEnd(selected) ? (locate(process, selected) ?? null) : null;
  // A step that is gone (an undo, a remove) closes its panel.
  useEffect(() => {
    if (selected && !isEnd(selected) && !locate(process, selected)) setSelected(null);
  }, [selected, process]);

  const env: ApprovalEnv = {
    ctx,
    // As a template's: an automation's writes keep their approval; only a client's agent, with its
    // own connections, may be set to run one without.
    agentKind: "template",
    mode: "suggest_only",
    matrices: {},
    connectorName: (id) => connectorName(data, id),
  };

  const add = (item: PaletteItem | undefined, at: InsertPoint | null) => {
    if (!item) {
      // + on an arrow: the next step picked from the rail goes there.
      setInsertAt(at);
      return;
    }
    if (item.type === "trigger") return;
    const made = createStep(item, ctx);
    edit((p) => {
      const where = at ?? { container: ROOT, index: p.steps.length };
      return insertStep(p, where.container, where.index, made);
    });
    setInsertAt(null);
    setSelected(made.id);
  };

  const chartEvents = {
    onSelect: (id: string | null) => setSelected(id),
    onInsert: (at: InsertPoint, item?: unknown) => add(item as PaletteItem | undefined, at),
    onMove: (stepId: string, to: InsertPoint) =>
      edit((p) => moveStep(p, stepId, to.container, to.index)),
    // The dot under a step dropped on another: that step comes right after it.
    onConnect: (fromId: string, toId: string) =>
      edit((p) => {
        const from = locate(p, fromId);
        const to = locate(p, toId);
        if (!from || !to) return p;
        const before = to.container === from.container && to.index < from.index;
        return moveStep(p, toId, from.container, from.index + (before ? 0 : 1));
      }),
    onAddPath: (ifId: string) =>
      edit((p) =>
        updateStep(p, ifId, (s) =>
          s.kind === "if" ? { ...s, paths: [...s.paths, newPath(s.paths.length + 1)] } : s,
        ),
      ),
    onFold: (stepId: string, fold: boolean) =>
      setFolded((f) => {
        const next = new Set(f);
        if (fold) next.add(stepId);
        else next.delete(stepId);
        return next;
      }),
  };

  // ── Save and publish ──
  const save = async (): Promise<Saved | null> => {
    const snapshot = definition;
    const canon = canonicalJson(snapshot);
    const res = await action.call(apiRoutes.opsSaveAutomationVersion, {
      params: { id: automation.id },
      body: {
        definition: snapshot,
        parentVersionId: saved.id,
        changeNote: "Edited in the builder",
      },
    });
    if (res.ok) {
      const v = res.data.version;
      // The server's copy: it works out what the automation needs from the agent again.
      const stored = editable(v.definition) ? v.definition : snapshot;
      const next: Saved = {
        id: v.id,
        version: v.version,
        status: v.status,
        definition: stored,
        canon: canonicalJson(toDefinition(draft, stored)),
      };
      setSaved(next);
      props.onChanged();
      return next;
    }
    if (isCode(res.error, "no_op")) {
      action.clear();
      const next = { ...saved, canon };
      setSaved(next);
      return next;
    }
    return null;
  };
  const onSave = async () => {
    setNotice(null);
    const v = await save();
    if (v) {
      setNotice({
        tone: "positive",
        body: `Saved v${v.version} as a draft.${problems.length ? " Settle what is left before it can be published." : " Publish it when it is ready."}`,
      });
    }
  };
  const [publishing, setPublishing] = useState(false);
  const onPublish = async () => {
    setNotice(null);
    setPublishing(true);
    try {
      const v = dirty ? await save() : saved;
      if (!v) return;
      const res = await action.call(apiRoutes.opsPublishAutomation, {
        params: { id: automation.id, vid: v.id },
      });
      if (res.ok) {
        setSaved((s) => ({ ...s, status: res.data.version.status }));
        setNotice({
          tone: "positive",
          body: `v${res.data.version.version} is live. Agents move to it with their own next version.`,
        });
        props.onChanged();
      }
    } finally {
      setPublishing(false);
    }
  };

  // Undo and redo from the keyboard, outside a field being typed in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const order = stepOrder(process);
  const goToNextOpen = () => {
    const next = nextOpen(statuses, order, isEnd(selected) ? null : selected);
    if (next) setSelected(next);
    else if (endProblems.input.length) setSelected(FLOW_START_ID);
    else if (endProblems.output.length) setSelected(FLOW_GIVES_BACK_ID);
  };
  const live = saved.status === "live";
  const canPublish = problems.length === 0 && (dirty || !live);

  const endStatus = (id: EndId): StepStatus | undefined => {
    const mine = id === FLOW_START_ID ? endProblems.input : endProblems.output;
    if (mine.length === 0) return undefined;
    const items: SettleItem[] = mine.map((e) => ({
      key: `problem:${e.code}:${id}:${e.field}`,
      stepId: id,
      level: "issue",
      title: e.message,
      source: "problem",
    }));
    return { stepId: id, level: "issue", items, decided: [] };
  };

  let panel = null;
  if (isEnd(selected)) {
    panel = (
      <StepPanel
        key={selected}
        stepId={selected}
        kind="Automation"
        title={END_TITLE[selected]}
        status={endStatus(selected)}
        onClose={() => setSelected(null)}
      >
        {selected === FLOW_START_ID ? (
          <TakesInFields schema={face.input} onChange={(input) => setFace({ input }, "input")} />
        ) : (
          <GivesBackFields
            output={face.output}
            paths={outputPaths({ input: face.input, steps: process.steps }, ctx)}
            errorsAt={(name) =>
              endProblems.output
                .filter(
                  (e) => e.field === `output.${name}` || e.field.startsWith(`output.${name}.`),
                )
                .map((e) => e.message)
            }
            onChange={(output) => setFace({ output }, "output")}
          />
        )}
      </StepPanel>
    );
  } else if (step) {
    const s = step.step;
    const siblings = getContainer(process, step.container);
    panel = (
      <StepPanel
        key={s.id}
        stepId={s.id}
        kind={processKindLabel(s, labels)}
        place={siblings ? { n: step.index + 1, of: siblings.length } : null}
        title={s.name}
        onRename={(name) =>
          edit((p) => updateStep(p, s.id, (x) => ({ ...x, name })), `${s.id}:name`)
        }
        status={statuses.get(s.id)}
        next={(() => {
          const id = nextOpen(statuses, order, s.id);
          const found = id ? locate(process, id) : null;
          return found ? { id: found.step.id, name: label(found.step).title } : null;
        })()}
        onNext={setSelected}
        onRemove={() => {
          edit((p) => removeStep(p, s.id));
          setSelected(null);
        }}
        removeLabel={s.kind === "if" ? "Remove this decision" : undefined}
        onClose={() => setSelected(null)}
      >
        <Inspector
          layout="panel"
          workflow={process}
          bundle={draft}
          selection={{ type: "step", id: s.id }}
          data={data}
          ctx={ctx}
          env={env}
          errors={problems}
          template={null}
          // An automation asks people by their role, never by name.
          people={NO_PEOPLE}
          focus={null}
          connectors={connectors}
          tenantId={automation.clientId}
          onStep={(id, fn, key) => edit((p) => updateStep(p, id, fn), key)}
          onProcess={(fn, key) => edit(fn, key)}
          onTrigger={() => {}}
          onAddTrigger={() => {}}
          onRemoveTrigger={() => {}}
          onDelete={(id) => {
            edit((p) => removeStep(p, id));
            setSelected(null);
          }}
        />
      </StepPanel>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="flow-auto" data-subject={subject.kind}>
      <BackLink id={automation.id} name={automation.name} />
      {notice ? (
        <Notice tone={notice.tone} testId="flow-auto-notice">
          {notice.body}
        </Notice>
      ) : null}
      {action.error ? (
        <Notice tone="warning" testId="flow-auto-error">
          {errorText(action.error)}
        </Notice>
      ) : null}
      {endProblems.other.map((e) => (
        <Notice key={`${e.code}:${e.field}`} tone="warning" testId="flow-auto-problem">
          {e.message}
        </Notice>
      ))}
      <div className="flow-auto">
        <FlowBar
          name={face.name}
          onRename={(name) => setFace({ name }, "name")}
          version={{ state: live ? "live" : "draft", version: saved.version }}
          counts={workflowCounts(process, env)}
          open={{ issues: open.issues + endIssues, questions: open.questions }}
          onNextOpen={goToNextOpen}
          view={view}
          onView={setView}
          canUndo={history.past.length > 0}
          canRedo={history.future.length > 0}
          onUndo={() => setHistory(undo)}
          onRedo={() => setHistory(redo)}
          onSave={() => void onSave()}
          saving={action.busy && !publishing}
          saved={!dirty}
          primary={
            <Button
              variant="primary"
              size="sm"
              working={publishing}
              disabled={!canPublish || action.busy}
              title={
                problems.length
                  ? "Settle what is left first"
                  : canPublish
                    ? "Make this version the live one"
                    : "This version is already live"
              }
              data-testid="flow-auto-publish"
              onClick={() => void onPublish()}
            >
              Publish
            </Button>
          }
        />
        <FlowDndContext events={chartEvents}>
          <div className="flow-auto__body" data-panel={panel ? "" : undefined}>
            <Rail sections={sections} onPick={(item) => add(item, insertAt)} />
            <div className="flow-auto__main">
              {insertAt ? (
                <p className="flow-auto__hint" data-testid="flow-auto-insert-hint">
                  Pick a step from the list on the left to add it here.{" "}
                  <button
                    type="button"
                    className="ds-btn ds-btn--link"
                    onClick={() => setInsertAt(null)}
                  >
                    Cancel
                  </button>
                </p>
              ) : null}
              {view === "chart" ? (
                <Chart
                  process={process}
                  ends={ends}
                  statuses={statuses}
                  selected={selected}
                  folded={folded}
                  label={label}
                  {...chartEvents}
                />
              ) : (
                <div className="flow-auto__list">
                  <StepTable
                    process={process}
                    statuses={statuses}
                    selected={selected}
                    onSelect={setSelected}
                    label={label}
                  />
                </div>
              )}
            </div>
            {panel}
          </div>
        </FlowDndContext>
      </div>
    </div>
  );
}

export default AutomationEditor;
