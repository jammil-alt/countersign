// The client settings' Compliance card (docs/plan.md §1.33): HIPAA mode, switched on or off by the
// operator with a reason (refused while a vendor it needs has no signed BAA, and then the card says
// why), the vendors and whether each is covered, and the log of changes. Below it, retiring the
// client: a reason and the client's name typed again; afterwards, when its data can be purged.
import {
  type ClientCompliance,
  COMPLIANCE_REASON_MAX,
  RETIREMENT_PURGE_DAYS,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Field, TextInput } from "../../ui/forms";
import { Badge, Button, Card, ErrorNotice, SectionLabel } from "../../ui/primitives";

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The server's own words when it sent some (a 409 says why), else a plain retry. */
export function failureText(error: unknown, fallback: string): string {
  if (isApiError(error) && error.status >= 400 && error.message && error.message !== error.code) {
    return error.message;
  }
  return fallback;
}

/** "HIPAA mode switched on", "Retired": a change in the card's log. */
function changeText(c: ClientCompliance["changes"][number]): string {
  if (/hipaa/i.test(c.setting)) {
    return c.to === true ? "HIPAA mode switched on" : "HIPAA mode switched off";
  }
  if (/retire/i.test(c.setting)) return "Retired";
  return `${c.setting} changed`;
}

export function ClientComplianceSetting({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const { data, error, reload } = useApi(apiRoutes.opsClientCompliance, {
    params: { id: clientId },
  });
  const [current, setCurrent] = useState<ClientCompliance | undefined>(undefined);
  useEffect(() => setCurrent(data), [data]);

  return (
    <>
      <section className="mt-8" data-testid="ops-client-compliance">
        <SectionLabel>Compliance</SectionLabel>
        {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
        {current ? <Hipaa clientId={clientId} data={current} onChange={setCurrent} /> : null}
      </section>
      {current ? (
        <Retire clientId={clientId} clientName={clientName} data={current} onChange={setCurrent} />
      ) : null}
    </>
  );
}

function Hipaa({
  clientId,
  data,
  onChange,
}: {
  clientId: string;
  data: ClientCompliance;
  onChange: (next: ClientCompliance) => void;
}) {
  const api = useApiClient();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = !data.hipaa;
  const blocked = next && !data.readiness.ready;

  async function save() {
    const text = reason.trim();
    if (!text) {
      setProblem("Give a reason.");
      return;
    }
    setBusy(true);
    setProblem(null);
    setFailed(null);
    try {
      const result = await api.call(apiRoutes.opsClientComplianceSet, {
        params: { id: clientId },
        body: { hipaa: next, reason: text },
      });
      setReason("");
      onChange(result);
    } catch (error) {
      setFailed(failureText(error, "We couldn't save that. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">HIPAA mode</p>
          <p className="mt-1 text-sm text-ink-muted">
            {data.hipaa
              ? "On. This client's data goes only to vendors we have a signed BAA with."
              : "Off. Switch it on for a client whose records hold health information."}
          </p>
        </div>
        <Badge tone={data.hipaa ? "positive" : "neutral"} testId="ops-client-hipaa-state">
          {data.hipaa ? "On" : "Off"}
        </Badge>
      </div>

      {blocked ? (
        <div className="mt-4" data-testid="ops-client-hipaa-problems">
          <p className="text-sm text-ink">We can't switch it on yet:</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-ink-muted">
            {data.readiness.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field
          label={next ? "Why switch it on?" : "Why switch it off?"}
          error={problem ?? undefined}
          className="min-w-64 flex-1"
          testId="ops-client-hipaa-reason"
        >
          <TextInput
            data-testid="ops-client-hipaa-reason"
            value={reason}
            maxLength={COMPLIANCE_REASON_MAX}
            invalid={!!problem}
            disabled={blocked}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Button
          variant={next ? "primary" : "secondary"}
          data-testid="ops-client-hipaa-toggle"
          disabled={busy || blocked}
          onClick={() => void save()}
        >
          {next ? "Switch on" : "Switch off"}
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="ds-error mt-2 text-sm" data-testid="ops-client-hipaa-error">
          {failed}
        </p>
      ) : null}

      <div className="mt-5 border-t border-line pt-4">
        <p className="text-sm font-medium text-ink">Vendors</p>
        <p className="mt-1 text-sm text-ink-muted">
          Ours, not the client's own tools. A vendor is covered once its BAA is signed.
        </p>
        <ul className="mt-3 flex flex-col gap-2" data-testid="ops-client-processors">
          {data.processors.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3"
              data-testid={`ops-client-processor-${p.id}`}
            >
              <span className="text-ink">{p.name}</span>
              <Badge tone={p.covered ? "positive" : "neutral"}>
                {p.covered ? "Covered" : "Not covered"}
              </Badge>
            </li>
          ))}
        </ul>
      </div>

      {data.changes.length > 0 ? (
        <ul
          className="mt-5 flex flex-col gap-1 border-t border-line pt-4 text-sm text-ink-muted"
          data-testid="ops-client-compliance-history"
        >
          {data.changes.map((c) => (
            <li key={c.id}>
              {changeText(c)} by {c.by?.email ?? "someone"} on {day(c.createdAt)}:{" "}
              <span className="text-ink">{c.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function Retire({
  clientId,
  clientName,
  data,
  onChange,
}: {
  clientId: string;
  clientName: string;
  data: ClientCompliance;
  onChange: (next: ClientCompliance) => void;
}) {
  const api = useApiClient();
  const [reason, setReason] = useState("");
  const [name, setName] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = reason.trim() !== "" && name.trim() === clientName.trim();

  async function retire() {
    if (!ready) return;
    setBusy(true);
    setFailed(null);
    try {
      const result = await api.call(apiRoutes.opsClientRetire, {
        params: { id: clientId },
        body: { reason: reason.trim(), confirmName: name.trim() },
      });
      setReason("");
      setName("");
      onChange(result);
    } catch (error) {
      setFailed(failureText(error, "We couldn't retire this client. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8" data-testid="ops-client-retire">
      <SectionLabel>Retire client</SectionLabel>
      <Card className="p-5">
        {data.retiredAt ? (
          <div className="flex flex-wrap items-center gap-3">
            <Badge>Retired</Badge>
            <p className="text-ink" data-testid="ops-client-retired">
              Retired on {day(data.retiredAt)}
              {data.purgeAfter ? `; data can be purged after ${day(data.purgeAfter)}.` : "."}
            </p>
          </div>
        ) : (
          <>
            <p className="text-ink">
              Retiring {clientName} stops every sign-in and run, retires its agents and disconnects
              its tools. After {RETIREMENT_PURGE_DAYS} days we delete its files, then its records.
              This can't be undone.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <Field label="Why retire it?" className="min-w-64 flex-1">
                <TextInput
                  data-testid="ops-client-retire-reason"
                  value={reason}
                  maxLength={COMPLIANCE_REASON_MAX}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <Field label={`Type ${clientName} to confirm`} className="min-w-64 flex-1">
                <TextInput
                  data-testid="ops-client-retire-name"
                  value={name}
                  maxLength={200}
                  autoComplete="off"
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Button
                className="text-risk"
                data-testid="ops-client-retire-confirm"
                disabled={busy || !ready}
                onClick={() => void retire()}
              >
                Retire client
              </Button>
            </div>
          </>
        )}
        {failed ? (
          <p role="alert" className="ds-error mt-2 text-sm" data-testid="ops-client-retire-error">
            {failed}
          </p>
        ) : null}
      </Card>
    </section>
  );
}
