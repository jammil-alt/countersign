// v0.18 (owner, 2026-11-15; docs/plan.md §1.103): "What's left" on a draft, above the canvas. It is
// worked out from the bundle and the client, not the Builder's chat, so it stays while the chat
// scrolls on, and it empties as the draft gets finished: the missing steps first (signal, with the
// word "Missing"), then the problems the validator finds (./problems.ts words them; rendered by the
// builder with their Fix buttons), the connections and packs the client lacks, and a test run. A
// click on an item selects its step. Beside it, the agent's data at a glance: what it reads, saves
// and changes.

import type { ReactNode } from "react";
import { Badge, Count } from "../../ui/primitives";
import type { DataSummary, LeftItem } from "./data-use";

export function WhatsLeft(props: {
  items: readonly LeftItem[];
  /** The problems list (or "Valid"), as the builder renders it. */
  problems: ReactNode;
  /** How many problem lines there are, for the count. */
  problemCount: number;
  summary: DataSummary;
  onSelect(item: Extract<LeftItem, { stepId: string }>): void;
  onTest(): void;
}) {
  const { items } = props;
  const total = items.length + props.problemCount;
  return (
    <section
      data-testid="builder-whats-left"
      aria-label="What's left"
      className="mb-4 flex flex-col gap-2"
    >
      {total > 0 ? (
        <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
          What's left
          <Count n={total} tone="warning" />
        </h2>
      ) : null}
      {items.some((i) => i.kind === "missing") ? (
        <ul className="flex flex-col gap-1" data-testid="builder-left-missing">
          {items
            .filter((i) => i.kind === "missing")
            .map((item) => (
              <li key={item.key}>
                <LeftButton item={item} onClick={() => props.onSelect(item)}>
                  <Badge tone="warning" className="shrink-0">
                    Missing
                  </Badge>
                </LeftButton>
              </li>
            ))}
        </ul>
      ) : null}
      {props.problems}
      {items.some((i) => i.kind !== "missing") ? (
        <ul className="flex flex-col gap-1" data-testid="builder-left-setup">
          {items
            .filter((i) => i.kind !== "missing")
            .map((item) => (
              <li key={item.key}>
                <LeftButton
                  item={item}
                  onClick={() => (item.kind === "test" ? props.onTest() : props.onSelect(item))}
                >
                  <Badge tone="warning" className="shrink-0">
                    {item.kind === "test" ? "Test" : "Needs"}
                  </Badge>
                </LeftButton>
              </li>
            ))}
        </ul>
      ) : null}
      <DataSummaryLine summary={props.summary} />
    </section>
  );
}

function LeftButton({
  item,
  onClick,
  children,
}: {
  item: LeftItem;
  onClick(): void;
  children: ReactNode;
}) {
  const id = item.kind === "test" ? "test" : `${item.kind}-${"stepId" in item ? item.stepId : ""}`;
  return (
    <button
      type="button"
      data-testid={item.kind === "test" ? "builder-left-test" : `builder-left-${id}`}
      onClick={onClick}
      className="flex w-full items-start gap-2 rounded-md border border-signal bg-signal-tint px-3 py-1.5 text-left text-sm text-ink hover:underline"
    >
      {children}
      <span className="min-w-0">{item.text}</span>
    </button>
  );
}

const ROWS: { key: keyof DataSummary; label: string }[] = [
  { key: "reads", label: "Reads" },
  { key: "saves", label: "Saves" },
  { key: "changes", label: "Changes" },
];

/** The agent's data at a glance, one row per verb with what it touches. */
export function DataSummaryLine({ summary }: { summary: DataSummary }) {
  if (ROWS.every((r) => summary[r.key].length === 0)) return null;
  // An agent that only reads says so: what it reads stays in each run.
  const rows = ROWS.map((r) => ({
    ...r,
    text:
      summary[r.key].length > 0
        ? summary[r.key].join(", ")
        : r.key === "saves"
          ? "Nothing: what it reads stays in each run"
          : null,
  })).filter((r) => r.text !== null);
  return (
    <dl
      data-testid="builder-data-summary"
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-md border border-line bg-surface px-3 py-2 text-sm"
    >
      {rows.map((r) => (
        <div key={r.key} className="contents" data-testid={`builder-data-summary-${r.key}`}>
          <dt className="text-ink-muted">{r.label}</dt>
          <dd className="text-ink">{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}
