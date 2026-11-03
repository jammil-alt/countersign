// A diff as sentences, with before and after values (version history, customizations).
import type { BundleChangeView } from "@countersign/core";
import { Badge, type Tone } from "../../ui/primitives";
import { describeChanges } from "./changes";

const KIND_TONE: Record<BundleChangeView["kind"], Tone> = {
  added: "positive",
  removed: "warning",
  changed: "neutral",
  moved: "accent",
  reordered: "accent",
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
      <p className="text-sm text-secondary" data-testid={testId}>
        {empty}
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-divider" data-testid={testId}>
      {describeChanges(changes, labels).map((line) => (
        <li key={line.key} className="flex items-start gap-3 py-2.5" data-testid="change-line">
          <Badge tone={KIND_TONE[line.kind]} className="mt-0.5 w-20 justify-center">
            {line.kind}
          </Badge>
          <div className="min-w-0">
            <p className="text-primary">{line.text}</p>
            {line.before !== undefined || line.after !== undefined ? (
              <p className="mt-0.5 font-mono text-xs break-words text-secondary">
                {line.before !== undefined ? <span>{line.before}</span> : null}
                {line.before !== undefined && line.after !== undefined ? (
                  <span aria-hidden> → </span>
                ) : null}
                {line.after !== undefined ? <span className="text-body">{line.after}</span> : null}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
