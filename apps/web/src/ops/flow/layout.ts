// The chart's layout (docs/builder-plan.md §12, docs/plan.md §1.170; design: docs/design/builder.html,
// its layout()): where each box, arrow, + and frame of a process goes, worked out from the nested
// steps every time they are drawn and never stored, so merges and ids are untouched.
//
// The shape: what starts the flow at the top, the steps running down. An `if` is a diamond whose
// paths spread sideways as columns (its paths in order, Otherwise last); an `if` on a path splits
// that column again. A path whose last step is Stop ends there (a Stop pill, no line onward); the
// other paths come back together at the step after the decision. A For each or Repeat is a frame
// around its steps with an arrow back to the top, or one box when folded. An automation (a
// `process` step) is one box. What the flow gives back, when it gives anything, is a box at the end.
//
// Pure: no React and no measuring, so it holds in tests (jsdom has no layout) and on first paint.
// Containers are `../builder/model`'s (`root`, `path:<id>`, `otherwise:<id>`, `loop:<id>`), so an
// insert point is what `insertStep` and `moveStep` take.
// DECISION: the sizes are the mock-up's (boxes 212x54, a diamond 168x84, Stop 108x30), fixed rather
// than fitted to each step's words: titles that run long are cut with an ellipsis and read in full
// on hover and in the side panel.

import { type ContainerId, ROOT, type Step } from "../builder/model";
import type { FlowEnds, InsertPoint, Process } from "./types";

/** The start box's id: what starts the flow ("Starts when", "Takes in"). */
export const FLOW_START_ID = "flow:start";
/** The end box's id: what the flow gives back. */
export const FLOW_GIVES_BACK_ID = "flow:gives-back";

// DECISION (owner, 2026-11-21, "let's go with D2"; docs/plan.md §1.178): a box is 248 by 76. Its
// kind is a badge on its top-left corner, and the model and tools sit at its right, so the name
// has two lines in the room that is left. It was 236 by 54 with the name on one line.
export const BOX_W = 248;
export const BOX_H = 76;
export const DIAMOND_W = 168;
export const DIAMOND_H = 84;
export const STOP_W = 108;
export const STOP_H = 30;
/** Between columns of a decision. */
const GAP_X = 32;
/** Between one step and the next. */
const GAP_Y = 38;
/** From a decision's bottom to the top of its paths (room for the path labels). */
const BRANCH_GAP = 58;
/** Under the paths, where those that carry on come back together. */
const JOIN_GAP = 30;
/** How far the bar of a decision's paths sits below the diamond. */
const BAR_DROP = 14;
/** A loop frame's sides, top (above its own box) and foot (the arrow back and the frame's words). */
const FRAME_SIDE = 28;
const FRAME_TOP = 10;
const FRAME_FOOT = 44;
/** The height an empty path or loop keeps, so its + has room. */
const EMPTY_H = 28;
/** The tail ("+ Add a step") under the last step. */
const TAIL_H = 36;
/** "+ Add a path": its offset from the decision's widest point and its size, for the bounds. */
const ADD_PATH_GAP = 12;
const ADD_PATH_W = 96;
const ADD_PATH_H = 22;
/** A path label's height and widest. */
const LABEL_H = 19;
const LABEL_MAX = 240;
/** Room around the whole chart. */
const PAD = 16;

export type BoxShape = "box" | "diamond" | "pill";

/** One box on the chart: a step, or the start or end. x, y is its top-left corner. */
export interface FlowBox {
  /** The step's own id, or FLOW_START_ID / FLOW_GIVES_BACK_ID. */
  id: string;
  role: "start" | "step" | "gives_back";
  step: Step | null;
  kind: Step["kind"] | null;
  /** The list the step is in and its place there (null and -1 for the start and end). */
  container: ContainerId | null;
  index: number;
  /** "5", "5 A1" (step 1 of path A of decision 5), "6.2" (step 2 inside loop 6); "" for the ends. */
  number: string;
  shape: BoxShape;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A loop's: shown open (its frame) or folded to this one box. */
  fold?: "open" | "folded";
  /** How many steps a loop holds directly. */
  inside?: number;
  /** Below a point where every path ended: it never runs. */
  unreachable: boolean;
}

/** A path's label on the arrow into it: its letter and name, or Otherwise. x is its centre. */
export interface FlowEdgeLabel {
  text: string;
  letter: string;
  otherwise: boolean;
  ifId: string;
  pathId: string;
  x: number;
  y: number;
  maxWidth: number;
}

