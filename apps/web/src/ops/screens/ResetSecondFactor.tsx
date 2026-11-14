// A person's sign-in reset (docs/plan.md §1.100), on a client's People list in the back office:
// for someone who lost their phone and their recovery codes. It removes their methods and recovery
// codes (and the authenticator at Twilio); they set up again at their next sign-in. A reason is
// required, and the reset is an audit row. Operators only; the API checks it is a person in a
// client this operator serves.
import { useState } from "react";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { Field, TextInput } from "../../ui/forms";
import { Button } from "../../ui/primitives";

export function ResetSecondFactor({ userId, name }: { userId: string; name: string }) {
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function reset() {
    if (reason.trim().length < 3) {
      setProblem("Say why, in a few words.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.call(apiRoutes.opsSecondFactorReset, {
        params: { id: userId },
        body: { reason: reason.trim() },
      });
      setDone(
        res.removed === 0
          ? `${name} had no sign-in methods to reset.`
          : `Reset. ${name} sets up a new method at their next sign-in.`,
      );
      setOpen(false);
      setReason("");
    } catch (err) {
      setProblem(isApiError(err) ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className="text-sm text-ink-muted" role="status" data-testid={`reset-2fa-done-${userId}`}>
        {done}
      </p>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        className="text-sm text-link hover:underline"
        onClick={() => setOpen(true)}
        data-testid={`reset-2fa-${userId}`}
      >
        Reset sign-in codes
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 pt-2" data-testid={`reset-2fa-form-${userId}`}>
      <p className="text-sm text-ink">
        For a lost phone. {name}'s methods and recovery codes are removed; they set up again at
        their next sign-in. Check it is really them first.
      </p>
      <Field label="Why" error={problem ?? undefined}>
        <TextInput
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder="Lost phone, confirmed by a call"
          data-testid={`reset-2fa-reason-${userId}`}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => void reset()}
          data-testid={`reset-2fa-confirm-${userId}`}
        >
          Reset
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
