// The List on the one-screen builder (docs/builder-plan.md §12.3: "the Steps tab becomes the List
// with each step's status"): one row per step in reading order, a decision's paths as rows between
// ("A  if the invoice is a duplicate · ends there", "otherwise · comes back"), the first open item
// under a step's name, and its status: Ready, its issues and questions, what it did in the try.
// "Needs you" keeps only the steps with something open. A click opens the same side panel.
import type { processes } from "@countersign/core";
import { type ReactNode, useState } from "react";
import { Badge, cx } from "../../ui/primitives";
import { processKindLabel, triggerTitle } from "../workflow/describe";
import { openItems, plural, TRY_WORD } from "./status";
import type { Process, StatusMap, Step, StepStatus } from "./types";

type Trigger = Process["triggers"][number];

export interface StepTableProps {
  process: Process;
  statuses: StatusMap;
  selected: string | null;
  onSelect(id: string): void;
  /** The step's kind in a word (the chart's `label`); `processKindLabel` when absent. */
  label?: ((step: Step) => { title: string; kind: string; detail: string | null }) | undefined;
  /** A trigger's title; today's `triggerTitle` when absent. */
  triggerLabel?: ((trigger: Trigger) => string) | undefined;
  /** Above the filter: the build's note, for one. */
  note?: ReactNode;
  /** Below the table: "Add a step" at the end. */
  onAdd?: (() => void) | undefined;
}

export type TableRow =
  | {
      type: "step";
      id: string;
      /** "1", "A1", "3.2"; empty for a trigger. */
      number: string;
      name: string;
      kind: string;
      depth: number;
      trigger: boolean;
    }
  | { type: "path"; key: string; ifId: string; letter: string; text: string; depth: number };

const letter = (i: number) => String.fromCharCode(65 + (i % 26));

/** A path ends when its last step is Stop; otherwise it comes back to its decision's next step. */
function ends(steps: readonly Step[]): boolean {
  return steps.at(-1)?.kind === "stop";
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** The List's rows: the triggers, then every step in reading order with its paths between. */
export function tableRows(
  process: Process,
  kindOf: (step: Step) => string,
  triggerName: (t: Trigger) => string,
): TableRow[] {
  const rows: TableRow[] = process.triggers.map((t) => ({
    type: "step",
    id: t.id,
    number: "",
    name: triggerName(t),
    kind: "Starts when",
    depth: 0,
    trigger: true,
  }));
  const walk = (steps: readonly Step[], depth: number, label: (i: number) => string) => {
    steps.forEach((step, i) => {
      const n = label(i);
      rows.push({
        type: "step",
        id: step.id,
        number: n,
        name: step.name || kindOf(step),
        kind: kindOf(step),
        depth,
        trigger: false,
      });
      if (step.kind === "if") {
        step.paths.forEach((p: processes.IfPath, k) => {
          const words = lowerFirst((p.describe ?? p.name).trim());
          rows.push({
            type: "path",
            key: `path:${p.id}`,
            ifId: step.id,
            letter: letter(k),
            text: `${k ? "or if" : "if"} ${words} · ${ends(p.steps) ? "ends there" : "comes back"}`,
            depth: depth + 1,
          });
          walk(p.steps, depth + 1, (x) => `${letter(k)}${x + 1}`);
        });
        const o = step.otherwise;
        const ol = letter(step.paths.length);
        rows.push({
          type: "path",
          key: `otherwise:${o.id}`,
          ifId: step.id,
          letter: "",
          text: `otherwise · ${ends(o.steps) ? "ends there" : "comes back"}`,
          depth: depth + 1,
        });
        walk(o.steps, depth + 1, (x) => `${ol}${x + 1}`);
      } else if (step.kind === "for_each" || step.kind === "repeat") {
        walk(step.steps, depth + 1, (x) => `${n}.${x + 1}`);
      }
    });
  };
  walk(process.steps, 0, (i) => String(i + 1));
  return rows;
}

function needsYou(s: StepStatus | undefined): boolean {
  return !!s && s.level !== "ok";
}

function StatusCell({ status }: { status: StepStatus | undefined }) {
  const open = openItems(status);
  const issues = open.filter((i) => i.level === "issue").length;
  const questions = open.length - issues;
  const tried = status?.tried ? TRY_WORD[status.tried.status] : null;
  if (!issues && !questions && !tried) return <Badge tone="positive">Ready</Badge>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {issues ? <Badge tone="risk">{plural(issues, "issue")}</Badge> : null}
      {questions ? <Badge tone="warning">{plural(questions, "question")}</Badge> : null}
      {tried ? <Badge tone={tried.tone}>{tried.word}</Badge> : null}
    </span>
  );
}