/** An arrow: an orthogonal polyline, its points in order. */
export interface FlowEdge {
  id: string;
  points: [number, number][];
  /** An arrowhead at its last point. */
  arrow: boolean;
  /** The box it leaves (a step id, FLOW_START_ID) and the box it leads to (null: the end). */
  from: string | null;
  to: string | null;
  label?: FlowEdgeLabel;
  /** A loop's arrow back to its top. */
  loopBack?: boolean;
  /** The dashed line out to "+ Add a path". */
  dashed?: boolean;
}

/** A + on an arrow. x, y is its centre. */
export interface FlowInsert extends InsertPoint {
  key: string;
  x: number;
  y: number;
}

/** The "+ Add a step" under the flow's last step. x, y is its top-left corner. */
export interface FlowTail extends InsertPoint {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The frame around a loop's steps. */
export interface FlowFrame {
  stepId: string;
  kind: "for_each" | "repeat";
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  unreachable: boolean;
}

/** "+ Add a path" beside a decision. x, y is its top-left corner. */
export interface FlowAddPath {
  ifId: string;
  x: number;
  y: number;
}

export interface FlowLayout {
  boxes: FlowBox[];
  edges: FlowEdge[];
  inserts: FlowInsert[];
  frames: FlowFrame[];
  addPaths: FlowAddPath[];
  tail: FlowTail | null;
  width: number;
  height: number;
}

export interface LayoutOptions {
  ends: FlowEnds;
  /** Loops folded to one box. */
  folded?: ReadonlySet<string>;
}

/** A path's letter: A, B, … Z, then AA, AB. */
export function pathLetter(index: number): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return index < letters.length
    ? (letters[index] as string)
    : `${pathLetter(Math.floor(index / letters.length) - 1)}${letters[index % letters.length]}`;
}

export function insertKey(at: InsertPoint): string {
  return `${at.container}#${at.index}`;
}

interface Column {
  id: ContainerId;
  pathId: string;
  letter: string;
  text: string;
  otherwise: boolean;
  steps: Step[];
}

/** A decision's columns: its paths in order, then Otherwise, each with its letter. */
function columns(step: Extract<Step, { kind: "if" }>): Column[] {
  const paths = step.paths.map((p, i) => ({
    id: `path:${p.id}`,
    pathId: p.id,
    letter: pathLetter(i),
    text: p.name.trim() || `Path ${pathLetter(i)}`,
    otherwise: false,
    steps: p.steps,
  }));
  return [
    ...paths,
    {
      id: `otherwise:${step.otherwise.id}`,
      pathId: step.otherwise.id,
      letter: pathLetter(step.paths.length),
      text: "Otherwise",
      otherwise: true,
      steps: step.otherwise.steps,
    },
  ];
}

