// The Feedback button (docs/plan.md §1.8): floats over every screen. Press it and the page dims
// ("Tap where the problem is"); a tap drops a pin and records what was under it, the path and the
// viewport, and takes a picture of the page without this layer. A sheet shows the picture with the
// pin, a comment box, "Leave the picture off" and Send. "No particular spot" skips the pin;
// Escape or Cancel sends nothing. On phones the button is round and the composer full screen.
import { FEEDBACK_COMMENT_MAX, type FeedbackSubmission } from "@countersign/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useApiClient } from "../api/useApi";
import { Icon } from "../ui/icons";
import { Button, cx } from "../ui/primitives";
import { captureViewport, FEEDBACK_LAYER_ATTR } from "./capture";
import { describeElement } from "./describe";
import { type ScreenshotOutcome, sendFeedback } from "./upload";

type Pin = { x: number; y: number };
interface Draft {
  pin: Pin | null;
  target: string | null;
  path: string;
  viewport: { width: number; height: number };
  picture: Blob | null;
}
type Phase =
  | { kind: "idle" }
  | { kind: "picking" }
  | { kind: "capturing" }
  | { kind: "composing"; draft: Draft };

const layer = { [FEEDBACK_LAYER_ATTR]: "" };

// DECISION: a confirmation toast dismisses after 2.4 s (the design system's Toast); one that says
// the picture was lost stays 6 s so it can be read.
const TOAST_MS = 2400;
const TOAST_LONG_MS = 6000;

export function toastFor(outcome: ScreenshotOutcome): string {
  return outcome === "failed"
    ? "We saved your comment, but the picture didn't upload."
    : "Thanks. We got your feedback.";
}

/** The element under a point, ignoring the feedback layer itself. */
function elementAt(x: number, y: number): Element | null {
  const all = document.elementsFromPoint?.(x, y) ?? [];
  return all.find((el) => !el.closest(`[${FEEDBACK_LAYER_ATTR}]`)) ?? null;
}