export function StepTable(props: StepTableProps) {
  const { statuses } = props;
  const [only, setOnly] = useState(false);
  const kindOf = (s: Step) => props.label?.(s).kind ?? processKindLabel(s);
  const rows = tableRows(props.process, kindOf, props.triggerLabel ?? triggerTitle);
  const steps = rows.filter((r) => r.type === "step" && !r.trigger).length;
  const waiting = rows.filter((r) => r.type === "step" && needsYou(statuses.get(r.id))).length;
  const shown = only ? rows.filter((r) => r.type === "step" && needsYou(statuses.get(r.id))) : rows;

  return (
    <section className="flex flex-col gap-3" data-testid="flow-list" aria-label="Steps">
      {props.note}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset className="ds-seg" aria-label="Show">
          <button
            type="button"
            aria-pressed={!only}
            data-testid="flow-list-all"
            onClick={() => setOnly(false)}
          >
            All {plural(steps, "step")}
          </button>
          <button
            type="button"
            aria-pressed={only}
            data-testid="flow-list-needs"
            onClick={() => setOnly(true)}
          >
            Needs you · {waiting}
          </button>
        </fieldset>
        <span className="text-sm text-ink-muted">
          {waiting
            ? "Click a step to settle it in the side panel. Issues are red, questions are gold."
            : "Nothing left to settle. Try it, or turn it on."}
        </span>
      </div>
      <div className="dt dt-ana">
        <table data-testid="flow-list-table">
          <thead>
            <tr className="dt-cols">
              <th className="w-12">#</th>
              <th>Step</th>
              <th className="hidden sm:table-cell">Kind</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) =>
              r.type === "path" ? (
                <tr
                  key={r.key}
                  data-testid={`flow-list-${r.key}`}
                  className="cursor-pointer [&>td]:bg-surface-subtle"
                  onClick={() => props.onSelect(r.ifId)}
                >
                  <td />
                  <td colSpan={3} className="text-sm text-ink-muted">
                    <span style={{ paddingLeft: `${r.depth * 18}px` }}>
                      {r.letter ? (
                        <span className="mr-1.5 font-medium text-slate">{r.letter}</span>
                      ) : null}
                      {r.text}
                    </span>
                  </td>
                </tr>
              ) : (
                <StepRow
                  key={r.id}
                  row={r}
                  status={statuses.get(r.id)}
                  selected={props.selected === r.id}
                  indent={!only}
                  onSelect={props.onSelect}
                />
              ),
            )}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={4} className="dt-empty text-ink-muted">
                  {only ? "Nothing needs you right now." : "No steps yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {props.onAdd ? (
        <div>
          <button
            type="button"
            className="ds-btn ds-btn--secondary ds-btn--sm"
            data-testid="flow-list-add"
            onClick={props.onAdd}
          >
            Add a step
          </button>
        </div>
      ) : null}
    </section>
  );
}

function StepRow({
  row,
  status,
  selected,
  indent,
  onSelect,
}: {
  row: Extract<TableRow, { type: "step" }>;
  status: StepStatus | undefined;
  selected: boolean;
  indent: boolean;
  onSelect(id: string): void;
}) {
  const first = openItems(status)[0];
  const tried = status?.tried;
  return (
    <tr
      data-testid={`flow-list-row-${row.id}`}
      data-level={status?.level ?? "ok"}
      className={cx("cursor-pointer align-middle", selected && "[&>td]:bg-slate-tint")}
      onClick={() => onSelect(row.id)}
    >
      <td className="figures text-ink-muted">{row.number}</td>
      <td>
        <span
          className="flex flex-col"
          style={indent ? { paddingLeft: `${row.depth * 18}px` } : undefined}
        >
          <button
            type="button"
            className="text-left text-ink hover:underline"
            data-testid={`flow-list-open-${row.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(row.id);
            }}
          >
            {row.name}
          </button>
          {first ? (
            <span
              className={cx(
                "text-sm",
                first.level === "issue" ? "text-risk-ink" : "text-signal-ink",
              )}
              data-testid={`flow-list-why-${row.id}`}
            >
              {first.title}
            </span>
          ) : tried?.summary ? (
            <span className="text-sm text-ink-muted">{tried.summary}</span>
          ) : null}
        </span>
      </td>
      {/* A phone has room for the step and its status; the kind is in the step's panel. */}
      <td className="hidden whitespace-nowrap eyebrow text-ink-muted sm:table-cell">{row.kind}</td>
      <td>
        <StatusCell status={status} />
      </td>
    </tr>
  );
}