/** Whether nothing goes on after this list: its last step is Stop, or a decision all of whose paths end. */
function listEnds(steps: readonly Step[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  if (last.kind === "stop") return true;
  if (last.kind === "if") return columns(last).every((c) => listEnds(c.steps));
  return false;
}

interface Size {
  w: number;
  h: number;
}

/** Where the flow leaves from: a point, the box it comes from, and the arrows still to be given an end. */
interface Exit {
  x: number;
  y: number;
  from: string | null;
  pending: FlowEdge[];
}

/**
 * Lays out a process's steps. Every step, path and loop keeps its own id; insert points name the
 * container and index a new step would take there.
 */
export function layoutFlow(process: Pick<Process, "steps">, options: LayoutOptions): FlowLayout {
  const folded = options.folded ?? new Set<string>();
  const boxes: FlowBox[] = [];
  const edges: FlowEdge[] = [];
  const inserts: FlowInsert[] = [];
  const frames: FlowFrame[] = [];
  const addPaths: FlowAddPath[] = [];
  let tail: FlowTail | null = null;
  let edgeN = 0;

  const isLoop = (s: Step): s is Extract<Step, { kind: "for_each" | "repeat" }> =>
    s.kind === "for_each" || s.kind === "repeat";

  const sizes = new Map<string, Size & { cols?: Size[]; inner?: number }>();
  function size(step: Step): Size & { cols?: Size[]; inner?: number } {
    const known = sizes.get(step.id);
    if (known) return known;
    let out: Size & { cols?: Size[]; inner?: number };
    if (step.kind === "if") {
      const cols = columns(step).map((c) => measure(c.steps));
      const inner = Math.max(EMPTY_H, ...cols.map((c) => c.h));
      const wide = cols.reduce((a, c) => a + c.w, 0) + GAP_X * (cols.length - 1);
      const ends = columns(step).every((c) => listEnds(c.steps));
      out = {
        w: Math.max(BOX_W, wide),
        h: DIAMOND_H + BRANCH_GAP + inner + (ends ? 0 : JOIN_GAP),
        cols,
        inner,
      };
    } else if (isLoop(step) && !folded.has(step.id)) {
      const m = measure(step.steps);
      out = {
        w: Math.max(BOX_W, m.w) + 2 * FRAME_SIDE,
        h: FRAME_TOP + BOX_H + GAP_Y + Math.max(m.h, EMPTY_H) + FRAME_FOOT,
      };
    } else if (step.kind === "stop") {
      out = { w: STOP_W, h: STOP_H };
    } else {
      out = { w: BOX_W, h: BOX_H };
    }
    sizes.set(step.id, out);
    return out;
  }

  function measure(list: readonly Step[]): Size {
    let w = BOX_W;
    let h = 0;
    list.forEach((s, i) => {
      const m = size(s);
      w = Math.max(w, m.w);
      h += m.h + (i ? GAP_Y : 0);
    });
    return { w, h };
  }

  function edge(e: Omit<FlowEdge, "id">): FlowEdge {
    edgeN += 1;
    const out = { id: `e${edgeN}`, ...e };
    edges.push(out);
    return out;
  }

  /**
   * Lays a list out down from (cx, y), the flow coming in from `at` (null: nothing reaches it).
   * `first`: the arrow into the list's first step is already drawn (a decision's path). Returns
   * where the flow leaves the list, or null when it ends there.
   */
  function seq(
    list: readonly Step[],
    container: ContainerId,
    cx: number,
    top: number,
    at: Exit | null,
    numberFor: (i: number) => string,
    first: boolean,
  ): Exit | null {
    let y = top;
    list.forEach((st, i) => {
      const m = size(st);
      const live = at !== null;
      const number = numberFor(i);
      if (at) {
        for (const e of at.pending) e.to = st.id;
        if (!(first && i === 0)) {
          edge({
            points: [
              [at.x, at.y],
              [cx, y],
            ],
            arrow: true,
            from: at.from,
            to: st.id,
          });
        }
        const pointY = first && i === 0 ? y - 12 : (at.y + y) / 2;
        inserts.push({ container, index: i, key: `${container}#${i}`, x: cx, y: pointY });
      }
      const base = {
        id: st.id,
        role: "step" as const,
        step: st,
        kind: st.kind,
        container,
        index: i,
        number,
        unreachable: !live,
      };

      if (st.kind === "if") {
        boxes.push({
          ...base,
          shape: "diamond",
          x: cx - DIAMOND_W / 2,
          y,
          w: DIAMOND_W,
          h: DIAMOND_H,
        });
        const cols = columns(st);
        const colSizes = m.cols as Size[];
        const inner = m.inner as number;
        const wide = colSizes.reduce((a, c) => a + c.w, 0) + GAP_X * (cols.length - 1);
        const barY = y + DIAMOND_H + BAR_DROP;
        const pathTop = y + DIAMOND_H + BRANCH_GAP;
        const joinY = pathTop + inner + JOIN_GAP / 2;
        const exits: FlowEdge[] = [];
        let px = cx - wide / 2;
        let lastCx = cx;
        cols.forEach((col, ci) => {
          const pw = (colSizes[ci] as Size).w;
          const pcx = px + pw / 2;
          lastCx = pcx;
          px += pw + GAP_X;
          let into: FlowEdge | null = null;
          if (live) {
            into = edge({
              points: [
                [cx, y + DIAMOND_H],
                [cx, barY],
                [pcx, barY],
                [pcx, pathTop],
              ],
              arrow: col.steps.length > 0,
              from: st.id,
              to: null,
              label: {
                text: col.text,
                letter: col.letter,
                otherwise: col.otherwise,
                ifId: st.id,
                pathId: col.pathId,
                x: pcx,
                y: barY + 7,
                maxWidth: Math.min(pw, LABEL_MAX),
              },
            });
          }
          const ex = seq(
            col.steps,
            col.id,
            pcx,
            pathTop,
            live ? { x: pcx, y: pathTop, from: st.id, pending: into ? [into] : [] } : null,
            (xi) => `${number} ${col.letter}${xi + 1}`,
            true,
          );
          if (live && col.steps.length === 0) {
            inserts.push({
              container: col.id,
              index: 0,
              key: `${col.id}#0`,
              x: pcx,
              y: pathTop - 12,
            });
          }
          if (ex) {
            if (col.steps.length > 0) {
              const index = col.steps.length;
              inserts.push({
                container: col.id,
                index,
                key: `${col.id}#${index}`,
                x: ex.x,
                y: ex.y + 13,
              });
            }
            const join = edge({
              points: [
                [ex.x, ex.y],
                [ex.x, joinY],
                [cx, joinY],
              ],
              arrow: false,
              from: ex.from,
              to: null,
            });
            exits.push(...ex.pending, join);
          }
        });
        if (live) {
          const ax = cx + Math.max(wide, BOX_W) / 2 + ADD_PATH_GAP;
          edge({
            points: [
              [lastCx, barY],
              [ax, barY],
            ],
            arrow: false,
            from: null,
            to: null,
            dashed: true,
          });
          addPaths.push({ ifId: st.id, x: ax, y: barY - ADD_PATH_H / 2 });
        }
        at = exits.length > 0 ? { x: cx, y: joinY, from: st.id, pending: exits } : null;
      } else if (isLoop(st) && !folded.has(st.id)) {
        const fx = cx - m.w / 2;
        const hy = y + FRAME_TOP;
        const innerTop = hy + BOX_H + GAP_Y;
        const container2 = `loop:${st.id}`;
        frames.push({
          stepId: st.id,
          kind: st.kind,
          x: fx,
          y,
          w: m.w,
          h: m.h,
          text:
            st.kind === "for_each"
              ? "Once for each item"
              : `Again until done · up to ${st.maxTimes} ${st.maxTimes === 1 ? "time" : "times"}`,
          unreachable: !live,
        });
        boxes.push({
          ...base,
          shape: "box",
          x: cx - BOX_W / 2,
          y: hy,
          w: BOX_W,
          h: BOX_H,
          fold: "open",
          inside: st.steps.length,
        });
        const ex = seq(
          st.steps,
          container2,
          cx,
          innerTop,
          live ? { x: cx, y: hy + BOX_H, from: st.id, pending: [] } : null,
          (xi) => `${number}.${xi + 1}`,
          false,
        );
        if (live) {
          const index = st.steps.length;
          if (index > 0 && ex) {
            inserts.push({
              container: container2,
              index,
              key: `${container2}#${index}`,
              x: ex.x,
              y: ex.y + 11,
            });
          } else if (index === 0) {
            inserts.push({
              container: container2,
              index: 0,
              key: `${container2}#0`,
              x: cx,
              y: innerTop + 8,
            });
          }
        }
        if (live && ex && st.steps.length > 0) {
          edge({
            points: [
              [ex.x, ex.y],
              [ex.x, ex.y + 24],
              [fx + 13, ex.y + 24],
              [fx + 13, hy + BOX_H / 2],
              [cx - BOX_W / 2, hy + BOX_H / 2],
            ],
            arrow: true,
            from: ex.from,
            to: st.id,
            loopBack: true,
          });
          for (const e of ex.pending) e.to = st.id;
        }
        at = live ? { x: cx, y: y + m.h, from: st.id, pending: [] } : null;
      } else if (isLoop(st)) {
        boxes.push({
          ...base,
          shape: "box",
          x: cx - BOX_W / 2,
          y,
          w: BOX_W,
          h: BOX_H,
          fold: "folded",
          inside: st.steps.length,
        });
        at = live ? { x: cx, y: y + BOX_H, from: st.id, pending: [] } : null;
      } else if (st.kind === "stop") {
        boxes.push({ ...base, shape: "pill", x: cx - STOP_W / 2, y, w: STOP_W, h: STOP_H });
        at = null;
      } else {
        boxes.push({ ...base, shape: "box", x: cx - BOX_W / 2, y, w: BOX_W, h: BOX_H });
        at = live ? { x: cx, y: y + BOX_H, from: st.id, pending: [] } : null;
      }
      y += m.h + GAP_Y;
    });
    return at;
  }

  // The start, then the steps from the top.
  let start: Exit;
  let firstDrawn = false;
  if (options.ends.start) {
    boxes.push({
      id: FLOW_START_ID,
      role: "start",
      step: null,
      kind: null,
      container: null,
      index: -1,
      number: "",
      shape: "box",
      x: -BOX_W / 2,
      y: 0,
      w: BOX_W,
      h: BOX_H,
      unreachable: false,
    });
    start = { x: 0, y: BOX_H, from: FLOW_START_ID, pending: [] };
  } else {
    // Nothing drawn above: the first step sits at the top with its + just over it.
    start = { x: 0, y: -GAP_Y, from: null, pending: [] };
    firstDrawn = true;
  }
  const top = options.ends.start ? BOX_H + GAP_Y : 0;
  const steps = process.steps;
  const ex = seq(steps, ROOT, 0, top, start, (i) => String(i + 1), firstDrawn);
  const below = top + measure(steps).h;
  if (ex && steps.length === 0 && firstDrawn) {
    // An empty flow with nothing above: just the place to add the first step, at the top.
    ex.y = 0;
  }
  if (options.ends.givesBack) {
    const y = ex ? ex.y + GAP_Y : below + GAP_Y;
    if (ex) {
      for (const e of ex.pending) e.to = FLOW_GIVES_BACK_ID;
      edge({
        points: [
          [ex.x, ex.y],
          [ex.x, y],
        ],
        arrow: true,
        from: ex.from,
        to: FLOW_GIVES_BACK_ID,
      });
      const index = steps.length;
      inserts.push({ container: ROOT, index, key: `${ROOT}#${index}`, x: ex.x, y: (ex.y + y) / 2 });
    }
    boxes.push({
      id: FLOW_GIVES_BACK_ID,
      role: "gives_back",
      step: null,
      kind: null,
      container: null,
      index: -1,
      number: "",
      shape: "box",
      x: -BOX_W / 2,
      y,
      w: BOX_W,
      h: BOX_H,
      unreachable: !ex,
    });
  } else if (ex) {
    const y = ex.y + GAP_Y - 6;
    if (boxes.length > 0) {
      edge({
        points: [
          [ex.x, ex.y],
          [ex.x, y],
        ],
        arrow: false,
        from: ex.from,
        to: null,
      });
    }
    const index = steps.length;
    tail = {
      container: ROOT,
      index,
      key: `${ROOT}#${index}`,
      x: ex.x - BOX_W / 2,
      y: boxes.length > 0 ? y : 0,
      w: BOX_W,
      h: TAIL_H,
    };
  }

  // The bounds, then everything moved so the chart starts at (PAD, PAD).
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const grow = (x: number, y: number, w: number, h: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  };
  for (const b of boxes) grow(b.x, b.y, b.w, b.h);
  for (const f of frames) grow(f.x, f.y, f.w, f.h);
  for (const a of addPaths) grow(a.x, a.y, ADD_PATH_W, ADD_PATH_H);
  for (const p of inserts) grow(p.x - 12, p.y - 12, 24, 24);
  for (const e of edges) {
    for (const [x, y] of e.points) grow(x, y, 0, 0);
    if (e.label) grow(e.label.x - e.label.maxWidth / 2, e.label.y, e.label.maxWidth, LABEL_H);
  }
  if (tail) grow(tail.x, tail.y, tail.w, tail.h);
  if (!Number.isFinite(x0)) {
    x0 = 0;
    y0 = 0;
    x1 = 0;
    y1 = 0;
  }
  const dx = PAD - x0;
  const dy = PAD - y0;
  const mx = (x: number) => Math.round(x + dx);
  const my = (y: number) => Math.round(y + dy);
  for (const b of boxes) {
    b.x = mx(b.x);
    b.y = my(b.y);
  }
  for (const f of frames) {
    f.x = mx(f.x);
    f.y = my(f.y);
  }
  for (const a of addPaths) {
    a.x = mx(a.x);
    a.y = my(a.y);
  }
  for (const p of inserts) {
    p.x = mx(p.x);
    p.y = my(p.y);
  }
  for (const e of edges) {
    e.points = e.points.map(([x, y]) => [mx(x), my(y)]);
    if (e.label) {
      e.label.x = mx(e.label.x);
      e.label.y = my(e.label.y);
    }
  }
  if (tail) {
    tail.x = mx(tail.x);
    tail.y = my(tail.y);
  }
  return {
    boxes,
    edges,
    inserts,
    frames,
    addPaths,
    tail,
    width: Math.round(x1 - x0 + 2 * PAD),
    height: Math.round(y1 - y0 + 2 * PAD),
  };
}
