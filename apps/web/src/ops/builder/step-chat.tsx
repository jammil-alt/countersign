// v0.18 (owner, 2026-11-15; docs/plan.md §1.105): working on steps with the Builder. An opt-in
// beside the step's settings: the same Builder conversation as the side panel's Builder tab (one
// session, its turns, Undo and /commands), with each turn sent about the step that is open, so the
// operator can go step by step, ask about it or change it, and see the change in the step's
// settings at once. It adds to the builder; with it off nothing changes.
// DECISION (v0.18): one conversation shared with the Builder tab, not one per step, so what was
// said about one step is there for the next; each operator turn says which step it was about.
// DECISION (v0.18): the opt-in is a toggle in the builder's toolbar, not a button in the
// inspector, so the inspector's content stays as it is.

import { Button } from "../../ui/primitives";
import { errorText, isCode, Notice } from "../agents/ui";
import type { BuilderSession } from "./BuilderPanel";
import { BuilderMark, Composer, Turns } from "./chat";

/** The opt-in, remembered per viewer in this browser (a convenience: off when unknown). */
export const STEP_CHAT_KEY = "mezonas.builder.stepchat";

export function readStepChat(): boolean {
  try {
    return window.localStorage.getItem(STEP_CHAT_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeStepChat(on: boolean) {
  try {
    window.localStorage.setItem(STEP_CHAT_KEY, on ? "on" : "off");
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
}: {
  session: BuilderSession;
  step: FocusedStep;
  /** Absent at the first or last step. */
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const turns = session.detail?.turns ?? [];
  return (
    <section
      aria-label="The Builder on this step"
      data-testid="builder-step-chat"
      className="flex min-h-0 flex-col gap-3 border-t border-line pt-4 @6xl:border-t-0 @6xl:border-l @6xl:pt-0 @6xl:pl-4"
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
        {session.error ? (
          <Notice tone="warning" testId="builder-step-chat-error">
            {isCode(session.error, "builder_unavailable")
              ? `The Builder can't reach its model right now. ${errorText(session.error)}`
              : errorText(session.error)}
          </Notice>
        ) : null}
      </div>
      <Composer
        testId="builder-step-chat-composer"
        placeholder="Ask about this step, or say what to change"
        busy={session.busy}
        onSend={(text) => session.send(text, { focusStepId: step.id })}
        clientId={session.detail?.session.clientId}
      />
    </section>
  );
}
