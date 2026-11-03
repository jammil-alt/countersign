// A diff as sentences, with before and after values (version history, customizations).
import type { BundleChangeView } from "@countersign/core";
import { Icon } from "../../ui/icons";
import { Badge, type Tone } from "../../ui/primitives";
import { describeChanges } from "./changes";

const KIND_TONE: Record<BundleChangeView["kind"], Tone> = {
  added: "positive",
  removed: "neutral",
  changed: "accent",
  moved: "neutral",
  reordered: "neutral",
};

const KIND_WORD: Record<BundleChangeView["kind"], string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  moved: "Moved",
  reordered: "Reordered",
};

export function ChangeList({
  changes,
  labels,
  empty,
  testId,
}: {
  changes: readonly BundleChangeView[];
  labels: Record<string, string>;
  empty: string;
  testId?: string;
}) {
  if (changes.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid={testId}>
        {empty}
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-line" data-testid={testId}>
      {describeChanges(changes, labels).map((line) => (
        <li key={line.key} className="flex items-start gap-3 py-2.5" data-testid="change-line">
          <Badge tone={KIND_TONE[line.kind]} className="mt-0.5 w-20 justify-center">
            {KIND_WORD[line.kind]}
          </Badge>
          <div className="min-w-0">
            <p className="text-ink">{line.text}</p>
            {line.before !== undefined || line.after !== undefined ? (
              <p className="mt-0.5 reference break-words text-ink-muted">
                {line.before !== undefined ? <span>{line.before}</span> : null}
                {line.before !== undefined && line.after !== undefined ? (
                  <>
                    <Icon name="arrow" size={14} className="mx-1 inline align-[-2px]" />
                    <span className="sr-only"> to </span>
                  </>
                ) : null}
                {line.after !== undefined ? <span className="text-ink">{line.after}</span> : null}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
