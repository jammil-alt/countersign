// Read table (owner, 2026-11-20; docs/plan.md §1.164) in the builder's inspector: the sample-file
// check. The operator picks a .csv, .xlsx or .json file; the server reads it with the step's
// effective parameters (the step's own over the agent's) exactly as a run would, and this shows
// which of the file's headers each expected column took, what is missing, the headers no column
// took and the first rows. Nothing is stored: the sample never becomes a client's document.
// Back office only.
import type { ReadTableSampleView } from "@countersign/core";
import { useRef, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { Badge, Button, cx } from "../../ui/primitives";
import { errorText, useAction } from "../agents/ui";
import type { Process, ProcessAgentBundle, Step } from "./model";

type SkillStep = Extract<Step, { kind: "skill" }>;

/** 5 MB, the most Read table reads (core's `processes.TABLE_MAX_BYTES`). */
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT =
  ".csv,.xlsx,.json,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

function cellText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function ReadTableSample({
  step,
  workflow,
  bundle,
  agentId,
}: {
  step: SkillStep;
  workflow: Process;
  bundle: ProcessAgentBundle;
  agentId: string | undefined;
}) {
  const check = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [result, setResult] = useState<ReadTableSampleView | null>(null);

  async function read(f: File) {
    if (!agentId) return;
    setFile(f.name);
    setResult(null);
    setTooLarge(f.size > MAX_BYTES);
    if (f.size > MAX_BYTES) return;
    const res = await check.call(apiRoutes.opsReadTableSample, {
      params: { id: agentId },
      body: {
        process: workflow,
        stepId: step.id,
        agentSkills: bundle.definition.skills.map((s) => ({
          skill: s.skill,
          ...(s.parameters ? { parameters: s.parameters } : {}),
        })),
        file: { filename: f.name, mimeType: f.type, base64: base64Of(await f.arrayBuffer()) },
      },
    });
    if (res.ok) setResult(res.data);
  }

  const fields = result?.columns.map((c) => c.field) ?? [];
  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-testid="builder-read-table"
    >
      <h3 className="eyebrow text-ink-muted">Try a sample file</h3>
      <p className="text-sm text-ink">
        Read a .csv, .xlsx or .json file as this step would, to see which headers your columns take.{" "}
        <span className="text-ink-muted">Nothing is kept.</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          data-testid="builder-read-table-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          data-testid="builder-read-table-pick"
          disabled={check.busy || !agentId}
          onClick={() => input.current?.click()}
        >
          {file ? "Try another file" : "Choose a file"}
        </Button>
        {file ? <span className="text-sm text-ink-muted">{file}</span> : null}
      </div>
      {tooLarge ? (
        <p className="ds-error text-sm">The file is over 5 MB; Read table reads at most 5 MB.</p>
      ) : null}
      {check.busy ? <p className="text-sm text-ink-muted">Reading the file…</p> : null}
      {check.error ? <p className="ds-error text-sm">{errorText(check.error)}</p> : null}
      {result ? (
        <div className="flex flex-col gap-3" data-testid="builder-read-table-result">
          <p className="text-sm text-ink" data-testid="builder-read-table-summary">
            {result.failure
              ? `This file would stop the step: ${result.failure}.`
              : `${result.rowCount.toLocaleString("en-US")} ${result.rowCount === 1 ? "row" : "rows"} read`}
            {result.sheet ? ` from the sheet ${result.sheet}` : ""}
            {result.problemCount > 0
              ? `; ${result.problemCount} ${result.problemCount === 1 ? "problem" : "problems"}`
              : ""}
            .
          </p>
          <ul className="flex flex-col" data-testid="builder-read-table-columns">
            {result.columns.map((c) => (
              <li
                key={c.field}
                className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line py-1.5"
                data-testid={`builder-read-table-column-${c.field}`}
              >
                <span className="text-sm text-ink">
                  <span className="reference">{c.field}</span>
                  {c.type ? <span className="text-xs text-ink-muted"> · {c.type}</span> : null}
                </span>
                {c.header !== null ? (
                  <span className="text-sm text-ink">
                    {c.column && c.column !== c.header ? `${c.column}: ` : ""}“{c.header}”
                  </span>
                ) : (
                  <Badge
                    tone={c.required ? "risk" : "neutral"}
                    testId={`builder-read-table-missing-${c.field}`}
                  >
                    {c.required ? "Missing, required" : "Not in this file"}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
          {result.unmatched.length > 0 ? (
            <p className="text-xs text-ink-muted" data-testid="builder-read-table-unmatched">
              Headers no column takes:{" "}
              {result.unmatched
                .map((u) => `${u.column === u.header ? "" : `${u.column}: `}“${u.header}”`)
                .join(", ")}
            </p>
          ) : null}
          {result.sheets.length > 1 ? (
            <p className="text-xs text-ink-muted">
              Sheets in this file: {result.sheets.join(", ")}
            </p>
          ) : null}
          {result.rows.length > 0 ? (
            <div className="overflow-x-auto" data-testid="builder-read-table-rows">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-ink-muted">
                    {fields.map((f) => (
                      <th key={f} className="px-1.5 py-1 font-normal">
                        {f}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the first rows of a sample, in order.
                    <tr key={i} className="border-t border-line text-ink">
                      {fields.map((f) => (
                        <td key={f} className="px-1.5 py-1 break-words">
                          {cellText(row[f])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {result.problems.length > 0 ? (
            <ul className={cx("text-xs text-ink-muted")} data-testid="builder-read-table-problems">
              {result.problems.map((p) => (
                <li key={`${p.row}:${p.field}:${p.message}`}>
                  {p.row !== null ? `Row ${p.row}` : "The file"}
                  {p.field ? `, ${p.field}` : ""}: {p.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
