// R5 (docs/plan.md §1.86; ARCHITECTURE §10.14 "Undo"): an answer that came after the run went
// ahead, on its inbox item, in the portal's Inbox and the back office's. A late no to a write that
// can be taken back offers "Undo this change", which calls the surface's undo route; only that
// press runs the undo, never anything by itself. A write that can't be taken back (a sent message)
// says so. The back office also shows the tool's own undo line and the server's reasons as they are.
import { useState } from "react";
import type { UndoChangeResult } from "../api/routes";
import type { PlainKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { shortTime } from "../runs/format";
import { Button, ErrorNotice } from "../ui/primitives";
import { type LateState, lateAnswerOf, lateState, undoOfferOf } from "./late";

const STATE_WORDS: Record<LateState, PlainKey> = {
  yes: "inbox.late.yes",
  offer: "inbox.late.offer",
  done: "inbox.late.done",
  failed: "inbox.late.failed",
  none: "inbox.late.none",
  nothing: "inbox.late.nothing",
};

/** Colour by meaning: waiting on you (signal), done (positive), errors (risk), else muted. */
const STATE_TONE: Record<LateState, string> = {
  yes: "text-ink-muted",
  offer: "text-signal-ink",
  done: "ui-tone-positive",
  failed: "ui-tone-risk",
  none: "text-ink-muted",
  nothing: "text-ink-muted",
};

const REFUSAL_WORDS: Record<string, PlainKey> = {
  changed_since: "inbox.late.refused.changed_since",
  record_gone: "inbox.late.refused.record_gone",
  already_undone: "inbox.late.refused.already_undone",
};

export function LateAnswer({
  payload,
  surface,
  onUndo,
  testId = "inbox-late",
}: {
  payload: Record<string, unknown>;
  surface: "portal" | "ops";
  /** Presses Undo through the surface's route; null where this person may not. */
  onUndo: (() => Promise<UndoChangeResult>) | null;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<UndoChangeResult["undo"] | null>(null);
  const late = lateAnswerOf(payload);
  if (!late) return null;
  const offer = undoOfferOf(payload);
  // What the press just did wins over the payload until the item reloads.
  const state: LateState =
    result?.status === "done"
      ? "done"
      : result?.status === "failed"
        ? "failed"
        : lateState(late, offer);
  const when = shortTime(late.at, undefined, i18n);
  const refusal =
    result?.status === "refused"
      ? surface === "ops"
        ? result.reason
        : t(REFUSAL_WORDS[result.code] ?? "inbox.late.refused.other")
      : null;
  const failedReason =
    surface === "ops"
      ? result?.status === "failed"
        ? result.reason
        : (offer?.reason ?? null)
      : null;

  async function press() {
    if (!onUndo) return;
    setBusy(true);
    setError(null);
    try {
      setResult((await onUndo()).undo);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-line px-4 py-3"
      data-testid={testId}
      data-state={state}
    >
      <p className="text-sm font-medium text-ink" data-testid={`${testId}-answer`}>
        {t(late.approved ? "inbox.late.answeredYes" : "inbox.late.answeredNo", { time: when })}
      </p>
      <p className={`text-sm ${STATE_TONE[state]}`} data-testid={`${testId}-state`}>
        {t(STATE_WORDS[state])}
      </p>
      {surface === "ops" && offer && state === "offer" ? (
        <p className="text-sm text-ink-muted" data-testid={`${testId}-tool`}>
          {offer.text}
        </p>
      ) : null}
      {failedReason ? <p className="text-sm ui-tone-risk">{failedReason}</p> : null}
      {refusal ? (
        <p className="text-sm ui-tone-risk" data-testid={`${testId}-refused`}>
          {refusal}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {state === "offer" && onUndo ? (
        <div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void press()}
            data-testid={`${testId}-undo`}
          >
            {t("inbox.late.undo")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
