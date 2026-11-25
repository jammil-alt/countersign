// Request an action (docs/step-model-plan.md §10c; screen as approved in docs/design/step-model.html,
// section 4): a button that opens a small form, "What do you need it to do?", one text box, Cancel and
// Send. Whoever needs something an agent can't do yet says what, from a connector's page, an agent's
// page or the client's account. It becomes a request to our developers with the reuse check. In the
// back office the answer names the request; for a client it says only that we have it: they never
// meet the word "connector" or the queue. Existing components and tokens only.
import { ACTION_REQUEST_MAX, actionRequestRoutes } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApiClient } from "../api/useApi";
import { devQueuePath } from "../ops/devQueue";
import { Field, TextArea } from "./forms";
import { Button, ErrorNotice } from "./primitives";

const MIN = 10;

interface Words {
  open: string;
  label: string;
  hint: string;
  send: string;
  cancel: string;
  thanks: string;
  another: string;
}

const ENGLISH: Words = {
  open: "Request an action",
  label: "What do you need it to do?",
  hint: "We look at it, tell you if something already does it, and let you know when it's ready.",
  send: "Send",
  cancel: "Cancel",
  thanks: "Thank you. We have it, and we will tell you when it is ready.",
  another: "Ask for something else",
};

interface Props {
  /** Where it is asked from: the back office (names the request) or a client (says "we have it"). */
  as: "operator" | "client";
  /** The connector whose page it is asked from. */
  connector?: string | undefined;
  /** The agent whose page it is asked from. */
  agentId?: string | undefined;
  /** The client it is for. */
  clientId?: string | undefined;
  /** The words, for a client's screen (it reads them in its own language); English by default. */
  words?: Partial<Words>;
  testId?: string;
}

export function RequestAction({
  as,
  connector,
  agentId,
  clientId,
  words: given,
  testId = "request-action",
}: Props) {
  const words = { ...ENGLISH, ...given };
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ ref: string | null; again: boolean } | null>(null);
  const ready = what.trim().length >= MIN;

  function close() {
    setOpen(false);
    setWhat("");
    setError(null);
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      if (as === "client") {
        await api.call(actionRequestRoutes.portalRequestAction, { body: { what: what.trim() } });
        setDone({ ref: null, again: false });
      } else {
        const out = await api.call(actionRequestRoutes.opsRequestAction, {
          body: {
            what: what.trim(),
            ...(connector ? { connector } : {}),
            ...(agentId ? { agentId } : {}),
            ...(clientId ? { clientId } : {}),
          },
        });
        setDone({ ref: out.ref ?? out.duplicate?.ref ?? null, again: out.ref === null });
      }
      close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-2 text-sm" data-testid={`${testId}-done`}>
        <p className="text-ink">
          {as === "client"
            ? words.thanks
            : done.again
              ? `Someone already asked for this: ${done.ref}.`
              : `Sent to the Dev queue as ${done.ref}.`}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDone(null)}>
            {words.another}
          </Button>
          {as === "operator" && done.ref ? (
            <Link className="text-slate underline" to={devQueuePath(done.ref)}>
              Open it in the Dev queue
            </Link>
          ) : null}
        </div>
      </div>
    );
  }
  if (!open) {
    return (
      <Button
        size="sm"
        variant="secondary"
        className="self-start"
        data-testid={`${testId}-open`}
        onClick={() => setOpen(true)}
      >
        {words.open}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <Field label={words.label} hint={words.hint}>
        <TextArea
          aria-label={words.label}
          data-testid={`${testId}-text`}
          rows={4}
          maxLength={ACTION_REQUEST_MAX}
          value={what}
          onChange={(e) => setWhat(e.target.value)}
        />
      </Field>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" data-testid={`${testId}-cancel`} onClick={close}>
          {words.cancel}
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid={`${testId}-send`}
          disabled={busy || !ready}
          onClick={() => void send()}
        >
          {words.send}
        </Button>
      </div>
    </div>
  );
}
