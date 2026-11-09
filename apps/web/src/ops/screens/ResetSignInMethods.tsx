// "Reset sign-in methods" on a person in a client's People (docs/plan.md §1.83): for someone who
// lost their phone and their recovery codes. Their authenticator app, phone numbers and recovery
// codes are removed, with a reason for the audit log; they set up a method at their next sign-in.
// Back office only, so English.
import type { Member } from "@countersign/core";
import { useEffect, useRef, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { Field, TextArea } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Button, cx, ErrorNotice } from "../../ui/primitives";

export function ResetSignInMethods({ member, testId }: { member: Member; testId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-haspopup="dialog"
        data-testid={testId}
        onClick={() => setOpen(true)}
      >
        Reset sign-in methods
      </Button>
      {open ? (
        <ResetDialog member={member} onClose={() => setOpen(false)} testId={`${testId}-dialog`} />
      ) : null}
    </>
  );
}

function ResetDialog({
  member,
  onClose,
  testId,
}: {
  member: Member;
  onClose: () => void;
  testId: string;
}) {
  const api = useApiClient();
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const who = member.name ?? member.email;

  async function reset() {
    if (!reason.trim()) {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.opsUserSecondFactorReset, {
        params: { id: member.userId },
        body: { reason: reason.trim() },
      });
      setDone(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const titleId = `${testId}-title`;
  const reasonId = `${testId}-reason`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="ds-scrim" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={cx(
          "ds-dialog flex max-h-[calc(100vh-32px)] w-[480px] flex-col",
          "max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none",
        )}
      >
        <div className="ds-dialog__body min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-start justify-between gap-3">
            <h2
              id={titleId}
              ref={heading}
              tabIndex={-1}
              className="type-subheading text-ink outline-none"
            >
              Reset sign-in methods
            </h2>
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--sm"
              aria-label="Close"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
          {done ? (
            <p role="status" className="text-ink" data-testid={`${testId}-done`}>
              Done: they'll set up a method at their next sign-in.
            </p>
          ) : (
            <>
              <p className="text-ink">
                We remove {who}'s authenticator app, phone numbers and recovery codes. They set up a
                method again at their next sign-in. Do this only once you know it's them asking.
              </p>
              <Field
                label="Reason"
                hint="Kept in the audit log, e.g. lost their phone and recovery codes."
                error={missing ? "Say why you're resetting them." : undefined}
                testId={`${testId}-reason`}
              >
                <TextArea
                  id={reasonId}
                  data-testid={`${testId}-reason`}
                  rows={2}
                  maxLength={500}
                  required
                  value={reason}
                  invalid={missing}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setMissing(false);
                  }}
                />
              </Field>
              {error ? <ErrorNotice error={error} /> : null}
            </>
          )}
        </div>
        <div className="ds-dialog__foot">
          {done ? (
            <Button variant="primary" data-testid={`${testId}-close`} onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" data-testid={`${testId}-cancel`} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid={`${testId}-confirm`}
                disabled={busy}
                onClick={() => void reset()}
              >
                {busy ? "Resetting…" : "Reset"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
