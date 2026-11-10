// "Fix" on a workflow problem: a dialog that says what's wrong in plain words straight away, then
// asks the Builder (the same conversation as the side panel's) to explain the cause and propose a
// fix without changing anything. The operator can have it make the fix, ask more, or go to the
// step. Whatever the Builder changes lands on the canvas as an undoable edit, as from the panel.
// DECISION: Fix talks to the Builder, not to a model of its own (2026-11-10): the Builder already
// knows the draft and the platform's parts, keeps approval on, and its changes come with Undo.
import type { ValidationCode, ValidationError } from "@countersign/core";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../ui/icons";
import { Button } from "../../ui/primitives";
import { errorText, isCode, Notice } from "../agents/ui";
import type { BuilderSession } from "./BuilderPanel";
import { BuilderMark, Composer, Turns } from "./chat";

/** A problem to fix: where it is, what it says, and the validator's own words for the Builder. */
export interface FixRequest {
  error: ValidationError;
  place: string;
  text: string;
  /** The validator's messages behind this line (several when references were grouped). */
  raw: string[];
  workflowName: string;
}

/** Why a kind of problem happens, in a sentence, shown before the Builder answers. */
const WHY: Partial<Record<ValidationCode, string>> = {
  template_scope:
    "A step can only use what the trigger gave or what a step before it on the same path gave back. A step that runs later, on another path, or was removed can't be read yet.",
  template_path:
    "The step reads a field that the earlier step doesn't give back, so it would have nothing to use when it runs.",
  template_syntax: "A value has a reference that isn't written the way the workflow reads them.",
  input_missing: "The skill or tool needs this value to run, and nothing fills it yet.",
  input_unknown: "The value is set, but the skill or tool doesn't take it.",
  rule_invalid: "A rule needs a field to check, how to compare it and, for most checks, a value.",
  rules_empty: "A path needs at least one rule, or it would always be taken.",
  unknown_skill:
    "The step uses a skill that isn't in the library any more, or isn't installed here.",
  skill_not_allowed: "The agent doesn't have this skill among the ones it may use.",
  unknown_tool: "The step uses a tool that isn't connected or doesn't exist any more.",
};

/** What the Builder is asked first: explain and propose, change nothing. */
export function fixPrompt(fix: FixRequest): string {
  const details = fix.raw.map((r) => `- ${r}`).join("\n");
  return [
    `Fix: “${fix.place}” in “${fix.workflowName}”. ${fix.text}`,
    "",
    "Explain in plain words what isn't working and what causes it, then propose a fix. Don't change the workflow yet.",
    "",
    `What the check said (field ${fix.error.field || "the step"}, step ${fix.error.stepId ?? "none"}):`,
    details,
  ].join("\n");
}

export function FixDialog({
  fix,
  session,
  onClose,
  onShowStep,
}: {
  fix: FixRequest;
  session: BuilderSession;
  onClose(): void;
  /** Selects the step on the canvas (and opens it in the side panel). */
  onShowStep?: (() => void) | undefined;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The turns already in the conversation when the dialog opened: only this fix's are shown.
  const [before] = useState(() => new Set((session.detail?.turns ?? []).map((t) => t.id)));
  const asked = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  // Ask once when it opens (a ref, so a re-render or Strict Mode doesn't ask twice).
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once, when the dialog opens.
  useEffect(() => {
    heading.current?.focus();
    if (asked.current) return;
    asked.current = true;
    void session.send(prompt);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The first ask is long (it carries the check's own words for the Builder): here it reads short.
  const prompt = fixPrompt(fix);
  const SHORT = "Explain this and propose a fix.";
  const turns = (session.detail?.turns ?? [])
    .filter((t) => !before.has(t.id))
    .map((t) => (t.role === "operator" && t.text === prompt ? { ...t, text: SHORT } : t));
  const pending = session.pending === prompt ? SHORT : session.pending;
  const answered = turns.some((t) => t.role === "builder");
  const why = WHY[fix.error.code];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="ds-scrim ui-scrim-button"
        onClick={() => close.current()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="builder-fix"
        className="ds-dialog flex max-h-[calc(100vh-32px)] w-[600px] flex-col max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <BuilderMark />
            <h2
              id={titleId}
              ref={heading}
              tabIndex={-1}
              className="truncate type-subheading text-ink outline-none"
            >
              Fix “{fix.place}”
            </h2>
          </div>
          <Button
            variant="ghost"
            className="ds-btn--icon shrink-0"
            aria-label="Close"
            data-testid="builder-fix-close"
            onClick={() => close.current()}
          >
            <Icon name="close" size={20} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <section className="ds-banner block" data-testid="builder-fix-problem">
            <p className="font-medium">{fix.text}</p>
            {why ? <p className="mt-1">{why}</p> : null}
          </section>
          <Turns
            turns={turns}
            busy={session.busy}
            pending={pending}
            {...(session.inSync ? { onUndo: session.undo } : {})}
            undoOff="You've changed the workflow since. Undo it on the canvas."
            empty={
              session.error ? null : (
                <p className="text-sm text-ink-muted">Asking the Builder what causes it…</p>
              )
            }
          />
          {session.error ? (
            <Notice tone="warning" testId="builder-fix-error">
              {isCode(session.error, "builder_unavailable")
                ? `The Builder can't reach its model right now, so it can't propose a fix. ${errorText(session.error)}`
                : errorText(session.error)}
            </Notice>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="builder-fix-apply"
              disabled={!answered || session.busy}
              onClick={() => void session.send("Go ahead and make the fix you proposed.")}
            >
              Make this fix
            </Button>
            {onShowStep ? (
              <Button
                size="sm"
                data-testid="builder-fix-show"
                onClick={() => {
                  onShowStep();
                  close.current();
                }}
              >
                Show the step
              </Button>
            ) : null}
            <span className="text-xs text-ink-muted">
              Changes land on the canvas with Undo. Nothing is saved until you save.
            </span>
          </div>
          <Composer
            testId="builder-fix-composer"
            placeholder="Ask a question or suggest another fix"
            busy={session.busy}
            onSend={session.send}
          />
        </div>
      </div>
    </div>
  );
}
