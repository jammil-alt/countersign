// The agent page's Workflow tab (docs/sop-plan.md §6a, stream W; owner, 2026-11-21): the process
// drawn as the builder's chart, read only. The client sees each step, who does it, how it decides
// and its settings, and can't change any of it: no +, no dragging, no step panel. Pointing at a box
// shows its words; clicking it, tapping it or pressing Enter on it opens its card beside the chart.
//
// It reads the SOP's own route (on ASSIGNED_USER_ROUTES): the outline for the shape and the step
// lines for every word, never the bundle (invariant 11). So the chart, its cards and the SOP can't
// disagree.

import { type SopStepLine, type SopView, sopRoutes } from "@countersign/core";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { Chart } from "../../ops/flow/Chart";
import { FlowDndContext } from "../../ops/flow/dnd";
import type { FlowEnds, StatusMap } from "../../ops/flow/types";
import { boxWords, outlineProcess, outlineWorkflows, stepAnchor, stepLines } from "../../sop/chart";
import { Loaded } from "../../ui/page";
import { buttonClass, cx } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";
import { askSloan, PORTAL_PATHS } from "../paths";
import { WrongForm } from "./LineFeedback";

const NO_STATUS: StatusMap = new Map();
const NOTHING = () => {};
/** Read only: nothing can be dropped, so nothing is ever moved, added or connected. */
const NO_EVENTS = { onMove: NOTHING, onInsert: NOTHING, onConnect: NOTHING };

export function AgentWorkflow({ id }: { id: string }) {
  const sop = useApi(sopRoutes.portalAgentSop, { params: { id } });
  return (
    <div data-testid="portal-agent-workflow">
      <Loaded state={sop} skeleton={<SkeletonRows rows={8} columns={1} />}>
        {(view) => <WorkflowView id={id} view={view} />}
      </Loaded>
    </div>
  );
}

