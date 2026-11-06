// The Builder conversation's parts (ARCHITECTURE §9.6; prototype `#O5-NewAgent` and `#O6-Builder`),
// shared by the new-agent page and the workflow builder's side panel: the turns (the operator's
// bubbles, the Builder's answers with each labelled change and its Undo, its questions and what it
// can't do yet) and the composer with its /skill, /automation and /trigger shortcuts.
import type { BuilderChange, BuilderTurnView } from "@countersign/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AgentBadge } from "../../ui/badges";
import { Button, cx } from "../../ui/primitives";

/** The Builder's tile: the same initials tile as any agent. */
export function BuilderMark() {
  return <AgentBadge name="Builder" size="sm" />;
}

/** "+" for an addition, "−" for a removal, "~" for a change. */
export function changeSign(change: Pick<BuilderChange, "before" | "after">): string {
  if (change.before === undefined && change.after !== undefined) return "+";
  if (change.after === undefined && change.before !== undefined) return "−";
  return "~";
}

export interface TurnsProps {
  turns: readonly BuilderTurnView[];
  /** Undo one change of a turn; absent where undo isn't offered right now. */
  onUndo?(turnId: string, changeId: string): void;
  /** Why Undo is off, when `onUndo` is absent. */
  undoOff?: string | undefined;
  busy?: boolean | undefined;
  /** Shown under the last turn while the Builder is answering. */
  pending?: string | null;
  empty?: ReactNode;
}

export function Turns({ turns, onUndo, undoOff, busy, pending, empty }: TurnsProps) {
  const end = useRef<HTMLDivElement>(null);
  const shown = turns.filter((t) => t.command !== "/start");
  // jsdom has no scrollIntoView; browsers keep the newest turn in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the turn count changes.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [shown.length, pending]);
  if (shown.length === 0 && !pending) return <>{empty}</>;
  return (
    <div className="flex flex-col gap-5" data-testid="builder-turns">
      {shown.map((t) =>
        t.role === "operator" ? (
          <OperatorTurn key={t.id} turn={t} />
        ) : (
          <BuilderTurn key={t.id} turn={t} onUndo={onUndo} undoOff={undoOff} busy={busy} />
        ),
      )}
      {pending ? (
        <>
          <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-surface-subtle px-3.5 py-2.5 text-sm text-ink">
            {pending}
          </p>
          <div className="flex items-start gap-3" data-testid="builder-thinking">
            <BuilderMark />
            <p className="pt-1 text-sm text-ink-muted">The Builder is working on it…</p>
          </div>
        </>
      ) : null}
      <div ref={end} />
    </div>
  );
}

function OperatorTurn({ turn }: { turn: BuilderTurnView }) {
  return (
    <p
      className={cx(
        "ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-surface-subtle px-3.5 py-2.5 text-sm text-ink",
        turn.command && "font-mono",
      )}
      data-testid={`builder-turn-${turn.seq}`}
    >
      {turn.text}
    </p>
  );
}

function BuilderTurn({
  turn,
  onUndo,
  undoOff,
  busy,
}: {
  turn: BuilderTurnView;
  onUndo?: TurnsProps["onUndo"] | undefined;
  undoOff?: string | undefined;
  busy?: boolean | undefined;
}) {
  // An undo turn's own entries name what they reverted; they aren't undone again.
  const undoable = (c: BuilderTurnView["changes"][number]) => !c.undoes && !c.undone;
  return (
    <div className="flex items-start gap-3" data-testid={`builder-turn-${turn.seq}`}>
      <BuilderMark />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 text-sm text-ink">
        {turn.text ? <p className="whitespace-pre-wrap">{turn.text}</p> : null}
        {turn.changes.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {turn.changes.map((c) => (
              <li
                key={c.id}
                data-testid="builder-change"
                className={cx(
                  "flex items-center gap-2.5 rounded-sm border border-line bg-surface px-3 py-2",
                  c.undone && "text-ink-muted line-through",
                )}
              >
                <span className="figures w-3 shrink-0 text-slate" aria-hidden>
                  {changeSign(c)}
                </span>
                <span className="min-w-0 flex-1">{c.label}</span>
                {c.undone ? (
                  <span className="text-xs text-ink-muted no-underline">Undone</span>
                ) : undoable(c) ? (
                  <button
                    type="button"
                    className="ds-btn ds-btn--link text-sm"
                    data-testid="builder-change-undo"
                    disabled={!onUndo || busy}
                    title={onUndo ? undefined : undoOff}
                    onClick={() => onUndo?.(turn.id, c.id)}
                  >
                    Undo
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {turn.questions.length > 0 ? (
          <ol className="list-decimal pl-5" data-testid="builder-questions">
            {turn.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        ) : null}
        {turn.gaps.length > 0 ? (
          <div data-testid="builder-turn-gaps">
            <p className="font-medium">What it can't do yet</p>
            <ul className="list-disc pl-5 text-ink-muted">
              {turn.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const SHORTCUTS = ["/skill", "/automation", "/trigger"] as const;

/** Where the operator writes: free text, or a /command with its target. */
export function Composer({
  placeholder,
  busy,
  onSend,
  testId = "builder-composer",
}: {
  placeholder: string;
  busy: boolean;
  /** Resolves true when the turn went through, so the box empties. */
  onSend(text: string): Promise<boolean>;
  testId?: string;
}) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const empty = !text.trim();
  async function send() {
    if (empty || busy) return;
    if (await onSend(text.trim())) setText("");
  }
  return (
    <div className="rounded-md border border-line-strong bg-surface p-3" data-testid={testId}>
      <textarea
        ref={box}
        aria-label="Message to the Builder"
        data-testid={`${testId}-input`}
        rows={3}
        value={text}
        placeholder={placeholder}
        className="w-full resize-none bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {SHORTCUTS.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`${testId}-${s.slice(1)}`}
            className="rounded-sm border border-line bg-surface-subtle px-2 py-1 font-mono text-xs text-ink hover:bg-surface"
            onClick={() => {
              setText((t) => (t.startsWith("/") ? t : `${s} ${t}`));
              box.current?.focus();
            }}
          >
            {s}
          </button>
        ))}
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          data-testid={`${testId}-send`}
          disabled={empty || busy}
          onClick={() => void send()}
        >
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
