// The client settings' switch for the portal's Feedback button: off by default; the operator turns
// it on or off, and the card shows who changed it and when. No reason is asked for. Clients can't
// change it.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Badge, Button, Card, ErrorNotice } from "../../ui/primitives";

/** The log's own words, which say no more than the line they'd follow. */
const DEFAULT_REASONS = new Set(["Feedback button switched on", "Feedback button switched off"]);

export function ClientFeedbackSetting({ clientId }: { clientId: string }) {
  const client = useApiClient();
  const { data, error, reload } = useApi(apiRoutes.opsClientFeedback, {
    params: { id: clientId },
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const next = !data.enabled;

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      await client.call(apiRoutes.opsSetClientFeedback, {
        params: { id: clientId },
        body: { enabled: next },
      });
      reload();
    } catch {
      setProblem("We couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Feedback button" pad testId="ops-client-feedback">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-ink">
          {data.enabled
            ? "The portal shows the Feedback button. What they send shows in Feedback."
            : "The portal has no Feedback button."}
        </p>
        <div className="flex items-center gap-3">
          <Badge tone={data.enabled ? "positive" : "neutral"} testId="ops-client-feedback-state">
            {data.enabled ? "On" : "Off"}
          </Badge>
          <Button
            variant={next ? "primary" : "secondary"}
            data-testid="ops-client-feedback-toggle"
            disabled={busy}
            onClick={() => void save()}
          >
            {next ? "Switch on" : "Switch off"}
          </Button>
        </div>
      </div>
      {problem ? (
        <p role="alert" className="ds-error mt-2 text-sm" data-testid="ops-client-feedback-error">
          {problem}
        </p>
      ) : null}
      {data.changes.length > 0 ? (
        <ul
          className="mt-4 flex flex-col gap-1 text-sm text-ink-muted"
          data-testid="ops-client-feedback-history"
        >
          {data.changes.map((c) => (
            <li key={c.id}>
              {c.enabled ? "Switched on" : "Switched off"} by{" "}
              {c.by?.name ?? c.by?.email ?? "someone"} on{" "}
              {new Date(c.createdAt).toLocaleDateString()}
              {c.reason && !DEFAULT_REASONS.has(c.reason) ? (
                <>
                  : <span className="text-ink">{c.reason}</span>
                </>
              ) : (
                "."
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
