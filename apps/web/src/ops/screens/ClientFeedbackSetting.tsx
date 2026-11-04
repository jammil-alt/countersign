// The client page's switch for the portal's Feedback button: off by default; the operator turns it
// on or off with a reason, and the page shows who changed it and why. Clients can't change it.
import { FEEDBACK_REASON_MAX } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Field, TextInput } from "../../ui/forms";
import { Badge, Button, Card, ErrorNotice, SectionLabel } from "../../ui/primitives";

export function ClientFeedbackSetting({ clientId }: { clientId: string }) {
  const client = useApiClient();
  const { data, error, reload } = useApi(apiRoutes.opsClientFeedback, {
    params: { id: clientId },
  });
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const next = !data.enabled;

  async function save() {
    const text = reason.trim();
    if (!text) {
      setProblem("Give a reason.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await client.call(apiRoutes.opsSetClientFeedback, {
        params: { id: clientId },
        body: { enabled: next, reason: text },
      });
      setReason("");
      reload();
    } catch {
      setProblem("We couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8" data-testid="ops-client-feedback">
      <SectionLabel>Feedback button</SectionLabel>
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-ink">
            {data.enabled
              ? "The portal shows the Feedback button. What they send shows in Feedback."
              : "The portal has no Feedback button."}
          </p>
          <Badge tone={data.enabled ? "positive" : "neutral"} testId="ops-client-feedback-state">
            {data.enabled ? "On" : "Off"}
          </Badge>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field
            label={next ? "Why switch it on?" : "Why switch it off?"}
            error={problem ?? undefined}
            className="min-w-64 flex-1"
            testId="ops-client-feedback-reason"
          >
            <TextInput
              data-testid="ops-client-feedback-reason"
              value={reason}
              maxLength={FEEDBACK_REASON_MAX}
              invalid={!!problem}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Button
            variant={next ? "primary" : "secondary"}
            data-testid="ops-client-feedback-toggle"
            disabled={busy}
            onClick={() => void save()}
          >
            {next ? "Switch on" : "Switch off"}
          </Button>
        </div>
        {data.changes.length > 0 ? (
          <ul
            className="mt-4 flex flex-col gap-1 text-sm text-ink-muted"
            data-testid="ops-client-feedback-history"
          >
            {data.changes.map((c) => (
              <li key={c.id}>
                {c.enabled ? "Switched on" : "Switched off"} by{" "}
                {c.by?.name ?? c.by?.email ?? "someone"} on{" "}
                {new Date(c.createdAt).toLocaleDateString()}:{" "}
                <span className="text-ink">{c.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </section>
  );
}