export function FeedbackButton({ surface }: { surface: "ops" | "portal" }) {
  const location = useLocation();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [toast, setToast] = useState<{ text: string; ms: number } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms);
    return () => clearTimeout(t);
  }, [toast]);

  const cancel = useCallback(() => setPhase({ kind: "idle" }), []);

  useEffect(() => {
    if (phase.kind === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase.kind, cancel]);

  async function pinAt(pin: Pin | null) {
    const target = pin ? describeElement(elementAt(pin.x, pin.y)) : null;
    const path = `${location.pathname}${location.search}`;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPhase({ kind: "capturing" });
    // Let the dimmed layer go before drawing (it is filtered out too).
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const picture = await captureViewport();
    setPhase({ kind: "composing", draft: { pin, target, path, viewport, picture } });
  }

  return (
    <div {...layer} data-testid="feedback-layer">
      {phase.kind === "idle" ? (
        <button
          type="button"
          data-testid="feedback-button"
          aria-label="Feedback"
          onClick={() => setPhase({ kind: "picking" })}
          className={cx(
            "ds-btn ds-btn--secondary fixed right-4 bottom-4 z-40 border border-line bg-surface",
            "max-sm:size-12 max-sm:rounded-full max-sm:p-0",
          )}
        >
          <Icon name="message" />
          <span className="max-sm:sr-only">Feedback</span>
        </button>
      ) : null}

      {phase.kind === "picking" ? <PinPicker onPin={pinAt} onCancel={cancel} /> : null}

      {phase.kind === "capturing" ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="ds-scrim" />
          <p
            data-testid="feedback-capturing"
            className="relative rounded-sm bg-surface px-4 py-3 text-sm text-ink elevation-pop"
          >
            Taking the picture…
          </p>
        </div>
      ) : null}

      {phase.kind === "composing" ? (
        <Composer
          surface={surface}
          draft={phase.draft}
          onCancel={cancel}
          onSent={(outcome) => {
            setPhase({ kind: "idle" });
            setToast({
              text: toastFor(outcome),
              ms: outcome === "failed" ? TOAST_LONG_MS : TOAST_MS,
            });
          }}
        />
      ) : null}

      {toast ? (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2" role="status">
          <span data-testid="feedback-toast" className="ds-toast leading-snug">
            {toast.text}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PinPicker({
  onPin,
  onCancel,
}: {
  onPin: (pin: Pin | null) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        data-testid="feedback-pick-area"
        aria-label="Tap where the problem is"
        className="ds-scrim block cursor-crosshair border-0 p-0"
        onClick={(e) => onPin({ x: e.clientX, y: e.clientY })}
      />
      <div className="pointer-events-none absolute inset-x-0 top-6 flex justify-center px-4">
        <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 elevation-pop">
          <p className="font-medium text-ink">Tap where the problem is</p>
          <Button size="sm" data-testid="feedback-no-spot" onClick={() => onPin(null)}>
            No particular spot
          </Button>
          <Button size="sm" variant="ghost" data-testid="feedback-pick-cancel" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function Composer({
  surface,
  draft,
  onCancel,
  onSent,
}: {
  surface: "ops" | "portal";
  draft: Draft;
  onCancel: () => void;
  onSent: (outcome: ScreenshotOutcome) => void;
}) {
  const client = useApiClient();
  const [comment, setComment] = useState("");
  const [leaveOff, setLeaveOff] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pictureUrl, setPictureUrl] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!draft.picture || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(draft.picture);
    setPictureUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [draft.picture]);

  useEffect(() => textRef.current?.focus(), []);

  async function send() {
    const text = comment.trim();
    if (!text) {
      setError("Say what's wrong, or what would help.");
      textRef.current?.focus();
      return;
    }
    setSending(true);
    setError(null);
    const submission: FeedbackSubmission = {
      comment: text,
      path: draft.path.slice(0, 2000),
      viewport: draft.viewport,
      pin: draft.pin,
      target: draft.target,
    };
    try {
      const { screenshot } = await sendFeedback(
        client,
        surface,
        submission,
        leaveOff ? null : draft.picture,
      );
      onSent(screenshot);
    } catch {
      setSending(false);
      setError("We couldn't send that. Try again.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="ds-scrim" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        data-testid="feedback-composer"
        className={cx(
          "ds-dialog flex max-h-[calc(100vh-32px)] w-[560px] flex-col",
          "max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none",
        )}
      >
        <div className="ds-dialog__body min-h-0 flex-1 overflow-y-auto">
          <div>
            <h2 id="feedback-title" className="type-subheading text-ink">
              Send feedback
            </h2>
            <p className="text-sm text-ink-muted">We read every one.</p>
          </div>
          {draft.picture && !leaveOff ? (
            <PinnedPicture
              src={pictureUrl}
              pin={draft.pin}
              viewport={draft.viewport}
              testId="feedback-picture"
            />
          ) : (
            <p
              data-testid="feedback-no-picture"
              className="rounded-sm border border-dashed border-line-strong px-3 py-4 text-sm text-ink-muted"
            >
              {leaveOff
                ? "The picture stays off."
                : "We couldn't take a picture of this page. Your comment still helps."}
            </p>
          )}
          {draft.target ? (
            <p data-testid="feedback-target" className="text-sm text-ink-muted">
              Pinned: <span className="text-ink">{draft.target}</span>
            </p>
          ) : null}
          <label className="ds-field">
            <span className="text-sm font-medium text-ink">What's wrong, or what would help?</span>
            <textarea
              ref={textRef}
              data-testid="feedback-comment"
              value={comment}
              maxLength={FEEDBACK_COMMENT_MAX}
              rows={4}
              onChange={(e) => setComment(e.target.value)}
              aria-invalid={error ? true : undefined}
              className={cx("ds-textarea w-full leading-relaxed", error && "ds-input--error")}
            />
            {error ? (
              <span data-testid="feedback-error" className="ds-error text-sm">
                {error}
              </span>
            ) : null}
          </label>
          {draft.picture ? (
            // biome-ignore lint/a11y/useSemanticElements: the design system's Checkbox is a button with role=checkbox.
            <button
              type="button"
              role="checkbox"
              aria-checked={leaveOff}
              data-testid="feedback-leave-picture-off"
              onClick={() => setLeaveOff((v) => !v)}
              className="ds-choice"
            >
              <span className="ds-check">{leaveOff ? "✓" : ""}</span>
              Leave the picture off
            </button>
          ) : null}
        </div>
        <div className="ds-dialog__foot">
          <Button variant="ghost" data-testid="feedback-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="feedback-send"
            disabled={sending}
            onClick={() => void send()}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A screenshot with its pin drawn where it was dropped. */
export function PinnedPicture({
  src,
  pin,
  viewport,
  testId,
}: {
  src: string | null;
  pin: Pin | null;
  viewport: { width: number; height: number };
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="relative overflow-hidden rounded-sm border border-line bg-surface-subtle"
      style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}
    >
      {src ? (
        <img src={src} alt="The page when feedback was sent" className="block w-full" />
      ) : null}
      {pin ? (
        <span
          data-testid={testId ? `${testId}-pin` : undefined}
          aria-hidden
          className="absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-copper bg-copper-tint"
          style={{
            left: `${(pin.x / viewport.width) * 100}%`,
            top: `${(pin.y / viewport.height) * 100}%`,
          }}
        />
      ) : null}
    </div>
  );
}
