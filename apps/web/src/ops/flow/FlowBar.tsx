// The one bar over the one-screen builder (docs/builder-plan.md §12.3: "the tabs and toolbar become
// one bar"): the name and its version, the steps in one line, what is left to settle (issues and
// questions, each pill opening the next one), Chart or List, Undo and Redo, the Builder, Try it,
// Save draft and the primary action the host passes (Turn on, or Publish). Props only.
import type { ReactNode } from "react";
import { Icon } from "../../ui/icons";
import { Badge, Button, cx } from "../../ui/primitives";
import type { WorkflowCounts } from "../builder/model";
import { plural } from "./status";

export type FlowView = "chart" | "list";

/** Draft · vN, Live · vN, In trial · vN, or Unsaved (changes not yet saved). */
export type FlowVersion =
  | { state: "draft" | "live" | "trial"; version: number }
  | { state: "unsaved"; version?: number | undefined };

export interface FlowBarProps {
  name: string;
  /** Makes the name an input. */
  onRename?: ((name: string) => void) | undefined;
  version: FlowVersion;
  /** `workflowCounts` from ../builder/model. */
  counts: WorkflowCounts;
  /** Steps with an issue, and steps with only questions (`counts` in ./status). */
  open: { issues: number; questions: number };
  /** Opens the next step with something open, issues first. */
  onNextOpen(): void;
  view: FlowView;
  onView(view: FlowView): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onAskBuilder?: (() => void) | undefined;
  onTry?: (() => void) | undefined;
  /** Try it is under way. */
  trying?: boolean | undefined;
  /** Why it can't be tried now (the button is off and says so on hover). */
  tryBlocked?: string | null | undefined;
  onSave?: (() => void) | undefined;
  saving?: boolean | undefined;
  /** Nothing to save. */
  saved?: boolean | undefined;
  /** Turn on, or Publish: the host's button. */
  primary?: ReactNode;
  /** Before the name: the client or the back-office crumb. */
  lead?: ReactNode;
  /** The host's own control before Ask the Builder (the step builder's Supervisor). */
  extra?: ReactNode;
}

/** "18 steps · 3 decisions · 3 write to a tool · 3 need approval". */
export function countsLine(c: WorkflowCounts): string {
  return [
    plural(c.steps, "step"),
    c.ifs ? plural(c.ifs, "decision") : null,
    c.writes ? `${c.writes} ${c.writes === 1 ? "writes" : "write"} to a tool` : null,
    c.needApproval ? `${c.needApproval} ${c.needApproval === 1 ? "needs" : "need"} approval` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function versionBadge(v: FlowVersion): { text: string; tone: "neutral" | "positive" | "warning" } {
  switch (v.state) {
    case "draft":
      return { text: `Draft · v${v.version}`, tone: "neutral" };
    case "live":
      return { text: `Live · v${v.version}`, tone: "positive" };
    case "trial":
      return { text: `In trial · v${v.version}`, tone: "positive" };
    case "unsaved":
      return { text: "Unsaved", tone: "warning" };
  }
}

export function FlowBar(props: FlowBarProps) {
  const badge = versionBadge(props.version);
  const { issues, questions } = props.open;
  return (
    <header
      data-testid="flow-bar"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2.5"
    >
      {props.lead}
      <div className="grid min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {props.onRename ? (
            <input
              aria-label="Name"
              data-testid="flow-bar-name"
              value={props.name}
              onChange={(e) => props.onRename?.(e.target.value)}
              className="min-w-0 rounded-sm border border-transparent bg-transparent px-1 text-base font-medium text-ink hover:border-line focus:border-line-strong focus:outline-none"
            />
          ) : (
            <span className="truncate text-base font-medium text-ink" data-testid="flow-bar-name">
              {props.name}
            </span>
          )}
          <Badge tone={badge.tone} testId="flow-bar-version">
            {badge.text}
          </Badge>
        </div>
        <span className="truncate px-1 text-xs text-ink-muted" data-testid="flow-bar-counts">
          {countsLine(props.counts)}
        </span>
      </div>
      {issues || questions ? (
        <button
          type="button"
          data-testid="flow-bar-open"
          title="Open the next step that needs you, issues first"
          onClick={props.onNextOpen}
          className="flex items-center gap-1.5 rounded-full"
        >
          {issues ? (
            <Badge tone="risk" testId="flow-bar-issues">
              {plural(issues, "issue")}
            </Badge>
          ) : null}
          {questions ? (
            <Badge tone="warning" testId="flow-bar-questions">
              {plural(questions, "question")}
            </Badge>
          ) : null}
        </button>
      ) : props.counts.steps ? (
        <Badge tone="positive" testId="flow-bar-settled">
          Nothing to settle
        </Badge>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <fieldset className="ds-seg" aria-label="View">
          {(["chart", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={props.view === v}
              data-testid={`flow-bar-view-${v}`}
              onClick={() => props.onView(v)}
            >
              {v === "chart" ? "Chart" : "List"}
            </button>
          ))}
        </fieldset>
        <Button
          variant="ghost"
          size="sm"
          disabled={!props.canUndo}
          title="Undo (Ctrl or ⌘ Z)"
          data-testid="flow-bar-undo"
          onClick={props.onUndo}
        >
          Undo
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!props.canRedo}
          title="Redo (Ctrl or ⌘ Shift Z)"
          data-testid="flow-bar-redo"
          onClick={props.onRedo}
        >
          Redo
        </Button>
        {props.extra}
        {props.onAskBuilder ? (
          <Button size="sm" data-testid="flow-bar-builder" onClick={props.onAskBuilder}>
            <Icon name="message" />
            Ask the Builder
          </Button>
        ) : null}
        {props.onTry ? (
          <Button
            size="sm"
            working={props.trying}
            disabled={!!props.tryBlocked}
            title={props.tryBlocked ?? undefined}
            data-testid="flow-bar-try"
            onClick={props.onTry}
          >
            Try it
          </Button>
        ) : null}
        {props.onSave ? (
          <Button
            size="sm"
            working={props.saving}
            disabled={props.saved}
            data-testid="flow-bar-save"
            onClick={props.onSave}
            className={cx(props.saved && "text-ink-muted")}
          >
            {props.saved ? "Saved" : "Save draft"}
          </Button>
        ) : null}
        {props.primary}
      </div>
    </header>
  );
}
