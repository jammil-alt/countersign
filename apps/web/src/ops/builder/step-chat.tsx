// v0.18 (owner, 2026-11-15; docs/plan.md §1.105): working on steps with the Builder. The same
// Builder conversation as the whole-flow Builder (one session, its turns, Undo and /commands), with
// each turn sent about the step that is open, so the operator can go step by step, ask about it or
// change it, and see the change in the step's settings at once.
// DECISION (v0.18): one conversation shared with the whole-flow Builder, not one per step, so what
// was said about one step is there for the next; each operator turn says which step it was about.
// Owner, 2026-11-21 ("hard to tell what the builder is talking about… threads per step?"): it is
// shown as threads. This step's is open; what was said about other steps, or the whole workflow,
// is a line each that opens on a click (./chat `Turns`, docs/plan.md §1.177).
// F6 (docs/builder-plan.md §12.3, docs/plan.md §1.170): it sits under the step's setup in the side
// panel, always there: half the panel ("beside"), all of it ("max"), or folded to one line
// ("line"), as the panel's head chooses and this file remembers.
// Owner, 2026-11-21 ("there is too much lost space here… in the whole screen only 3 lines are the
// conversation"; "when you type it into the box there is no spot for a response"): the conversation
// is all of it but a small message box. The "Builder" title row, the "Working on" banner and the
// box-only size are gone: the panel's own title names the step, and its head has the size and the
// previous and next step (docs/plan.md §1.176).

import { errorText, isCode, Notice } from "../agents/ui";
import type { BuilderSession } from "./BuilderPanel";
import { Composer, Turns } from "./chat";

/** The Builder's size in the step panel, remembered per viewer in this browser. */
export const STEP_CHAT_KEY = "mezonas.builder.stepchat";

type ChatSize = "line" | "beside" | "max";

/**
 * How much of the side panel the Builder takes, as last chosen: half when unknown, and for the
 * box-only size this browser may still hold ("min"), which had no room for an answer.
 */
export function readStepChatSize(): ChatSize {
  try {
    const v = window.localStorage.getItem(STEP_CHAT_KEY);
    return v === "line" || v === "max" ? v : "beside";
  } catch {
    return "beside";
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
  size = "beside",
}: {
  session: BuilderSession;
  step: FocusedStep;
  size?: Exclude<ChatSize, "line"> | undefined;
}) {
  const turns = session.detail?.turns ?? [];
  const error = session.error ? (
    <Notice tone="warning" testId="builder-step-chat-error">
      {isCode(session.error, "builder_unavailable")
        ? `The Builder can't reach its model right now. ${errorText(session.error)}`
        : errorText(session.error)}
    </Notice>
  ) : null;
  return (
    <div
      data-testid="builder-step-chat"
      data-size={size}
      data-step={step.id}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
    >
      {/* The one part that scrolls: everything else in the panel's Builder is a line or the box. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden">
        <Turns
          turns={turns}
          thread={{ stepId: step.id }}
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
      <Composer
        compact
        testId="builder-step-chat-composer"
        placeholder="Ask about this step, or say what to change"
        busy={session.busy}
        onSend={(text) => session.send(text, { focusStepId: step.id })}
        clientId={session.detail?.session.clientId}
      />
    </div>
  );
}
