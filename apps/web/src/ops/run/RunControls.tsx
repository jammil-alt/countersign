// v0.12 W1-E: run controls and model calls on the back office's run page (ARCHITECTURE §10.10):
// retry a failed live run from its failed step, cancel an open run, replay it as a test run (never
// writes); the run's model calls, each with its request and answer on demand. Back office only.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { shortTime, usd } from "../../runs/format";
import { Loaded } from "../../ui/page";
import { Button, Card, EmptyState, ErrorNotice } from "../../ui/primitives";

type Run = ResponseOf<typeof apiRoutes.opsRun>["run"];
type ModelCall = ResponseOf<typeof apiRoutes.opsRunModelCalls>["modelCalls"][number];

/** Retry (failed live runs), cancel (open runs) and replay as a test run. */
export function RunControls({
  run,
  failedStep,
  onChanged,
}: {
  run: Run;
  /** The failed step's name, for "Retry from …". */
  failedStep: string | null;
  onChanged: () => void;
}) {
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button disabled={busy} onClick={() => act("replay")} data-testid="ops-run-replay">
          Replay as a test run
        </Button>
        {open ? (
          <Button disabled={busy} onClick={() => act("cancel")} data-testid="ops-run-cancel">
            Cancel run
          </Button>
        ) : null}
        {run.status === "failed" && run.mode === "live" ? (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => act("retry")}
            data-testid="ops-run-retry"
          >
            {failedStep ? `Retry from ${failedStep}` : "Retry from the failed step"}
          </Button>
        ) : null}
      </div>
      {problem ? <ErrorNotice error={problem} /> : null}
    </div>
  );
}

/** The run's model calls: provider, model, tokens, cost, time and how each ended. */
export function ModelCalls({ calls, names }: { calls: ModelCall[]; names: Map<string, string> }) {
  const [open, setOpen] = useState<string | null>(null);
  if (calls.length === 0) return <EmptyState>This run made no model calls.</EmptyState>;
  return (
    <Card testId="ops-run-model-calls">
      <div className="dt dt-ana overflow-x-auto rounded-none border-0">
        <table>
          <thead>
            <tr className="dt-cols">
              <th>When</th>
              <th>Step</th>
              <th>Model</th>
              <th className="text-right">Tokens in</th>
              <th className="text-right">Tokens out</th>
              <th className="text-right">Time</th>
              <th>Ended</th>
              <th className="text-right">Cost</th>
              <th>
                <span className="sr-only">Request and answer</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {calls.map((m) => (
              <ModelCallRow
                key={m.id}
                call={m}
                step={m.stepRunId ? (names.get(m.stepRunId) ?? null) : null}
                open={open === m.id}
                onToggle={() => setOpen(open === m.id ? null : m.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ModelCallRow({
  call,
  step,
  open,
  onToggle,
}: {
  call: ModelCall;
  step: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr data-testid={`ops-run-model-call-${call.id}`}>
        <td className="figures text-ink">{shortTime(call.createdAt)}</td>
        <td className="text-sm text-ink">{step ?? "—"}</td>
        <td className="reference text-ink">
          {call.provider} · {call.model}
        </td>
        <td className="n">{call.tokensIn}</td>
        <td className="n">{call.tokensOut}</td>
        <td className="n">{call.durationMs === null ? "—" : `${call.durationMs} ms`}</td>
        <td className="reference text-ink">{call.stopReason ?? "—"}</td>
        <td className="n">{usd(call.costUsd)}</td>
        <td>
          <Button
            variant="link"
            size="sm"
            aria-expanded={open}
            onClick={onToggle}
            data-testid={`ops-run-model-call-${call.id}-open`}
          >
            {open ? "Hide" : "Request and answer"}
          </Button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={9} className="whitespace-normal py-3">
            <ModelCallBody id={call.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ModelCallBody({ id }: { id: string }) {
  const state = useApi(apiRoutes.opsModelCall, { params: { id } });
  return (
    <Loaded state={state}>
      {(data) =>
        data.body === null ? (
          <p className="text-sm text-ink-muted">We didn't keep this call's request and answer.</p>
        ) : (
          <div
            className="grid grid-cols-1 gap-3 lg:grid-cols-2"
            data-testid={`ops-model-body-${id}`}
          >
            <div>
              <h4 className="eyebrow mb-1 text-ink-muted">Request</h4>
              <pre className="ops-code">{JSON.stringify(data.body.request, null, 2)}</pre>
            </div>
            <div>
              <h4 className="eyebrow mb-1 text-ink-muted">Answer</h4>
              <pre className="ops-code">
                {data.body.error ?? JSON.stringify(data.body.answer, null, 2)}
              </pre>
            </div>
          </div>
        )
      }
    </Loaded>
  );
}
