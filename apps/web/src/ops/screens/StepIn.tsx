// P-6: step in on a client's open item (docs/plan.md §1.68). Day to day the client's team answers
// it; we oversee, and step in only when we must, always with a reason the client reads ("Mezonas,
// on your behalf"). Approve and reject take the client's own path; a question takes an answer; a
// message waiting for approval can be changed before it is approved; anything can be passed to
// someone else at the client. Never a request for a code: only the client's code releases it.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { Button, ErrorNotice } from "../../ui/primitives";

interface StepInItem {
  id: string;
  tenantId: string;
  kind: string;
  status: string;
  subjectType: string | null;
  payload: Record<string, unknown>;
}

/** Whether we may step in here: open, and not a request for the client's own code. */
export function canStepIn(item: StepInItem): boolean {
  return item.status === "open" && item.subjectType !== "access_release";
}

function draftMessage(payload: Record<string, unknown>): string | null {
  if (typeof payload.reachOutId !== "string") return null;
  for (const key of ["converse", "reachOut"] as const) {
    const v = payload[key] as { message?: unknown } | undefined;
    if (v && typeof v.message === "string") return v.message;
  }
  return "";
}

export function StepIn({ item, onDone }: { item: StepInItem; onDone: () => void }) {
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [answer, setAnswer] = useState("");
  const draft = draftMessage(item.payload);
  const [message, setMessage] = useState(draft ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!canStepIn(item)) return null;
  const id = `step-in-${item.id}`;
  const ready = !busy && reason.trim().length > 0;
  const send = async (
    body:
      | { action: "approve"; message?: string }
      | { action: "reject" }
      | { action: "answer"; answer: string }
      | { action: "reassign"; to: { kind: "role"; role: "client_admin" | "client_user" } },
  ) => {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.opsStepInInbox, {
        params: { id: item.tenantId, itemId: item.id },
        body: { ...body, reason: reason.trim() },
      });
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <Button data-testid={`${id}-open`} size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Step in
      </Button>
    );
  }
  const changed = draft !== null && message.trim() !== draft.trim() && message.trim().length > 0;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3" data-testid={id}>
      <p className="text-sm text-ink-muted">
        This is the client's to answer. Step in only when you must: they see that we did, and why.
      </p>
      <label className="ds-field" htmlFor={`${id}-reason`}>
        <span className="text-sm font-medium text-ink">Why we're stepping in</span>
        <input
          id={`${id}-reason`}
          data-testid={`${id}-reason`}
          className="ds-input text-sm"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {draft !== null ? (
        <label className="ds-field" htmlFor={`${id}-message`}>
          <span className="text-sm font-medium text-ink">The message that goes</span>
          <textarea
            id={`${id}-message`}
            data-testid={`${id}-message`}
            className="ds-textarea text-sm"
            rows={3}
            maxLength={1600}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
      ) : null}
      {item.kind === "request" ? (
        <label className="ds-field" htmlFor={`${id}-answer`}>
          <span className="text-sm font-medium text-ink">Answer</span>
          <input
            id={`${id}-answer`}
            data-testid={`${id}-answer`}
            className="ds-input text-sm"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {item.kind === "request" ? (
          <Button
            data-testid={`${id}-answer-send`}
            size="sm"
            variant="primary"
            disabled={!ready || answer.trim().length === 0}
            onClick={() => send({ action: "answer", answer: answer.trim() })}
          >
            Answer for them
          </Button>
        ) : (
          <Button
            data-testid={`${id}-approve`}
            size="sm"
            variant="primary"
            disabled={!ready}
            onClick={() =>
              send(changed ? { action: "approve", message: message.trim() } : { action: "approve" })
            }
          >
            {changed ? "Approve with this message" : "Approve for them"}
          </Button>
        )}
        <Button
          data-testid={`${id}-reject`}
          size="sm"
          disabled={!ready}
          onClick={() => send({ action: "reject" })}
        >
          {item.kind === "request" ? "Decline for them" : "Reject for them"}
        </Button>
        <Button
          data-testid={`${id}-pass-admin`}
          size="sm"
          variant="ghost"
          disabled={!ready}
          onClick={() => send({ action: "reassign", to: { kind: "role", role: "client_admin" } })}
        >
          Pass to the client admin
        </Button>
        <Button
          data-testid={`${id}-pass-team`}
          size="sm"
          variant="ghost"
          disabled={!ready}
          onClick={() => send({ action: "reassign", to: { kind: "role", role: "client_user" } })}
        >
          Pass to their team
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}