export function WorkflowView({ id, view }: { id: string; view: SopView }) {
  const { t } = useI18n();
  const workflows = useMemo(() => outlineWorkflows(view), [view]);
  const [workflow, setWorkflow] = useState<string | null>(workflows[0] ?? null);
  const process = useMemo(() => outlineProcess(view, workflow), [view, workflow]);
  const label = useMemo(() => boxWords(view, t), [view, t]);
  const lines = useMemo(() => stepLines(view), [view]);
  const ends: FlowEnds = useMemo(
    () => ({
      start:
        view.start.triggers.length > 0
          ? { title: t("sop.covers"), lines: view.start.triggers }
          : null,
      givesBack: null,
    }),
    [view, t],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [asking, setAsking] = useState(false);
  const line = selected ? (lines.get(selected) ?? null) : null;

  if (view.outline.length === 0) {
    return <p className="text-sm text-ink-muted">{t("workflow.empty")}</p>;
  }
  return (
    <section className="flex flex-col gap-3" aria-label={t("agent.tab.workflow")}>
      <div className="sop-wf-bar" data-testid="workflow-bar">
        <span className="ds-tag" data-testid="workflow-view-only">
          {t("workflow.viewOnly")}
        </span>
        <span className="text-sm text-ink-muted">
          {view.revision ? `${t("workflow.revision", { number: view.revision.number })} · ` : null}
          {t("workflow.hint")}
        </span>
        <span className="flex-1" />
        {workflows.length > 1 ? (
          <fieldset className="ds-seg flex-wrap" aria-label={t("workflow.which")}>
            {workflows.map((w) => (
              <button
                key={w ?? "one"}
                type="button"
                aria-pressed={w === workflow}
                onClick={() => {
                  setWorkflow(w);
                  setSelected(null);
                }}
              >
                {w}
              </button>
            ))}
          </fieldset>
        ) : null}
        <button
          type="button"
          className={buttonClass("secondary", undefined, "sm")}
          aria-expanded={asking}
          onClick={() => setAsking((a) => !a)}
          data-testid="workflow-ask-change"
        >
          {t("workflow.askChange")}
        </button>
      </div>
      {asking ? (
        <WrongForm
          agentId={id}
          line={{ section: "how", line: t("workflow.changeLine", { agent: view.agent.name }) }}
          onClose={() => setAsking(false)}
        />
      ) : null}
      <div className={cx("sop-wf", line && "sop-wf--open")}>
        <div className="flow-readonly sop-wf__chart" data-testid="workflow-chart">
          <FlowDndContext events={NO_EVENTS}>
            <Chart
              readOnly
              process={process}
              ends={ends}
              statuses={NO_STATUS}
              selected={selected}
              onSelect={setSelected}
              folded={folded}
              onFold={(stepId, fold) =>
                setFolded((f) => {
                  const next = new Set(f);
                  if (fold) next.add(stepId);
                  else next.delete(stepId);
                  return next;
                })
              }
              label={label}
              {...NO_EVENTS}
            />
          </FlowDndContext>
        </div>
        {line ? (
          <StepCard id={id} view={view} line={line} onClose={() => setSelected(null)} />
        ) : null}
      </div>
      <p className="text-xs text-ink-muted">{t("workflow.foot")}</p>
    </section>
  );
}

/** A step's card: what the SOP says of it, with links to its line in the SOP and to Sloan. */
function StepCard({
  id,
  view,
  line,
  onClose,
}: {
  id: string;
  view: SopView;
  line: SopStepLine;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [wrong, setWrong] = useState(false);
  const rows: [string, string][] = [];
  const how =
    line.method === "person"
      ? (line.who?.name ?? t("workflow.aPerson"))
      : line.method === "ai"
        ? `${t("sop.method.ai")}${line.model ? ` (${line.model})` : ""}`
        : line.method === "rules_then_ai"
          ? `${t("sop.method.rulesThen")} ${t("sop.method.ai")}${line.model ? ` (${line.model})` : ""}`
          : line.method === "rules"
            ? t("sop.method.rules")
            : null;
  const doer = line.method === "person" ? null : (line.who?.name ?? view.agent.name);
  if (how) rows.push([t("workflow.card.doneBy"), doer ? `${doer} · ${how}` : how]);
  const approval = line.approval;
  if (approval && approval.level === "ask" && approval.approvers.length > 0) {
    rows.push([
      t("sop.approves"),
      approval.approvers
        .map((a) => (a.condition ? `${a.party.name} ${a.condition}` : a.party.name))
        .join("; "),
    ]);
  }
  const by = approval?.byWhen ?? line.byWhen;
  if (by) {
    rows.push([
      t("workflow.card.deadline"),
      approval?.ifNoAnswer ? `${by}; ${t("sop.ifNoAnswer", { what: approval.ifNoAnswer })}` : by,
    ]);
  }
  for (const s of line.systems) {
    const level =
      s.level === "off"
        ? t("sop.level.off")
        : s.verb.toLowerCase() === "read"
          ? t("sop.level.on")
          : t(s.level === "auto" ? "sop.level.auto" : "sop.level.ask");
    rows.push([s.name, `${s.verb}: ${level}`]);
  }
  if (approval?.ifRejected) rows.push([t("workflow.card.ifRejected"), approval.ifRejected]);
  if (line.onError) rows.push([t("workflow.card.ifFails"), line.onError]);
  if (line.told.length > 0) rows.push([t("sop.told"), line.told.map((p) => p.name).join(", ")]);
  if (line.controls.length > 0) rows.push([t("sop.controls"), line.controls.join(", ")]);

  return (
    <aside className="sop-wf__card" aria-label={line.name} data-testid="workflow-card">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="ds-eyebrow">{t("sop.onStep", { step: line.number })}</span>
          <h3 className="type-subheading">{line.name}</h3>
        </div>
        <button
          type="button"
          className="ds-btn ds-btn--link text-xs"
          onClick={onClose}
          data-testid="workflow-card-close"
        >
          {t("workflow.close")}
        </button>
      </div>
      <p className="mt-1 text-sm">{line.purpose}</p>
      <dl className="sop-wf__rows">
        {rows.map(([k, v]) => (
          <div key={`${k}:${v}`}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="sop-wf__foot">
        <Link
          to={`${PORTAL_PATHS.agentSop(id)}#${stepAnchor(line.id)}`}
          className="ds-btn ds-btn--link text-xs"
          data-testid="workflow-card-sop"
        >
          {t("workflow.card.inSop", { step: line.number })}
        </Link>
        <Link
          to={askSloan(
            t("sop.askText", { agent: view.agent.name, line: `${line.number}. ${line.name}` }),
          )}
          className="ds-btn ds-btn--link text-xs"
          data-testid="workflow-card-ask"
        >
          {t("manual.ask")}
        </Link>
        <button
          type="button"
          className="ds-btn ds-btn--link text-xs"
          aria-expanded={wrong}
          onClick={() => setWrong((w) => !w)}
        >
          {t("manual.wrong")}
        </button>
      </div>
      {wrong ? (
        <WrongForm
          agentId={id}
          line={{ section: "how", lineId: line.id, line: `${line.number}. ${line.name}` }}
          onClose={() => setWrong(false)}
        />
      ) : null}
    </aside>
  );
}
