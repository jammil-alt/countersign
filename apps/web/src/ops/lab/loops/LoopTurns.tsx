// A Loop's test, turn by turn (docs/step-model-plan.md §8): for each turn, the action it called,
// what it asked with, what came back, and what the model said before deciding its next call. The
// last turn is its answer. A write it asks for shows as refused; a test never writes (invariant 8).
import type { LoopTurnView } from "@countersign/core";
import { StatusChip } from "../../../ui/status";
import { toolTitle } from "../../builder/model";
import { shortValue } from "../../skills/TestsPanel";

/** Turns kept with a case's result (`diff.turns`), read leniently: a case run before has none. */
export function turnsOf(diff: unknown): LoopTurnView[] {
  const turns = (diff as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(turns)) return [];
  return turns.filter(
    (t): t is LoopTurnView =>
      typeof t === "object" && t !== null && typeof (t as { n?: unknown }).n === "number",
  );
}

const CALL_LABEL: Record<string, string> = {
  succeeded: "Answered",
  refused: "Refused",
  failed: "No answer",
  running: "Running",
};

export function LoopTurns({ turns, testId }: { turns: readonly LoopTurnView[]; testId?: string }) {
  if (turns.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid={testId}>
        No turns were kept for this one. Run it again to see them.
      </p>
    );
  }
  return (
    <ol className="flex flex-col divide-y divide-line" data-testid={testId}>
      {turns.map((t) => (
        <li key={t.n} className="py-3" data-testid={`loop-turn-${t.n}`}>
          <p className="flex items-center gap-2 text-sm">
            <span className="font-medium text-ink figures">Turn {t.n}</span>
            {t.finished ? <span className="text-ink-muted">It gave its answer</span> : null}
          </p>
          {t.said ? (
            <p className="mt-1 text-sm text-ink" data-testid={`loop-turn-${t.n}-said`}>
              {t.said}
            </p>
          ) : null}
          {t.calls.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a turn's calls are in order, never reordered.
            <div key={i} className="mt-2 border-l-2 border-line pl-3" data-testid="loop-call">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink">{toolTitle({ id: c.tool })}</span>
                <span className="reference text-ink-muted">{c.tool}</span>
                <StatusChip state={c.status === "succeeded" ? "done" : "failed"}>
                  {CALL_LABEL[c.status] ?? c.status}
                </StatusChip>
              </p>
              {c.input !== undefined ? (
                <p className="mt-1 text-sm text-ink-muted">
                  Asked with <span className="reference text-ink">{shortValue(c.input)}</span>
                </p>
              ) : null}
              {c.reason ? <p className="mt-1 text-sm text-risk">{c.reason}</p> : null}
              {c.output !== undefined && c.output !== null ? (
                <p className="mt-1 text-sm text-ink-muted">
                  Got <span className="reference text-ink">{shortValue(c.output)}</span>
                </p>
              ) : null}
            </div>
          ))}
        </li>
      ))}
    </ol>
  );
}
