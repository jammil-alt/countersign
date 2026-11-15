// The Calls panel on `/ops/clients/:clientId/messaging` (plan §1.23): the operator turns calls on for
// the client, sends a number's incoming calls to us, sets where unanswered calls are forwarded, sees
// who answers a call ringing in now (and why), and the client's recent calls. Agents place calls only
// through `call.place`, behind approval; nothing here is an agent's.
import type { CallOutcome, CallSummary, CallsSetup } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Field, TextInput } from "../../ui/forms";
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Loading,
  SectionLabel,
  type Tone,
} from "../../ui/primitives";

const OUTCOME: Record<CallOutcome, { label: string; tone: Tone }> = {
  answered: { label: "Answered by an agent", tone: "positive" },
  voicemail: { label: "Voicemail", tone: "neutral" },
  forwarded: { label: "Forwarded", tone: "neutral" },
  no_answer: { label: "No answer", tone: "neutral" },
  busy: { label: "Busy", tone: "neutral" },
  failed: { label: "Failed", tone: "risk" },
  canceled: { label: "Canceled", tone: "neutral" },
};

function message(error: unknown): string {
  return isApiError(error) ? error.message : "That didn't work. Try again.";
}

function length(secs: number | null): string {
  if (secs === null) return "";
  return secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`;
}

type Loaded = { setup: CallsSetup; calls: CallSummary[] };

export function CallsPanel({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const res = useApi(apiRoutes.opsCalls, { params: { id: clientId } });
  const [override, setOverride] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forward, setForward] = useState<string | null>(null);
  const data = override ?? res.data;
  const params = { id: clientId };

  async function act(call: () => Promise<Loaded>) {
    setBusy(true);
    setError(null);
    try {
      setOverride(await call());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (res.loading && !data) return <Loading label="Loading calls…" />;
  if (res.error && !data) return <ErrorNotice error={res.error} onRetry={res.reload} />;
  if (!data) return null;
  const { setup, calls } = data;
  const forwardValue = forward ?? setup.forwardTo ?? "";

  function saveForward(e: FormEvent) {
    e.preventDefault();
    void act(() =>
      api.call(apiRoutes.opsCallsSettings, {
        params,
        body: { enabled: true, forwardTo: forwardValue.trim() || null },
      }),
    );
  }

  return (
    <Card className="p-5" testId="ops-calls">
      <SectionLabel
        action={
          setup.enabled ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api.call(apiRoutes.opsCallsSettings, {
                    params,
                    body: { enabled: false, forwardTo: null },
                  }),
                )
              }
              data-testid="ops-calls-off"
            >
              Turn calls off
            </Button>
          ) : null
        }
      >
        Calls
      </SectionLabel>
      {error ? (
        <div role="alert" className="ds-banner mb-3">
          {error}
        </div>
      ) : null}
      {!setup.available ? (
        <p className="mb-3 text-ink-muted" data-testid="ops-calls-unavailable">
          Voice agents aren't set up for Mezonas yet. An engineer adds our ElevenLabs key. Incoming
          calls can still go to voicemail or be forwarded.
        </p>
      ) : null}
      {!setup.twilio ? (
        <p className="text-ink-muted">Set up the client's Twilio subaccount first.</p>
      ) : !setup.enabled ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-ink-muted">
            Calls are off. Turned on, agents can call contacts who agreed to calls, after approval,
            and every number that takes calls sends them to us: to an agent, a forward or voicemail.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(() =>
                api.call(apiRoutes.opsCallsSettings, {
                  params,
                  body: { enabled: true, forwardTo: null },
                }),
              )
            }
            data-testid="ops-calls-on"
          >
            Turn calls on
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {setup.inbound ? (
            <p className="text-sm" data-testid="ops-calls-inbound">
              <span className="text-ink-muted">Calls ringing in now: </span>
              <span className="text-ink">{setup.inbound.reason}.</span>
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {setup.numbers.map((n) => (
              <li
                key={n.sid}
                className="flex flex-wrap items-center justify-between gap-3"
                data-testid={`ops-calls-number-${n.phoneNumber}`}
              >
                <span className="figures text-ink">{n.phoneNumber}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {n.answering ? <Badge tone="positive">Calls come to us</Badge> : null}
                  {n.voice && !n.answering ? (
                    <span className="text-sm text-ink-muted">
                      Callers can't get through: nothing answers this number
                    </span>
                  ) : null}
                  {n.voice ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          api.call(apiRoutes.opsCallsNumber, {
                            params: { id: clientId, sid: n.sid },
                            body: { answering: !n.answering },
                          }),
                        )
                      }
                    >
                      {n.answering ? "Stop taking its calls" : "Take its calls"}
                    </Button>
                  ) : (
                    <Badge>No calls on this number</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <form className="flex flex-wrap items-end gap-3" onSubmit={saveForward}>
            <Field
              label="Forward unanswered calls to"
              hint="In international form. Empty: callers can leave a voicemail."
            >
              <TextInput
                value={forwardValue}
                placeholder="+15551234567"
                onChange={(e) => setForward(e.target.value)}
                data-testid="ops-calls-forward"
              />
            </Field>
            <Button type="submit" size="sm" disabled={busy} data-testid="ops-calls-forward-save">
              Save
            </Button>
          </form>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-[200px_minmax(0,1fr)]">
            <dt className="text-ink-muted">ElevenLabs post-call webhook</dt>
            <dd className="reference break-all">{setup.webhooks.postCall}</dd>
          </dl>
        </div>
      )}

      <div className="mt-6">
        <h3 className="eyebrow mb-2 text-ink-muted">Recent calls</h3>
        {calls.length === 0 ? (
          <p className="text-sm text-ink-muted">No calls yet.</p>
        ) : (
          <ol className="flex flex-col gap-3" data-testid="ops-calls-list">
            {calls.map((c) => (
              <li key={c.sid} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-ink">
                    {c.direction === "in" ? "From" : "To"}{" "}
                    {c.contactName ?? (c.direction === "in" ? c.from : c.to)}
                  </span>
                  {c.outcome ? (
                    <Badge tone={OUTCOME[c.outcome].tone}>{OUTCOME[c.outcome].label}</Badge>
                  ) : null}
                  <span className="figures text-ink-muted">{length(c.durationSecs)}</span>
                  {c.agentName ? <span className="text-ink-muted">· {c.agentName}</span> : null}
                  <span className="text-ink-muted">· {new Date(c.startedAt).toLocaleString()}</span>
                </div>
                {/* Written from what was said: shown as text, never as markup. */}
                {c.summary ? (
                  <p className="mt-0.5 whitespace-pre-wrap text-ink">{c.summary}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
