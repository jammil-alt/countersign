// The Suggest button (docs/step-model-plan.md §5): the AI icon the SOP uses, at the top of every
// step's form (the whole step) and beside every field (that field). It opens a small pop-up with
// "Tell it what you need", "Use the default" and "Resolve". What comes back is applied at once and
// Undo takes it back; the answer is wave 2's, so for now it says Suggest isn't switched on.

import { useEffect, useId, useRef, useState } from "react";
import { SopIcon } from "../../../sop/icons";
import { Button, cx } from "../../../ui/primitives";
import { SUGGEST_CHOICES, type SuggestFn, type SuggestHow } from "./suggest";
import type { Step } from "./types";

export interface SuggestButtonProps {
  step: Step;
  /** The field it works on, as the server names it (`goal`, `input.vendorId`); absent: the step. */
  field?: string | undefined;
  /** What it is for, in a word or two: "Goal", "Input". Names the button for a screen reader. */
  label: string;
  suggest: SuggestFn;
  /** The step as the suggestion made it, or as Undo put it back. */
  onApply(next: Step): void;
  /** Whether something here is flagged: Resolve is the first choice then. */
  flagged?: boolean | undefined;
}

type State =
  | { phase: "closed" }
  | { phase: "menu"; how: SuggestHow; text: string }
  | { phase: "working" }
  | { phase: "done"; summary: string; undo: Step | null }
  | { phase: "failed"; message: string };

export function SuggestButton(props: SuggestButtonProps) {
  const { step, field, label, suggest, onApply } = props;
  const [state, setState] = useState<State>({ phase: "closed" });
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = state.phase !== "closed";
  // Resolve is the first choice where something is flagged, else "Tell it what you need".
  const first: SuggestHow = props.flagged ? "resolve" : "tell";
  const menu = (): State => ({ phase: "menu", how: first, text: "" });

  // A click outside closes the pop-up, unless it is working or shows what it did (Undo stays).
  useEffect(() => {
    if (state.phase !== "menu") return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setState({ phase: "closed" });
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [state.phase]);

  const ask = async (how: SuggestHow, text?: string) => {
    setState({ phase: "working" });
    try {
      const out = await suggest({ step, field, how, ...(text ? { text } : {}) });
      if (out.applied) {
        onApply(out.step);
        setState({ phase: "done", summary: out.summary, undo: step });
      } else {
        setState({ phase: "done", summary: out.summary, undo: null });
      }
    } catch {
      setState({ phase: "failed", message: "Suggest didn't answer. Try again." });
    }
  };

  return (
    <div ref={box} className="relative inline-flex" data-testid={`suggest-${field ?? "step"}`}>
      <button
        type="button"
        aria-label={`Suggest for ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className={cx(
          "ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm",
          props.flagged ? "text-slate" : "text-ink-muted hover:text-ink",
        )}
        onClick={() => setState(open ? { phase: "closed" } : menu())}
      >
        <SopIcon name="ai" size={16} />
      </button>
      {open ? (
        <div
          id={id}
          role="dialog"
          aria-label={`Suggest for ${label}`}
          className="absolute right-0 top-full z-20 mt-1 flex w-72 flex-col gap-2 border border-line bg-surface p-3 text-sm"
        >
          {state.phase === "menu" ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (state.how === "tell" && !state.text.trim()) return;
                void ask(state.how, state.how === "tell" ? state.text.trim() : undefined);
              }}
            >
              <span className="eyebrow text-ink-muted">Suggest</span>
              {SUGGEST_CHOICES.map((c) => (
                <div key={c.how} className="flex flex-col">
                  <button
                    type="button"
                    aria-pressed={state.how === c.how}
                    className={cx(
                      "flex w-full flex-col items-start px-2 py-1.5 text-left hover:bg-surface-muted",
                      state.how === c.how && "bg-surface-muted",
                    )}
                    onClick={() => setState({ ...state, how: c.how })}
                  >
                    <span className="text-ink">{c.label}</span>
                    <span className="text-xs text-ink-muted">{c.hint}</span>
                  </button>
                  {c.how === "tell" && state.how === "tell" ? (
                    <textarea
                      aria-label="What you need"
                      className="ds-input mt-1 min-h-16"
                      value={state.text}
                      onChange={(e) => setState({ ...state, text: e.target.value })}
                      placeholder="Only lines over $500"
                    />
                  ) : null}
                </div>
              ))}
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => setState({ phase: "closed" })}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={state.how === "tell" && !state.text.trim()}
                >
                  Suggest
                </Button>
              </div>
            </form>
          ) : null}
          {state.phase === "working" ? <p className="text-ink-muted">Working on it…</p> : null}
          {state.phase === "done" ? (
            <div className="flex flex-col gap-2">
              <p className="text-ink">{state.summary}</p>
              <div className="flex gap-2">
                {state.undo ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      if (state.undo) onApply(state.undo);
                      setState({ phase: "closed" });
                    }}
                  >
                    Undo
                  </Button>
                ) : null}
                <Button size="sm" onClick={() => setState({ phase: "closed" })}>
                  Close
                </Button>
              </div>
            </div>
          ) : null}
          {state.phase === "failed" ? (
            <div className="flex flex-col gap-2">
              <p className="text-risk-ink">{state.message}</p>
              <Button size="sm" onClick={() => setState(menu())}>
                Back
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
