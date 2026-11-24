// A sandbox run's view (docs/plan.md §1.243), the same on both sides: that nothing was written,
// its steps in their own words, then what it would do (each change as a card, ./ChangeCard.tsx),
// then the notices it would send. Only what the API returns; the words come from the side.
import type { SandboxRun, SandboxStep } from "@countersign/core";
import { Card, SectionLabel } from "../ui/primitives";
import { ChangeCard } from "./ChangeCard";
import type { SandboxWords } from "./words";

export function SandboxRunBody({
  run,
  words,
  onSend,
}: {
  run: SandboxRun;
  words: SandboxWords;
  onSend: (changeId: string) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-6" data-testid="sandbox-run">
      <p
        className="rounded-md border border-line bg-surface-subtle px-4 py-3 text-sm text-ink"
        data-testid="sandbox-run-not-written"
      >
        {words.notWritten}
      </p>

      <section>
        <SectionLabel>{words.stepsTitle}</SectionLabel>
        {run.steps.length === 0 ? (
          <p className="text-sm text-ink-muted">{words.starting}</p>
        ) : (
          <Card pad>
            <ol className="m-0 flex list-none flex-col divide-y divide-line p-0">
              {run.steps.map((s) => (
                <StepRow key={s.id} step={s} words={words} />
              ))}
            </ol>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3" data-testid="sandbox-run-changes">
        <SectionLabel action={<span className="text-sm text-ink-muted">{words.wouldHint}</span>}>
          {words.wouldTitle}
        </SectionLabel>
        {run.changes.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {run.status === "running" ? words.starting : words.noChanges}
          </p>
        ) : (
          run.changes.map((c) => <ChangeCard key={c.id} change={c} words={words} onSend={onSend} />)
        )}
      </section>

      {run.notices.length > 0 ? (
        <section data-testid="sandbox-run-notices">
          <SectionLabel>{words.noticesTitle}</SectionLabel>
          <Card>
            {run.notices.map((n, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a step may send more than one notice.
                key={`${n.stepId}-${i}`}
                className="flex flex-col gap-1 border-b border-line px-4 py-3 last:border-b-0"
              >
                <span className="text-sm text-ink-muted">
                  {[n.stepName, words.channel(n.channel), n.to ? words.noticeTo(n.to) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <p className="m-0 whitespace-pre-wrap break-words text-ink">{n.text}</p>
              </div>
            ))}
          </Card>
        </section>
      ) : null}
    </div>
  );
}

function StepRow({ step, words }: { step: SandboxStep; words: SandboxWords }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0" data-testid={`sandbox-step-${step.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-ink">{step.name}</span>
        {/* A person step or an approval is a person's: copper (brand book). */}
        <span
          className={
            step.person
              ? "text-sm text-copper-ink"
              : step.state === "failed"
                ? "text-sm text-risk-ink"
                : "text-sm text-ink-muted"
          }
        >
          {words.stepState[step.state]}
        </span>
      </div>
      {step.summary ? <p className="m-0 text-sm text-ink-muted">{step.summary}</p> : null}
    </li>
  );
}
