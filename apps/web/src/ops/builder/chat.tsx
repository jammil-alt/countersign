// The Builder conversation's parts (ARCHITECTURE §9.6; prototype `#O5-NewAgent` and `#O6-Builder`),
// shared by the new-agent page and the workflow builder's side panel: the turns (the operator's
// bubbles, the Builder's answers with each labelled change and its Undo, its questions and what it
// can't do yet) and the composer with its /skill, /automation and /trigger shortcuts. Built from the
// one conversation component (`ui/chat.tsx`), as every conversation with an agent is.
import type { BuilderChange, BuilderTurnView } from "@countersign/core";
import { type ReactNode, useRef, useState } from "react";
import { voiceFor } from "../../api/voice";
import { AgentBadge } from "../../ui/badges";
import { AgentSaid, Composer as ChatComposer, ChatLog, Pending, YouSaid } from "../../ui/chat";
import { Icon } from "../../ui/icons";
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
  /**
   * Show the conversation as threads, with the one about this step (null: the whole workflow)
   * open and the others folded to a line each. Absent: every turn in order, as before.
   */
  thread?: { stepId: string | null } | undefined;
}

/** A run of the conversation about one thing: one step, or the whole workflow (`stepId` null). */
export interface Thread {
  stepId: string | null;
  /** The step's name when it was last spoken about. */
  name: string | null;
  turns: BuilderTurnView[];
}

/**
 * The conversation as threads, in the order it happened: each of the operator's turns and the
 * Builder's answers to it are about the step it was sent from (or the whole workflow), an Undo is
 * about what the change it takes back was, and turns in a row about the same thing are one thread.
 */
export function threadsOf(turns: readonly BuilderTurnView[]): Thread[] {
  const out: Thread[] = [];
  type About = { stepId: string; name: string } | null;
  let about: About = null;
  // What each turn was about, so an Undo joins the thread of the change it takes back.
  const aboutOf = new Map<string, About>();
  for (const t of turns) {
    if (t.role === "operator") {
      const undone = t.changes.find((c) => c.undoes)?.undoes?.turnId;
      about =
        undone !== undefined && aboutOf.has(undone)
          ? (aboutOf.get(undone) ?? null)
          : (t.focus ?? null);
    }
    aboutOf.set(t.id, about);
    const last = out.at(-1);
    if (last && last.stepId === (about?.stepId ?? null)) {
      last.turns.push(t);
      if (about) last.name = about.name;
    } else {
      out.push({ stepId: about?.stepId ?? null, name: about?.name ?? null, turns: [t] });
    }
  }
  return out;
}

/** "3 messages". */
function messages(n: number): string {
  return `${n} ${n === 1 ? "message" : "messages"}`;
}

export function Turns({ turns, onUndo, undoOff, busy, pending, empty, thread }: TurnsProps) {
  const shown = turns.filter((t) => t.command !== "/start");
  // Threads the operator opened or folded by hand, by their first turn; the rest follow the rule.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  if (shown.length === 0 && !pending) return <>{empty}</>;
  const one = (t: BuilderTurnView, said: boolean) =>
    t.role === "operator" ? (
      <YouSaid
        key={t.id}
        text={t.text}
        mono={!!t.command}
        testId={`builder-turn-${t.seq}`}
        // v0.18 (docs/plan.md §1.105): a turn sent while working on one step says which; under
        // a thread's own heading it has been said already.
        above={
          t.focus && !said ? (
            <span data-testid={`builder-turn-${t.seq}-focus`}>On “{t.focus.name}”</span>
          ) : undefined
        }
      />
    ) : (
      <BuilderTurn key={t.id} turn={t} onUndo={onUndo} undoOff={undoOff} busy={busy} />
    );
  if (!thread) {
    return (
      <ChatLog follow={`${shown.length}:${pending ?? ""}`} testId="builder-turns">
        {shown.map((t) => one(t, false))}
        {pending ? <Thinking text={pending} /> : null}
      </ChatLog>
    );
  }
  // Owner, 2026-11-21 ("it is hard to tell what the builder is talking about, maybe we can keep
  // threads per step? Maybe collapsible?"; docs/plan.md §1.177): one conversation still, shown as
  // threads. What was said about the thing open now (this step, or the whole workflow) is open;
  // every other thread is a line with its step's name, opened by a click. The newest thread on
  // the whole-workflow panel is open too, so the last answer is never hidden there.
  const threads = threadsOf(shown);
  const mine = threads.filter((t) => t.stepId === thread.stepId);
  return (
    <ChatLog follow={`${shown.length}:${pending ?? ""}`} testId="builder-turns">
      {threads.map((t, i) => {
        const key = t.turns[0]?.id ?? String(i);
        const own = t.stepId === thread.stepId;
        const newest = thread.stepId === null && i === threads.length - 1;
        const open = toggled.get(key) ?? (own || newest);
        if (own) return t.turns.map((turn) => one(turn, true));
        const title = t.stepId === null ? "About the whole workflow" : `On “${t.name ?? "a step"}”`;
        return (
          <div
            key={key}
            data-testid="builder-thread"
            data-step={t.stepId ?? ""}
            data-open={open}
            className="flex flex-col gap-3"
          >
            <button
              type="button"
              aria-expanded={open}
              data-testid="builder-thread-toggle"
              className="ui-chat-meta flex items-center gap-1 self-start rounded-sm text-left hover:text-ink focus-visible:outline-2 focus-visible:outline-slate"
              onClick={() => setToggled(new Map(toggled).set(key, !open))}
            >
              <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
              {title} · {messages(t.turns.length)}
            </button>
            {open ? (
              <div className="flex flex-col gap-3 border-l-2 border-line pl-3">
                {t.turns.map((turn) => one(turn, true))}
              </div>
            ) : null}
          </div>
        );
      })}
      {mine.length === 0 && !pending ? empty : null}
      {pending ? <Thinking text={pending} /> : null}
    </ChatLog>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <Pending
      text={text}
      badge={<BuilderMark />}
      label="The Builder is working on it…"
      state="drafting"
      testId="builder-thinking"
    />
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
  clientId,
  compact = false,
  initialText = "",
}: {
  placeholder: string;
  /** What the box starts with (an issue to fix, to read over before sending). */
  initialText?: string | undefined;
  /** The small box of the step panel. */
  compact?: boolean | undefined;
  /** §1.109: the client the conversation is about, for voice typing's HIPAA check. */
  clientId?: string | null | undefined;
  busy: boolean;
  /** Resolves true when the turn went through; otherwise the words come back to the box. */
  onSend(text: string): Promise<boolean>;
  testId?: string;
}) {
  const [text, setText] = useState(initialText);
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <ChatComposer
      compact={compact}
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
      voice={voiceFor("ops", clientId)}
      // Owner, 2026-11-21 ("what is the point of the /skill, /automation etc in the builder
      // chat?"): the small box of a step has no room for them and a step rarely needs them; a
      // /command typed there still works.
      tools={(compact ? [] : SHORTCUTS).map((s) => (
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
