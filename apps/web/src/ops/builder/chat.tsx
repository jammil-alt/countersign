// The Builder conversation's parts (ARCHITECTURE §9.6; prototype `#O5-NewAgent` and `#O6-Builder`),
// shared by the new-agent page and the workflow builder's side panel: the turns (the operator's
// bubbles, the Builder's answers with each labelled change and its Undo, its questions and what it
// can't do yet) and the composer with its /skill, /automation and /trigger shortcuts. Built from the
// one conversation component (`ui/chat.tsx`), as every conversation with an agent is.
import type { BuilderChange, BuilderTurnView } from "@countersign/core";
import { type ReactNode, useRef, useState } from "react";
import { AgentBadge } from "../../ui/badges";
import { AgentSaid, Composer as ChatComposer, ChatLog, Pending, YouSaid } from "../../ui/chat";
import { cx } from "../../ui/primitives";

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
  const shown = turns.filter((t) => t.command !== "/start");
  if (shown.length === 0 && !pending) return <>{empty}</>;
  return (
    <ChatLog follow={`${shown.length}:${pending ?? ""}`} testId="builder-turns">
      {shown.map((t) =>
        t.role === "operator" ? (
          <YouSaid
            key={t.id}
            text={t.text}
            mono={!!t.command}
            testId={`builder-turn-${t.seq}`}
            // v0.18 (docs/plan.md §1.105): a turn sent while working on one step says which.
            above={
              t.focus ? (
                <span data-testid={`builder-turn-${t.seq}-focus`}>On “{t.focus.name}”</span>
              ) : undefined
            }
          />
        ) : (
          <BuilderTurn key={t.id} turn={t} onUndo={onUndo} undoOff={undoOff} busy={busy} />
        ),
      )}
      {pending ? (
        <Pending
          text={pending}
          badge={<BuilderMark />}
          label="The Builder is working on it…"
          state="drafting"
          testId="builder-thinking"
        />
      ) : null}
    </ChatLog>
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
    <AgentSaid badge={<BuilderMark />} text={turn.text} testId={`builder-turn-${turn.seq}`}>
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
    </AgentSaid>
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
  /** Resolves true when the turn went through; otherwise the words come back to the box. */
  onSend(text: string): Promise<boolean>;
  testId?: string;
}) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <ChatComposer
      label="Message to the Builder"
      placeholder={placeholder}
      busy={busy}
      value={text}
      onValueChange={setText}
      onSend={onSend}
      inputRef={box}
      testId={testId}
      inputTestId={`${testId}-input`}
      sendTestId={`${testId}-send`}
      tools={SHORTCUTS.map((s) => (
        <button
          key={s}
          type="button"
          data-testid={`${testId}-${s.slice(1)}`}
          className="rounded-sm border border-line bg-surface-subtle px-2 py-1 font-mono text-xs text-ink hover:bg-surface"
          onClick={() => {
            setText(text.startsWith("/") ? text : `${s} ${text}`);
            box.current?.focus();
          }}
        >
          {s}
        </button>
      ))}
    />
  );
}
