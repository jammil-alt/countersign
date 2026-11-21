// v0.18 (owner, 2026-11-15; docs/plan.md §1.105): working on steps with the Builder. The same
// Builder conversation as the whole-flow Builder (one session, its turns, Undo and /commands), with
// each turn sent about the step that is open, so the operator can go step by step, ask about it or
// change it, and see the change in the step's settings at once.
// DECISION (v0.18): one conversation shared with the whole-flow Builder, not one per step, so what
// was said about one step is there for the next; each operator turn says which step it was about.
// F6 (docs/builder-plan.md §12.3, docs/plan.md §1.170): it sits under the step's setup in the side
// panel, always there, in the size the panel gives it: the message box alone ("min"), or the
// conversation with it ("beside", "max"). The toolbar's opt-in toggle is gone with the toolbar.

import { Button } from "../../ui/primitives";
import { errorText, isCode, Notice } from "../agents/ui";
import type { BuilderSession } from "./BuilderPanel";
import { BuilderMark, Composer, Turns } from "./chat";

/** The Builder's size in the step panel, remembered per viewer in this browser. */
export const STEP_CHAT_KEY = "mezonas.builder.stepchat";

type ChatSize = "min" | "beside" | "max";

/** How much of the side panel the Builder takes, as last chosen (the message box when unknown). */
export function readStepChatSize(): ChatSize {
  try {
    const v = window.localStorage.getItem(STEP_CHAT_KEY);
    return v === "beside" || v === "max" ? v : "min";
  } catch {
    return "min";
  }
}

export function writeStepChatSize(size: ChatSize) {
  try {
    window.localStorage.setItem(STEP_CHAT_KEY, size);
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
}

export interface FocusedStep {
  id: string;
  name: string;
  /** "Step 3 of 7". */
  place: string;
}

export function StepChat({
  session,
  step,
  onPrevious,
  onNext,
  size = "beside",
}: {
  session: BuilderSession;
  step: FocusedStep;
  /** "min": the message box alone; otherwise the conversation with it. */
  size?: ChatSize | undefined;
  /** Absent at the first or last step. */
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const turns = session.detail?.turns ?? [];
  const composer = (
    <Composer
      testId="builder-step-chat-composer"
      placeholder="Ask about this step, or say what to change"
      busy={session.busy}
      onSend={(text) => session.send(text, { focusStepId: step.id })}
      clientId={session.detail?.session.clientId}
    />
  );
  const error = session.error ? (
    <Notice tone="warning" testId="builder-step-chat-error">
      {isCode(session.error, "builder_unavailable")
        ? `The Builder can't reach its model right now. ${errorText(session.error)}`
        : errorText(session.error)}
    </Notice>
  ) : null;
  if (size === "min") {
    return (
      <div data-testid="builder-step-chat" data-size="min" className="flex flex-col gap-2">
        {error}
        {composer}
      </div>
    );
  }
  return (
    <div
      data-testid="builder-step-chat"
      data-size={size}
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2.5 type-subheading text-ink">
          <BuilderMark />
          Builder
        </span>
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            data-testid="builder-step-chat-previous"
            disabled={!onPrevious}
            onClick={() => onPrevious?.()}
          >
            Previous step
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="builder-step-chat-next"
            disabled={!onNext}
            onClick={() => onNext?.()}
          >
            Next step
          </Button>
        </span>
      </div>
      <p
        className="rounded-md border border-slate bg-slate-tint px-3 py-2 text-sm text-ink"
        data-testid="builder-step-chat-focus"
      >
        Working on <span className="font-medium">{step.name || "this step"}</span>
        <span className="text-ink-muted"> · {step.place}</span>
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <Turns
          turns={turns}
          busy={session.busy}
          pending={session.pending}
          {...(session.inSync ? { onUndo: session.undo } : {})}
          undoOff="You've changed the workflow since. Undo it on the canvas."
          empty={
            <p className="text-sm text-ink-muted" data-testid="builder-step-chat-empty">
              Ask what this step does, or say what to change in it. The Builder works on this step
              and leaves the others alone unless you ask. Each change has its own Undo.
            </p>
          }
        />
        {error}
      </div>
      {composer}
    </div>
  );
}
