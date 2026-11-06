// v0.12 W1-E: run controls and model calls on the back office's run page (ARCHITECTURE §10.10).
// Minimal, on the design system's classes: the owner is redoing these screens.
import { shortRunId } from "@countersign/core";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { shortTime, usd } from "../../runs/format";
import { Button, Card, EmptyState, ErrorNotice, SectionLabel } from "../../ui/primitives";

type Run = ResponseOf<typeof apiRoutes.opsRun>["run"];

/** Retry (failed live runs), cancel (open runs) and replay as a test run. */
export function RunControls({ run, onChanged }: { run: Run; onChanged: () => void }) {
  const api = useApiClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const open = ["queued", "running", "waiting"].includes(run.status);

  const act = async (what: "retry" | "cancel" | "replay") => {
    setBusy(true);
    setProblem(null);
    try {
      if (what === "cancel") {
        await api.call(apiRoutes.opsCancelRun, { params: { id: run.id } });
        onChanged();
      } else {
        const route = what === "retry" ? apiRoutes.opsRetryRun : apiRoutes.opsReplayRun;
        const started = await api.call(route, { params: { id: run.id } });
        navigate(`/ops/runs/${started.runId}`);
      }
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="reference text-sm text-ink-muted" data-testid="ops-run-short-id">
          {shortRunId(run.id)}
        </span>
        {run.status === "failed" && run.mode === "live" ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => act("retry")}
            data-testid="ops-run-retry"
          >
            Retry from the failed step
          </Button>
        ) : null}
        {open ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => act("cancel")}
            data-testid="ops-run-cancel"
          >
            Cancel run
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={busy}
          onClick={() => act("replay")}
          data-testid="ops-run-replay"
        >
          Replay as a test run
        </Button>
      </div>
      {problem ? <ErrorNotice error={problem} /> : null}
    </div>
  );
}

/** The run's model calls: provider, model, tokens, cost, time and how each ended. */
export function ModelCalls({ runId }: { runId: string }) {
  const { data, error, reload } = useApi(apiRoutes.opsRunModelCalls, { params: { id: runId } });
  return (
    <div className="mt-6" data-testid="ops-run-model-calls">
      <SectionLabel>Model calls</SectionLabel>
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.modelCalls.length === 0 ? (
        <EmptyState>This run made no model calls.</EmptyState>
      ) : null}
      {data && data.modelCalls.length > 0 ? (
        <Card className="overflow-hidden">
          <div className="dt dt-ana overflow-x-auto">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>When</th>
                  <th>Model</th>
                  <th className="n">Tokens in</th>
                  <th className="n">Tokens out</th>
                  <th className="n">Time</th>
                  <th>Ended</th>
                  <th className="n">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.modelCalls.map((m) => (
                  <tr key={m.id} data-testid={`ops-run-model-call-${m.id}`}>
                    <td className="figures text-ink">{shortTime(m.createdAt)}</td>
                    <td className="reference text-ink">
                      {m.provider} · {m.model}
                    </td>
                    <td className="n">{m.tokensIn}</td>
                    <td className="n">{m.tokensOut}</td>
                    <td className="n">{m.durationMs === null ? "—" : `${m.durationMs} ms`}</td>
                    <td className="reference text-ink">{m.stopReason ?? "—"}</td>
                    <td className="n">{usd(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
