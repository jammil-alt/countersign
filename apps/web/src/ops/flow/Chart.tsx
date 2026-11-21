// The chart (docs/builder-plan.md §12, F1; design: docs/design/builder.html, its graphHTML()): a
// process drawn as small boxes and arrows, laid out by ./layout from the nested steps. Arrows and
// frames are one SVG layer; the boxes, path labels and + points are HTML on top of it.
//
// Click a box to open it (onSelect); point at one for its details; press + on an arrow to add a
// step there (onInsert); "+ Add a path" beside a decision (onAddPath). The details sit on the
// stage beside the box, outside the zoomed chart: they shrink with it, far more slowly, and stay
// readable at any zoom (tipScale), on whichever side of the box has the room. Drag a box onto a + or
// another box to move it, or the dot under it onto the step that should come next (./dnd: the
// host's DndContext, so the rail's items drag onto the chart too). Zoom with the buttons or Ctrl
// or Cmd and the wheel; drag the background to move around. Marks come from the host's statuses:
// an issue (risk), a question (signal, in words), a try's Did / Would / Failed with the path taken
// drawn in the positive colour, and Customized or Added against the template.
//
// Props only: the host owns the process and applies every change.

import { useDndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "../../ui/icons";
import { cx, pillClass, type Tone } from "../../ui/primitives";
import { containersWithin, type Step } from "../builder/model";
import { PROCESS_KIND_LABEL, processStepDetail } from "../workflow/describe";
import {
  boxDragId,
  dotDragId,
  type FlowDragData,
  type FlowDropData,
  insertDropId,
  START_DROP_ID,
} from "./dnd";
import "./flow.css";
import {
  FLOW_GIVES_BACK_ID,
  FLOW_START_ID,
  type FlowBox,
  type FlowEdge,
  type FlowInsert,
  type FlowTail,
  layoutFlow,
} from "./layout";
import type { ChartProps, FlowEnds, InsertPoint, StatusMap, StepStatus, TryMark } from "./types";

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;
/** How long the pointer rests on a box before its details show. */
export const TIP_DELAY_MS = 400;

/** The smallest and the largest a box's details are drawn, against their size at 100%. */
export const TIP_SCALE_MIN = 0.85;
export const TIP_SCALE_MAX = 1.15;
/** The space between a box and its details, and between the details and the chart's edge. */
const TIP_GAP = 12;
const TIP_EDGE = 8;
/** Kept clear at the bottom of the chart: the zoom buttons sit there, over everything. */
const TIP_FOOT = 60;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

/**
 * How big a box's details are drawn at a zoom. They follow the chart, but far less than it does:
 * a little smaller zoomed out, a little larger zoomed in, and never too small to read.
 */
// DECISION (owner, 2026-11-21): the square root of the zoom, held between 85% and 115%: at 25% the
// chart's boxes are a quarter their size and the details still read at 85%.
export function tipScale(zoom: number): number {
  const s = Math.min(TIP_SCALE_MAX, Math.max(TIP_SCALE_MIN, Math.sqrt(zoom)));
  return Math.round(s * 100) / 100;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

type Labeller = NonNullable<ChartProps["label"]>;

/** A step's title, kind and detail in words, as the rest of the builder says them. */
export const defaultLabel: Labeller = (step: Step) => ({
  title: step.name.trim() || PROCESS_KIND_LABEL[step.kind],
  kind: PROCESS_KIND_LABEL[step.kind],
  detail: processStepDetail(step),
});

/** Whether a try reached this step: it ran, would have written, failed or waits on a person. */
function reached(mark: TryMark | undefined): boolean {
  return !!mark && mark.status !== "skipped";
}

const TRY_WORD: Record<Exclude<TryMark["status"], "skipped">, { word: string; tone: Tone }> = {
  did: { word: "Did", tone: "positive" },
  would: { word: "Would", tone: "positive" },
  failed: { word: "Failed", tone: "risk" },
  waiting: { word: "Waiting", tone: "warning" },
};

interface Marks {
  tried: boolean;
  /** Whether an arrow lies on the path the try took. */
  edgeOn(e: FlowEdge): boolean;
}

function marksFor(statuses: StatusMap): Marks {
  const reachedIds = new Set<string>();
  for (const s of statuses.values()) if (reached(s.tried)) reachedIds.add(s.stepId);
  const tried = reachedIds.size > 0;
  const on = (id: string | null) =>
    id === FLOW_START_ID ? tried : id === FLOW_GIVES_BACK_ID ? false : !!id && reachedIds.has(id);
  return {
    tried,
    edgeOn: (e) => {
      if (!tried || e.dashed || !e.from || !on(e.from)) return false;
      // Into the end: on when the step before it ran; elsewhere, when the step it leads to did.
      return e.to === null || e.to === FLOW_GIVES_BACK_ID ? true : on(e.to);
    },
  };
}

export function Chart(props: ChartProps) {
  const { process, ends, statuses, selected, folded, readOnly = false } = props;
  const label = props.label ?? defaultLabel;
  const layout = useMemo(() => layoutFlow(process, { ends, folded }), [process, ends, folded]);
  const marks = useMemo(() => marksFor(statuses), [statuses]);
  const { active } = useDndContext();
  const dragging = active !== null && !readOnly;

  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const viewport = useRef<HTMLDivElement | null>(null);
  // Where to put the scroll after a zoom: a point that stays still, or centred (Fit).
  const anchor = useRef<
    { type: "point"; fx: number; fy: number; px: number; py: number } | { type: "fit" } | null
  >(null);

  const zoomTo = useCallback((next: number, px?: number, py?: number) => {
    const v = viewport.current;
    const old = zoomRef.current;
    const z = clampZoom(next);
    if (z === old) return;
    if (v) {
      const ax = px ?? v.clientWidth / 2;
      const ay = py ?? v.clientHeight / 3;
      anchor.current = {
        type: "point",
        fx: (v.scrollLeft + ax) / old,
        fy: (v.scrollTop + ay) / old,
        px: ax,
        py: ay,
      };
    }
    setZoom(z);
  }, []);

  const fit = useCallback(() => {
    const v = viewport.current;
    if (!v || v.clientWidth === 0 || v.clientHeight === 0) return;
    const z = clampZoom(
      Math.min(1, (v.clientWidth - 40) / layout.width, (v.clientHeight - 60) / layout.height),
    );
    anchor.current = { type: "fit" };
    if (z === zoomRef.current) centre(v);
    else setZoom(z);
  }, [layout.width, layout.height]);

  useLayoutEffect(() => {
    const v = viewport.current;
    const a = anchor.current;
    anchor.current = null;
    if (!v || !a) return;
    if (a.type === "fit") {
      centre(v);
      return;
    }
    v.scrollLeft = a.fx * zoom - a.px;
    v.scrollTop = a.fy * zoom - a.py;
  }, [zoom]);

  // First paint: the top of the flow, centred.
  useLayoutEffect(() => {
    if (viewport.current) centre(viewport.current);
  }, []);

  // Ctrl or Cmd and the wheel zooms around the pointer (a listener that may cancel the scroll).
  useEffect(() => {
    const v = viewport.current;
    if (!v) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = v.getBoundingClientRect();
      zoomTo(
        zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1),
        e.clientX - r.left,
        e.clientY - r.top,
      );
    };
    v.addEventListener("wheel", onWheel, { passive: false });
    return () => v.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  // Dragging the background moves the chart; a click on it clears the selection.
  const pan = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(
    null,
  );
  const [panning, setPanning] = useState(false);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const v = viewport.current;
    if (!v || e.button !== 0) return;
    if ((e.target as Element).closest?.("[data-flow-hit]")) return;
    pan.current = {
      x: e.clientX,
      y: e.clientY,
      left: v.scrollLeft,
      top: v.scrollTop,
      moved: false,
    };
    v.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    const v = viewport.current;
    if (!p || !v) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!p.moved) setPanning(true);
    p.moved = true;
    v.scrollLeft = p.left - dx;
    v.scrollTop = p.top - dy;
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    pan.current = null;
    viewport.current?.releasePointerCapture?.(e.pointerId);
    setPanning(false);
    if (p && !p.moved) props.onSelect(null);
  };

  // Details on hover, after a short rest; none while dragging.
  const [tipFor, setTipFor] = useState<string | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hover = useCallback((id: string | null) => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null;
    if (id === null) {
      setTipFor(null);
      return;
    }
    tipTimer.current = setTimeout(() => setTipFor(id), TIP_DELAY_MS);
  }, []);
  useEffect(
    () => () => {
      if (tipTimer.current) clearTimeout(tipTimer.current);
    },
    [],
  );

  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrow = `flow-ah-${uid}`;
  const arrowOn = `flow-ah-on-${uid}`;

  const tipBox = tipFor && !dragging ? layout.boxes.find((b) => b.id === tipFor) : undefined;

  return (
    <div
      className={cx("flow-chart", dragging && "is-dragging", panning && "is-panning")}
      data-testid="flow-chart"
    >
      <div
        ref={viewport}
        className="flow-chart__viewport"
        data-testid="flow-chart-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="flow-chart__stage"
          style={{ width: layout.width * zoom, height: layout.height * zoom }}
        >
          <div
            className="flow-graph"
            style={{
              width: layout.width,
              height: layout.height,
              transform: zoom === 1 ? undefined : `scale(${zoom})`,
            }}
          >
            <svg
              className={cx("flow-svg", marks.tried && "is-tried")}
              width={layout.width}
              height={layout.height}
              aria-hidden
            >
              <defs>
                <marker
                  id={arrow}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path className="flow-ah" d="M0 0L10 5L0 10z" />
                </marker>
                <marker
                  id={arrowOn}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path className="flow-ah flow-ah--on" d="M0 0L10 5L0 10z" />
                </marker>
              </defs>
              {layout.frames.map((f) => (
                <g
                  key={`frame-${f.stepId}`}
                  className={cx("flow-frame", f.unreachable && "is-dead")}
                >
                  <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={10} />
                  <text x={f.x + 12} y={f.y + f.h - 9}>
                    {f.text}
                  </text>
                </g>
              ))}
              {layout.edges.map((e) => {
                const on = marks.edgeOn(e);
                return (
                  <path
                    key={e.id}
                    data-testid={`flow-edge-${e.id}`}
                    className={cx("flow-edge", on && "is-on", e.dashed && "is-dashed")}
                    d={`M${e.points.map(([x, y]) => `${x} ${y}`).join(" L")}`}
                    markerEnd={e.arrow ? `url(#${on ? arrowOn : arrow})` : undefined}
                  />
                );
              })}
              {layout.boxes
                .filter((b) => b.shape === "diamond")
                .map((b) => {
                  const s = statuses.get(b.id);
                  return (
                    <polygon
                      key={`diamond-${b.id}`}
                      className={cx(
                        "flow-diamond",
                        selected === b.id && "is-sel",
                        b.unreachable && "is-dead",
                        s?.level === "issue" && "has-issue",
                        reached(s?.tried) && "is-on",
                      )}
                      points={`${b.x + b.w / 2},${b.y} ${b.x + b.w},${b.y + b.h / 2} ${b.x + b.w / 2},${b.y + b.h} ${b.x},${b.y + b.h / 2}`}
                    />
                  );
                })}
            </svg>

            {layout.boxes.map((b) =>
              b.role === "step" ? (
                <StepBox
                  key={b.id}
                  box={b}
                  status={statuses.get(b.id)}
                  selected={selected === b.id}
                  tried={marks.tried}
                  readOnly={readOnly}
                  zoom={zoom}
                  label={label}
                  props={props}
                  onHover={hover}
                />
              ) : (
                <EndBox
                  key={b.id}
                  box={b}
                  ends={ends}
                  selected={selected === b.id}
                  readOnly={readOnly}
                  onSelect={props.onSelect}
                  onHover={hover}
                />
              ),
            )}

            {layout.edges.map((e) =>
              e.label ? (
                <button
                  key={`label-${e.id}`}
                  type="button"
                  data-flow-hit
                  data-testid={`flow-path-${e.label.pathId}`}
                  className={cx("flow-label", marks.edgeOn(e) && "is-on")}
                  style={{ left: e.label.x, top: e.label.y, maxWidth: e.label.maxWidth }}
                  title={e.label.text}
                  onClick={() => props.onSelect(e.label?.ifId ?? null)}
                >
                  <b>{e.label.letter}</b>
                  {e.label.text}
                </button>
              ) : null,
            )}

            {readOnly ? null : (
              <>
                {layout.inserts.map((p) => (
                  <InsertButton key={p.key} point={p} onInsert={props.onInsert} />
                ))}
                {props.onAddPath
                  ? layout.addPaths.map((a) => (
                      <button
                        key={`add-${a.ifId}`}
                        type="button"
                        data-flow-hit
                        data-testid={`flow-add-path-${a.ifId}`}
                        className="flow-add-path"
                        style={{ left: a.x, top: a.y }}
                        onClick={() => props.onAddPath?.(a.ifId)}
                      >
                        + Add a path
                      </button>
                    ))
                  : null}
                {layout.tail ? <TailButton tail={layout.tail} onInsert={props.onInsert} /> : null}
              </>
            )}
          </div>
          {tipBox ? (
            <Tip
              key={tipBox.id}
              box={tipBox}
              ends={ends}
              status={statuses.get(tipBox.id)}
              label={label}
              readOnly={readOnly}
              zoom={zoom}
              viewport={viewport}
            />
          ) : null}
        </div>
      </div>

      <div className="flow-zoom" data-testid="flow-zoom">
        <button
          type="button"
          aria-label="Zoom out"
          data-testid="flow-zoom-out"
          onClick={() => zoomTo(zoom - ZOOM_STEP)}
          disabled={zoom <= ZOOM_MIN}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Back to 100%"
          data-testid="flow-zoom-level"
          onClick={() => zoomTo(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          data-testid="flow-zoom-in"
          onClick={() => zoomTo(zoom + ZOOM_STEP)}
          disabled={zoom >= ZOOM_MAX}
        >
          +
        </button>
        <i aria-hidden />
        <button type="button" data-testid="flow-zoom-fit" onClick={fit}>
          Fit
        </button>
        <span className="flow-zoom__hint">Drag the background to move</span>
      </div>
    </div>
  );
}

/** Scrolls the chart to its top, centred sideways. */
function centre(v: HTMLDivElement) {
  v.scrollLeft = Math.max(0, (v.scrollWidth - v.clientWidth) / 2);
  v.scrollTop = 0;
}

function boxStyle(b: FlowBox) {
  return { left: b.x, top: b.y, width: b.w, height: b.h };
}

/** A step's box: draggable (its id "flow-box:<id>"), a drop target, and its marks. */
function StepBox(p: {
  box: FlowBox;
  status: StepStatus | undefined;
  selected: boolean;
  tried: boolean;
  readOnly: boolean;
  zoom: number;
  label: Labeller;
  props: ChartProps;
  onHover(id: string | null): void;
}) {
  const { box, status, selected, readOnly, zoom } = p;
  const step = box.step as Step;
  const words = p.label(step);
  const dragData = useMemo<FlowDragData>(
    () => ({
      type: "flow-step",
      stepId: step.id,
      container: box.container ?? "root",
      index: box.index,
      inside: [...containersWithin(step)],
    }),
    [step, box.container, box.index],
  );
  const dropData = useMemo<FlowDropData>(
    () => ({
      type: "flow-box",
      stepId: step.id,
      kind: step.kind,
      container: box.container ?? "root",
      index: box.index,
    }),
    [step.id, step.kind, box.container, box.index],
  );
  const drag = useDraggable({ id: boxDragId(step.id), data: dragData, disabled: readOnly });
  const drop = useDroppable({ id: boxDragId(step.id), data: dropData, disabled: readOnly });
  const setRef = (el: HTMLDivElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };

  const issues = status?.items.filter((i) => i.level === "issue").length ?? 0;
  const questions = status?.items.filter((i) => i.level === "question").length ?? 0;
  const mark = status?.tried;
  const flag: { word: string; tone: Tone } | null = box.unreachable
    ? { word: "Never runs", tone: "risk" }
    : issues > 0 || status?.level === "issue"
      ? { word: plural(Math.max(issues, 1), "issue"), tone: "risk" }
      : questions > 0 || status?.level === "question"
        ? { word: plural(Math.max(questions, 1), "question"), tone: "warning" }
        : null;
  const tryWord = mark && mark.status !== "skipped" ? TRY_WORD[mark.status] : null;
  const kind = step.kind;
  const canDot = !readOnly && !box.unreachable && kind !== "if" && kind !== "stop";

  const t = drag.transform;
  const style = {
    ...boxStyle(box),
    transform: t ? `translate3d(${t.x / zoom}px, ${t.y / zoom}px, 0)` : undefined,
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || (readOnly && e.key === " ")) {
      e.preventDefault();
      p.props.onSelect(step.id);
      return;
    }
    drag.listeners?.onKeyDown?.(e);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: the box holds its own buttons (fold, open, the dot), which a <button> can't.
    <div
      ref={setRef}
      {...drag.attributes}
      {...drag.listeners}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${box.number ? `${box.number} ` : ""}${words.title}: ${words.kind}`}
      data-flow-hit
      data-testid={`flow-box-${step.id}`}
      data-number={box.number}
      data-container={box.container ?? undefined}
      className={cx(
        "flow-box",
        `flow-box--${kind}`,
        box.shape === "pill" && "flow-box--pill",
        box.shape === "diamond" && "flow-box--diamond",
        box.fold && "has-fold",
        issues > 0 || status?.level === "issue" ? "has-issue" : null,
        selected && "is-sel",
        box.unreachable && "is-dead",
        p.tried && !box.unreachable && (!mark || mark.status === "skipped") && "is-off",
        drag.isDragging && "is-lifted",
        drop.isOver && !drag.isDragging && "is-over",
      )}
      style={style}
      onClick={() => p.props.onSelect(step.id)}
      onMouseEnter={() => p.onHover(step.id)}
      onMouseLeave={() => p.onHover(null)}
    >
      {box.shape === "pill" ? (
        <span className="flow-box__t">Stop</span>
      ) : box.shape === "diamond" ? (
        <span className="flow-box__t">{words.title}</span>
      ) : (
        <>
          <span className="flow-box__t">
            {box.number ? <span className="flow-box__n">{box.number}</span> : null}
            {words.title}
          </span>
          <span className="flow-box__s">
            <b>{words.kind}</b>
            {words.detail ?? ""}
          </span>
        </>
      )}
      {box.fold ? (
        <button
          type="button"
          className="flow-fold"
          data-testid={`flow-fold-${step.id}`}
          aria-label={
            box.fold === "open"
              ? "Fold it to one box"
              : `Show the ${plural(box.inside ?? 0, "step")} inside`
          }
          title={
            box.fold === "open"
              ? "Fold it to one box"
              : `Show the ${plural(box.inside ?? 0, "step")} inside`
          }
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            p.props.onFold(step.id, box.fold === "open");
          }}
        >
          {box.fold === "folded" ? box.inside : null}
          <Icon name={box.fold === "open" ? "chevron-down" : "chevron-right"} size={14} />
        </button>
      ) : null}
      {(kind === "process" || kind === "for_each" || kind === "repeat") && p.props.onOpenGroup ? (
        <button
          type="button"
          // F6: a loop has its fold too, so its open button sits beside it.
          className={cx("flow-fold", box.fold && "flow-fold--beside")}
          data-testid={`flow-open-${step.id}`}
          aria-label="Open its steps"
          title="Open its steps"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            p.props.onOpenGroup?.(step.id);
          }}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      ) : null}
      {status?.tag ? (
        <span
          className={cx(pillClass(status.tag.tone ?? "neutral"), "flow-tag")}
          data-testid={`flow-tag-${step.id}`}
        >
          {status.tag.word}
        </span>
      ) : status?.customized ? (
        <span
          className={cx(pillClass("neutral"), "flow-tag")}
          data-testid={`flow-customized-${step.id}`}
        >
          {status.customized === "added" ? "Added" : "Customized"}
        </span>
      ) : null}
      {flag ? (
        <span
          className={cx(pillClass(flag.tone), "flow-flag")}
          data-testid={`flow-flag-${step.id}`}
        >
          {flag.word}
        </span>
      ) : null}
      {tryWord ? (
        <span
          className={cx(pillClass(tryWord.tone), "flow-mark")}
          data-testid={`flow-tried-${step.id}`}
        >
          {tryWord.word}
        </span>
      ) : null}
      {canDot ? <Dot stepId={step.id} /> : null}
    </div>
  );
}

/** The dot under a box: drag it onto the step that should come next. */
function Dot({ stepId }: { stepId: string }) {
  const data = useMemo<FlowDragData>(() => ({ type: "flow-dot", stepId }), [stepId]);
  const d = useDraggable({ id: dotDragId(stepId), data });
  return (
    <button
      type="button"
      ref={d.setNodeRef}
      {...d.attributes}
      {...d.listeners}
      aria-label="Drag onto the step that should come next"
      className={cx("flow-dot", d.isDragging && "is-lifted")}
      data-testid={`flow-dot-${stepId}`}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** The start ("Starts when", "Takes in") or the end ("Gives back"). */
function EndBox(p: {
  box: FlowBox;
  ends: FlowEnds;
  selected: boolean;
  readOnly: boolean;
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
}) {
  const { box } = p;
  const end = box.role === "start" ? p.ends.start : p.ends.givesBack;
  const data = useMemo<FlowDropData>(() => ({ type: "flow-start" }), []);
  const drop = useDroppable({
    id: START_DROP_ID,
    data,
    disabled: p.readOnly || box.role !== "start",
  });
  const lines = end?.lines ?? [];
  const first = lines[0] ?? "";
  const more = lines.length > 1 ? ` and ${lines.length - 1} more` : "";
  return (
    <button
      type="button"
      ref={box.role === "start" ? drop.setNodeRef : undefined}
      aria-pressed={p.selected}
      aria-label={`${end?.title ?? ""}: ${first}${more}`}
      data-flow-hit
      data-testid={box.role === "start" ? "flow-start" : "flow-gives-back"}
      className={cx(
        "flow-box",
        "flow-box--end",
        p.selected && "is-sel",
        box.unreachable && "is-dead",
        drop.isOver && "is-over",
      )}
      style={boxStyle(box)}
      onClick={() => p.onSelect(box.id)}
      onMouseEnter={() => p.onHover(box.id)}
      onMouseLeave={() => p.onHover(null)}
    >
      <span className="flow-box__t">
        {first || end?.title}
        {more}
      </span>
      <span className="flow-box__s">
        <b>{end?.title}</b>
      </span>
    </button>
  );
}

/** A + on an arrow: press it to add a step there, or drop a box or a rail item on it. */
function InsertButton({
  point,
  onInsert,
}: {
  point: FlowInsert;
  onInsert(at: InsertPoint, item?: unknown): void;
}) {
  const at = useMemo<InsertPoint>(
    () => ({ container: point.container, index: point.index }),
    [point.container, point.index],
  );
  const data = useMemo<FlowDropData>(() => ({ type: "flow-insert", at }), [at]);
  const drop = useDroppable({ id: insertDropId(at), data });
  return (
    <button
      ref={drop.setNodeRef}
      type="button"
      data-flow-hit
      data-testid={`flow-insert-${point.container}-${point.index}`}
      aria-label="Add a step here"
      className={cx("flow-plus", drop.isOver && "is-over")}
      style={{ left: point.x, top: point.y }}
      onClick={() => onInsert(at)}
    >
      <Icon name="add" size={14} />
    </button>
  );
}

/** "+ Add a step" under the last step. */
function TailButton({
  tail,
  onInsert,
}: {
  tail: FlowTail;
  onInsert(at: InsertPoint, item?: unknown): void;
}) {
  const at = useMemo<InsertPoint>(
    () => ({ container: tail.container, index: tail.index }),
    [tail.container, tail.index],
  );
  const data = useMemo<FlowDropData>(() => ({ type: "flow-insert", at }), [at]);
  const drop = useDroppable({ id: insertDropId(at), data });
  return (
    <button
      ref={drop.setNodeRef}
      type="button"
      data-flow-hit
      data-testid="flow-tail"
      className={cx("flow-tail", drop.isOver && "is-over")}
      style={{ left: tail.x, top: tail.y, width: tail.w, height: tail.h }}
      onClick={() => onInsert(at)}
    >
      + Add a step
    </button>
  );
}

/**
 * A box's details on hover: what it is, whether a model does it and which, what is left to settle,
 * what was decided, what a try did. Drawn on the stage at the box's zoomed place and its own size
 * (tipScale): right of the box, or left of it when only that side has the room, and moved up when
 * it would run under the chart's bottom edge.
 */
function Tip(p: {
  box: FlowBox;
  ends: FlowEnds;
  status: StepStatus | undefined;
  label: Labeller;
  readOnly: boolean;
  zoom: number;
  viewport: RefObject<HTMLDivElement | null>;
}) {
  const { box, status, zoom, viewport } = p;
  const scale = tipScale(zoom);
  const el = useRef<HTMLDivElement | null>(null);
  const right = (box.x + box.w) * zoom + TIP_GAP;
  const top = box.y * zoom;
  const [place, setPlace] = useState({ left: right, top });
  // Once it has a size: the side with the room, and inside the part of the chart in view.
  useLayoutEffect(() => {
    const tip = el.current;
    const v = viewport.current;
    const stage = tip?.parentElement;
    let next = { left: right, top };
    if (tip && v && stage && v.clientWidth > 0 && v.clientHeight > 0) {
      const vr = v.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      // The part of the stage in view, in the stage's own coordinates.
      const viewLeft = vr.left - sr.left;
      const viewTop = vr.top - sr.top;
      const w = tip.offsetWidth * scale;
      const h = tip.offsetHeight * scale;
      const left = box.x * zoom - TIP_GAP - w;
      const fitsRight = right + w <= viewLeft + v.clientWidth - TIP_EDGE;
      const fitsLeft = left >= viewLeft + TIP_EDGE;
      next = {
        left: !fitsRight && fitsLeft ? left : right,
        top: Math.max(viewTop + TIP_EDGE, Math.min(top, viewTop + v.clientHeight - TIP_FOOT - h)),
      };
    }
    setPlace((was) => (was.left === next.left && was.top === next.top ? was : next));
  }, [box.x, right, top, zoom, scale, viewport]);
  const style = {
    left: place.left,
    top: place.top,
    transform: scale === 1 ? undefined : `scale(${scale})`,
  };
  let body: ReactNode;
  if (box.step) {
    const words = p.label(box.step);
    const mark = status?.tried;
    const tryWord = mark && mark.status !== "skipped" ? TRY_WORD[mark.status] : null;
    const canDot = box.step.kind !== "if" && box.step.kind !== "stop";
    // A line of its own for the model: "AI" or "Deterministic", then the model it runs on. What
    // that line says is left out of the eyebrow and the detail, which said it among other things.
    const how = words.skillKind ?? null;
    const runs = words.model ? `runs on ${words.model}` : null;
    const kind =
      how && words.kind.endsWith(` · ${how}`)
        ? words.kind.slice(0, -` · ${how}`.length)
        : words.kind;
    const detail =
      runs && words.detail
        ? words.detail
            .split(" · ")
            .filter((part) => part !== runs)
            .join(" · ") || null
        : words.detail;
    body = (
      <>
        <span className="ds-eyebrow">{kind}</span>
        <span className="flow-tip__h">{words.title}</span>
        {how || runs ? (
          <div className="flow-tip__runs" data-testid="flow-tip-runs">
            {how ? <span className={pillClass("neutral")}>{how}</span> : null}
            {runs ? <span>{how ? runs : `R${runs.slice(1)}`}</span> : null}
          </div>
        ) : null}
        {detail ? <span className="flow-tip__d">{detail}</span> : null}
        {box.unreachable ? (
          <div>
            <span className={pillClass("risk")}>Never runs</span> Every path above it ends first.
          </div>
        ) : null}
        {status?.items.map((item) => (
          <div key={item.key}>
            <span className={pillClass(item.level === "issue" ? "risk" : "warning")}>
              {item.level === "issue" ? "Issue" : "Question"}
            </span>{" "}
            {item.title}
            {item.detail ? <span className="flow-tip__d"> {item.detail}</span> : null}
          </div>
        ))}
        {status?.decided.slice(0, 2).map((d) => (
          <div key={d.key}>
            <span className="flow-tip__d">Decided for you:</span> {d.what}
          </div>
        ))}
        {tryWord ? (
          <div>
            <span className={pillClass(tryWord.tone)}>{tryWord.word}</span> {mark?.summary ?? ""}
          </div>
        ) : null}
        <div className="flow-tip__f">
          {p.readOnly
            ? "Click to see it."
            : `Click to set it up. Drag the box to move it.${canDot ? " Drag the dot under it onto another step to make that step come next." : ""}`}
        </div>
      </>
    );
  } else {
    const end = box.role === "start" ? p.ends.start : p.ends.givesBack;
    body = (
      <>
        <span className="ds-eyebrow">{end?.title}</span>
        {end?.lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
        <div className="flow-tip__f">{p.readOnly ? "Click to see it." : "Click to set it up."}</div>
      </>
    );
  }
  return (
    <div
      ref={el}
      className="flow-tip"
      role="tooltip"
      data-testid="flow-tip"
      data-scale={scale}
      style={style}
    >
      {body}
    </div>
  );
}
