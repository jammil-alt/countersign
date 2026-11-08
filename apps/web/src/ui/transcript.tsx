// P-4: a conversation step's messages on a run page (ARCHITECTURE §10.12). The agent's words stay
// ink; the person's carry the copper of people (brand book), with who said it and when. The back
// office passes each turn's model and cost as `meta`; the portal never has them (invariant 11).
import { cx } from "./cx";

export interface TranscriptLine {
  key: string;
  direction: "out" | "in";
  who: string;
  text: string;
  when?: string | null | undefined;
  meta?: string | null | undefined;
}

export function Transcript({
  lines,
  testId,
}: {
  lines: readonly TranscriptLine[];
  testId: string;
}) {
  if (lines.length === 0) return null;
  return (
    <ol className="flex flex-col gap-2" data-testid={testId}>
      {lines.map((l) => (
        <li
          key={l.key}
          className={cx(
            "rounded-md border px-3 py-2 text-sm",
            l.direction === "in" ? "border-copper bg-copper-tint" : "border-line",
          )}
        >
          <span className="flex flex-wrap items-baseline gap-2 text-xs text-ink-muted">
            <span className={l.direction === "in" ? "text-copper-ink" : "text-ink"}>{l.who}</span>
            {l.when ? <span>{l.when}</span> : null}
            {l.meta ? <span className="figures">{l.meta}</span> : null}
          </span>
          <span className="block whitespace-pre-wrap text-ink">{l.text}</span>
        </li>
      ))}
    </ol>
  );
}
