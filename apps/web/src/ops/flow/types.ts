// The builder on one screen (docs/builder-plan.md §12, docs/plan.md §1.170; design:
// docs/design/builder.html on PR #498). This file is the contract between its parts, built side by
// side: the chart (F1), the side panel, rail, bar and list (F2), issues and the try on the chart
// (F3), Turn on (F4) and a new build's Describe and Check the steps (F5). Each part may add optional
// fields; none renames or removes one without changing every user.
//
// The steps are today's process steps (`packages/core` processes, `../builder/model`): nothing here
// adds a step kind. Positions are worked out from the nested steps and never stored.
import type { ContainerId, Process, Step } from "../builder/model";

export type { ContainerId, Process, Step };

/** What the frame holds: an agent's workflow, an automation's steps, or a loop's own steps. */
export type FlowSubject =
  | { kind: "agent"; agentKind: "template" | "client"; workflow: string }
  | { kind: "automation"; automationId: string }
  | { kind: "loop"; stepId: string };

/** What the frame starts with and ends with, in words: "Starts when", "Takes in", "Gives back". */
export interface FlowEnds {
  /** Shown above the first step: the triggers for an agent; the input fields for an automation. */
  start: { title: string; lines: string[] } | null;
  /** Shown under the last step: an automation's or a loop's output fields. Null for an agent. */
  givesBack: { title: string; lines: string[] } | null;
}

/** A place a new step can go: before `index` in the list `container` (`ROOT`, `path:<id>`, …). */
export interface InsertPoint {
  container: ContainerId;
  index: number;
}

/** Something on a step to settle: an issue (red) or a question (gold). */
export interface SettleItem {
  /** Stable: `problem:<code>:<stepId>:<field>`, `missing:<stepId>`, `item:<id>`, `decision:<id>`. */
  key: string;
  stepId: string;
  level: "issue" | "question";
  title: string;
  detail?: string;
  /** Where it came from: the validator, a missing step, a build item, a build decision. */
  source: "problem" | "missing" | "build_item" | "decision";
  /** The build item or decision id, when it is one, for settling it through the build's routes. */
  refId?: string;
}

/** A default the Builder chose that shapes this step ("Decided for you"), with Change. */
export interface DecidedNote {
  key: string;
  stepId: string;
  what: string;
  why?: string;
  decisionId?: string;
  risk?: "high" | "normal";
}

/** What one step did in a try (a test run: nothing is written). */
export interface TryMark {
  stepId: string;
  /** did: ran; would: a write it would have made; failed; skipped: not on the path taken; waiting: a person's turn. */
  status: "did" | "would" | "failed" | "skipped" | "waiting";
  summary?: string;
}

/** A step's status, as the chart, the list and the bar show it. */
export interface StepStatus {
  stepId: string;
  /** issue (red) wins over question (gold); ok when nothing is left. */
  level: "issue" | "question" | "ok";
  items: SettleItem[];
  decided: DecidedNote[];
  /** Against the template, for a client's agent: changed or added there. */
  customized?: "changed" | "added";
  /**
   * F8: words for the box's tag in place of Customized or Added, where the host marks something
   * else (the merge screen: "Changed", "Moved", "1 conflict").
   */
  tag?: { word: string; tone?: "neutral" | "positive" | "warning" | "risk" };
  tried?: TryMark;
}

/** Statuses by step id. A step with no entry is `ok`. */
export type StatusMap = ReadonlyMap<string, StepStatus>;

/** The chart's callbacks, all by step id; the host owns the process and applies every change. */
export interface ChartEvents {
  /** Click a box: open its side panel. Null clears the selection. */
  onSelect(stepId: string | null): void;
  /** Press + on an arrow (or drop a rail item on it): add a step there. */
  onInsert(at: InsertPoint, item?: unknown): void;
  /** Drag a box onto a + or another box: it comes after that place. */
  onMove(stepId: string, to: InsertPoint): void;
  /** Drag the dot under a step onto the box that should come next. */
  onConnect(fromStepId: string, toStepId: string): void;
  /** Add a path to a decision ("Add a path"). */
  onAddPath?(ifStepId: string): void;
  /** Open a loop's or an automation's own steps in the frame. */
  onOpenGroup?(stepId: string): void;
}

/** What the chart draws and how. */
export interface ChartProps extends ChartEvents {
  process: Process;
  ends: FlowEnds;
  statuses: StatusMap;
  selected: string | null;
  /** Step ids of loops and automations folded to one box. */
  folded: ReadonlySet<string>;
  onFold(stepId: string, folded: boolean): void;
  /** Step labels the host already knows (skill and tool names): as `../workflow/describe` takes. */
  label?(step: Step): {
    title: string;
    kind: string;
    detail: string | null;
    /** "AI" or "Deterministic", where the step is a skill or its tool calls a model inside. */
    skillKind?: string;
    /** The model the step runs on, in a word ("claude-sonnet-5-5"), when it runs one. */
    model?: string;
  };
  /** Read only: no +, no dragging (an older version, the merge screen). */
  readOnly?: boolean;
}
