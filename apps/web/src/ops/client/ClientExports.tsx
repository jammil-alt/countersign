// The client page's Exports tab (`/ops/clients/:clientId/exports`; docs/plan.md §1.36): the
// client's data export (every record table as CSV and the original documents in one ZIP, built in
// the background, with a reason for the client's change log) and the accountant export for a
// period (the changes made to its tools, as a ZIP with documents or one CSV). A retired client
// can be exported until its data is purged; the page says until when.
import { buildPath, EXPORT_PERIOD_MAX_DAYS, periodDays } from "@countersign/core";
import { useState } from "react";
import { useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { usePoll } from "../../runs/usePoll";
import { Field, Select, TextInput } from "../../ui/forms";
import { Loaded, Section } from "../../ui/page";
import { Button, buttonClass, Card, EmptyState, ErrorNotice } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { ClientFrame } from "./ClientFrame";

/** How often the list reloads while an export is being built. */
const EXPORT_POLL_MS = 5_000;

type ClientExport = ResponseOf<typeof apiRoutes.opsClientExports>["exports"][number];

const STATUS: Record<ClientExport["status"], { state: ChipState; words: string }> = {
  running: { state: "running", words: "Building" },
  ready: { state: "done", words: "Ready" },
  failed: { state: "failed", words: "Failed" },
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** YYYY-MM-DD of a local date. */
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Last calendar month: what an accountant usually asks for. */
export function lastMonth(today = new Date()): { from: string; to: string } {
  const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const last = new Date(today.getFullYear(), today.getMonth(), 0);
  return { from: isoDay(first), to: isoDay(last) };
}

export function ClientExportsScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame
      clientId={clientId}
      intro="Copies of the client's data: everything they hold with us, or the changes made to their tools for their accountant."
    >
      <DataExports clientId={clientId} />
      <AccountantExport clientId={clientId} />
    </ClientFrame>
  );
}

function DataExports({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const state = useApi(apiRoutes.opsClientExports, { params: { id: clientId } });
  const building = state.data?.exports.some((e) => e.status === "running") ?? false;
  usePoll(state.reload, building, EXPORT_POLL_MS, state.loading);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  async function start() {
    setBusy(true);
    setProblem(null);
    try {
      await api.call(apiRoutes.opsClientExportStart, {
        params: { id: clientId },
        body: reason.trim() ? { reason: reason.trim() } : {},
      });
      setReason("");
      state.reload();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Client data export"
      meta="Every record table as CSV and the original documents, in one ZIP"
      testId="ops-client-exports"
    >
      <Loaded state={state}>
        {(data) => (
          <div className="flex flex-col gap-4">
            {data.retiredAt ? (
              <p className="text-ink" data-testid="ops-client-exports-retired">
                {`Retired on ${when(data.retiredAt)}.`}
                {data.exportableUntil
                  ? ` An export can be started until ${when(data.exportableUntil)}.`
                  : null}
              </p>
            ) : null}
            <Card pad>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void start();
                }}
              >
                <Field
                  label="Reason (optional)"
                  hint="Goes in the client's change log."
                  className="min-w-0 flex-1"
                >
                  <TextInput
                    data-testid="ops-client-export-reason"
                    value={reason}
                    maxLength={500}
                    placeholder="Asked for by the client"
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || building}
                  data-testid="ops-client-export-start"
                >
                  {building ? "Building an export" : "Start an export"}
                </Button>
              </form>
              {problem ? (
                <div className="mt-3">
                  <ErrorNotice error={problem} />
                </div>
              ) : null}
            </Card>
            {data.exports.length === 0 ? (
              <EmptyState>No exports yet.</EmptyState>
            ) : (
              <div className="dt dt-ana overflow-x-auto">
                <table data-testid="ops-client-exports-table">
                  <thead>
                    <tr className="dt-cols">
                      <th>Asked for</th>
                      <th>Status</th>
                      <th>Reason</th>
                      <th className="n">Files</th>
                      <th className="n">Size</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.exports.map((x) => (
                      <tr key={x.id} data-testid={`ops-client-export-${x.id}`}>
                        <td>
                          <span className="block">{when(x.requestedAt)}</span>
                          {x.requestedBy?.email ? (
                            <span className="block text-sm text-ink-muted">
                              {x.requestedBy.email}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <StatusChip state={STATUS[x.status].state}>
                            {STATUS[x.status].words}
                          </StatusChip>
                          {x.error ? (
                            <span className="mt-1 block text-sm ui-tone-risk">{x.error}</span>
                          ) : null}
                        </td>
                        <td>{x.reason || "–"}</td>
                        <td className="n">{x.files ?? "–"}</td>
                        <td className="n">{x.sizeBytes === null ? "–" : size(x.sizeBytes)}</td>
                        <td>
                          {x.download ? (
                            <a
                              href={x.download.url}
                              download={x.download.filename}
                              rel="noopener noreferrer"
                              className="ds-btn ds-btn--link text-sm"
                              data-testid={`ops-client-export-download-${x.id}`}
                            >
                              Download
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.exports.some((x) => x.download) ? (
              <p className="text-sm text-ink-muted">
                Download links work for a few minutes. Reload the page for fresh ones.
              </p>
            ) : null}
          </div>
        )}
      </Loaded>
    </Section>
  );
}

function AccountantExport({ clientId }: { clientId: string }) {
  const [period, setPeriod] = useState(lastMonth);
  const [format, setFormat] = useState<"zip" | "csv">("zip");
  const days = period.from && period.to ? periodDays(period.from, period.to) : 0;
  const problem =
    !period.from || !period.to
      ? "Choose both days."
      : period.from > period.to
        ? "The first day comes after the last."
        : days > EXPORT_PERIOD_MAX_DAYS
          ? `A period is at most ${EXPORT_PERIOD_MAX_DAYS} days.`
          : null;
  const href = `${buildPath(apiRoutes.opsClientAccountantExport.path, { id: clientId })}?${new URLSearchParams({ ...period, format }).toString()}`;

  return (
    <Section
      title="Accountant export"
      meta="Each change made to the client's tools, who signed it, its run and documents"
      testId="ops-client-accountant-export"
    >
      <Card pad>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From" className="min-w-40">
            <TextInput
              type="date"
              data-testid="ops-client-accountant-from"
              value={period.from}
              onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))}
            />
          </Field>
          <Field label="To" className="min-w-40">
            <TextInput
              type="date"
              data-testid="ops-client-accountant-to"
              value={period.to}
              onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))}
            />
          </Field>
          <Field label="As" className="min-w-48">
            <Select
              data-testid="ops-client-accountant-format"
              value={format}
              onChange={(e) => setFormat(e.target.value === "csv" ? "csv" : "zip")}
            >
              <option value="zip">ZIP with the documents</option>
              <option value="csv">The changes alone, as CSV</option>
            </Select>
          </Field>
          {problem ? (
            <span className="ds-error pb-2 text-sm" data-testid="ops-client-accountant-problem">
              {problem}
            </span>
          ) : (
            <a
              href={href}
              download
              className={buttonClass("secondary")}
              data-testid="ops-client-accountant-download"
            >
              Download
            </a>
          )}
        </div>
      </Card>
    </Section>
  );
}
