// The client settings' Exports section (`/ops/clients/:clientId/settings/exports`, docs/plan.md
// §1.36; it was the Exports tab, whose address redirects here): the client's data export (every
// record table as CSV and the original documents in one ZIP, built in the background and noted in
// the client's change log) and the accountant export for a period (the changes made to its tools,
// as a ZIP with documents or one CSV). A retired client can be exported until its data is purged;
// the section says until when.
import { buildPath, EXPORT_PERIOD_MAX_DAYS, periodDays } from "@countersign/core";
import { useState } from "react";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { usePoll } from "../../runs/usePoll";
import { Field, Select, TextInput } from "../../ui/forms";
import { Loaded, Section } from "../../ui/page";
import { Button, buttonClass, Card, EmptyState, ErrorNotice } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";

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

/** Both exports, for the client's Settings. */
export function ClientExportsSection({ clientId }: { clientId: string }) {
  return (
    <>
      <DataExports clientId={clientId} />
      <AccountantExport clientId={clientId} />
    </>
  );
}

function DataExports({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const state = useApi(apiRoutes.opsClientExports, {
    params: { id: clientId },
    // A ready export carries a download link that works for a few minutes: never stored.
    cache: "none",
  });
  const building = state.data?.exports.some((e) => e.status === "running") ?? false;
  usePoll(state.reload, building, EXPORT_POLL_MS, state.loading);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  async function start() {
    setBusy(true);
    setProblem(null);
    try {
      // No reason asked for: the client's change log says "Client data export".
      await api.call(apiRoutes.opsClientExportStart, { params: { id: clientId }, body: {} });
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
      action={
        <Button
          variant="primary"
          disabled={busy || building}
          onClick={() => void start()}
          data-testid="ops-client-export-start"
        >
          {building ? "Building an export" : "Start an export"}
        </Button>
      }
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
            {problem ? <ErrorNotice error={problem} /> : null}
            {data.exports.length === 0 ? (
              <EmptyState line="No exports yet. Start one above; it takes a few minutes to build." />
            ) : (
              <div className="dt dt-ana overflow-x-auto">
                <table data-testid="ops-client-exports-table">
                  <thead>
                    <tr className="dt-cols">
                      <th>Asked for</th>
                      <th>Status</th>
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
