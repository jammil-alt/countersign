// P-6: take a live conversation over, or end it (docs/plan.md §1.68; ARCHITECTURE §10.12). Shared
// by the back office's run page (the operator, who must give a reason) and the portal's (the
// conversation's approver). The words come from the caller: English in the back office, the
// catalog in the portal.
import { useState } from "react";
import { Button, ErrorNotice } from "../ui/primitives";

export interface ConversationControlWords {
  takeOver: string;
  end: string;
  reason: string;
  hint: string;
}

export function ConversationControls({
  words,
  reasonRequired,
  testId,
  onAct,
}: {
  words: ConversationControlWords;
  reasonRequired: boolean;
  testId: string;
  onAct: (action: "take_over" | "end", reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready = !busy && (!reasonRequired || reason.trim().length > 0);
  const act = async (action: "take_over" | "end") => {
    setBusy(true);
    setError(null);
    try {
      await onAct(action, reason.trim());
      setReason("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <p className="text-sm text-ink-muted">{words.hint}</p>
      <label className="ds-field" htmlFor={`${testId}-reason`}>
        <span className="text-sm font-medium text-ink">{words.reason}</span>
        <input
          id={`${testId}-reason`}
          data-testid={`${testId}-reason`}
          className="ds-input text-sm"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid={`${testId}-take-over`}
          size="sm"
          disabled={!ready}
          onClick={() => act("take_over")}
        >
          {words.takeOver}
        </Button>
        <Button
          data-testid={`${testId}-end`}
          size="sm"
          variant="ghost"
          disabled={!ready}
          onClick={() => act("end")}
        >
          {words.end}
        </Button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}
