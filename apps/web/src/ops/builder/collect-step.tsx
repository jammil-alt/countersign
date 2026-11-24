// Collect reports (owner, 2026-11-24) in the builder's inspector: the reports a step waits for,
// each with its owner, how often it comes (the dates it must cover), what file it must be (a PDF,
// a spreadsheet and its columns, an image), when it is due and when to follow up; then when a late
// report is escalated and to whom, and what happens when one never comes. A sample of a report
// fills in its format and columns; the sample is read and never kept. Back office only.
import { type CollectSampleView, processes, type TableColumn } from "@countersign/core";
import { useRef, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { TextArea } from "../../ui/forms";
import { Button } from "../../ui/primitives";
import { errorText, useAction } from "../agents/ui";
import { DeadlineEditor } from "./deadline";
import { DurationPicker } from "./duration";
import { type FieldErrors, Row, SmallInput, SmallSelect } from "./fields";
import { newReport, type Step } from "./model";
import { type People, PersonPicker } from "./people";

type CollectStep = Extract<Step, { kind: "collect" }>;
type Report = processes.CollectItem;

const FREQUENCY_LABEL: Record<processes.ReportFrequency, string> = {
  once: "Once (no dates to check)",
  daily: "Daily: covers the day before",
  weekly: "Weekly: covers last week, Monday to Sunday",
  monthly: "Monthly: covers last month",
  quarterly: "Quarterly: covers last quarter",
  yearly: "Yearly: covers last year",
};

const FORMAT_LABEL: Record<processes.ReportFormat, string> = {
  pdf: "PDF",
  spreadsheet: "Spreadsheet (.csv, .xlsx)",
  image: "Image",
};

const TYPE_LABEL: Record<TableColumn["type"], string> = {
  text: "Text",
  number: "Number",
  money: "Money",
  date: "Date",
  boolean: "Yes or no",
};

/** 5 MB, the most a spreadsheet sample is read at. */
const MAX_BYTES = 5 * 1024 * 1024;

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

/** The next free report id: r1, r2, … */
function nextReportNumber(items: readonly Report[]): number {
  let n = items.length + 1;
  while (items.some((i) => i.id === `r${n}`)) n++;
  return n;
}

export function CollectFields({
  step,
  bundle,
  people,
  fieldErrors,
  agentId,
  set,
}: {
  step: CollectStep;
  bundle: { people?: readonly { role: string; label?: string | undefined }[] | undefined };
  people: People;
  fieldErrors: FieldErrors;
  agentId: string | undefined;
  set(key: string, fn: (s: CollectStep) => CollectStep): void;
}) {
  const problems = processes.collectProblems(step);
  const errors: FieldErrors = {
    at: (field) => [
      ...fieldErrors.at(field),
      ...problems.filter((p) => p.field === field).map((p) => p.message),
    ],
  };
  const setItem = (i: number, key: string, patch: Partial<Report>) =>
    set(`items.${i}.${key}`, (s) => ({
      ...s,
      items: s.items.map((it, k) => (k === i ? { ...it, ...patch } : it)),
    }));
  const escalate = step.escalate;
  return (
    <div className="flex flex-col gap-4" data-testid="builder-collect">
      <p className="text-xs text-ink-muted" data-testid="builder-collect-email">
        Owners can also email their report to this step: the agent's address with{" "}
        <span className="font-mono">+{step.id.toLowerCase()}</span> before the @. Each request names
        the whole address. Only a report's owner, from the email on their contact, gets in.
      </p>
      {step.items.map((item, i) => (
        <ReportCard
          key={item.id}
          index={i}
          item={item}
          errors={errors}
          bundle={bundle}
          people={people}
          agentId={agentId}
          onChange={(key, patch) => setItem(i, key, patch)}
          onRemove={
            step.items.length > 1
              ? () => set("items", (s) => ({ ...s, items: s.items.filter((_, k) => k !== i) }))
              : undefined
          }
        />
      ))}
      {step.items.length < processes.COLLECT_ITEMS_MAX ? (
        <Button
          size="sm"
          className="self-start"
          data-testid="builder-collect-add"
          onClick={() =>
            set("items", (s) => ({
              ...s,
              items: [...s.items, newReport(nextReportNumber(s.items))],
            }))
          }
        >
          Add a report
        </Button>
      ) : null}

      <section
        className="flex flex-col gap-3 border-t border-line pt-4"
        data-testid="builder-collect-escalate"
      >
        <h3 className="eyebrow text-ink-muted">When a report is late</h3>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            data-testid="builder-collect-escalate-on"
            checked={escalate !== undefined}
            onChange={(e) =>
              set("escalate", (s) => {
                if (!e.target.checked) {
                  const { escalate: _e, ...rest } = s;
                  return rest as CollectStep;
                }
                return {
                  ...s,
                  escalate: {
                    to: "client_admin",
                    after: "3 days",
                    hours: "business",
                    deadline: { after: "2 days", hours: "clock", ifNoAnswer: "stop" },
                  },
                };
              })
            }
          />
          Escalate it to someone
        </label>
        {escalate ? (
          <>
            <p className="text-xs text-ink-muted">
              They choose: keep asking, go on without it, or stop the run. We escalate a report this
              long after it was due, or sooner if its follow-ups run out.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Row label="Escalate to" field="escalate.to" errors={errors}>
                <PersonPicker
                  value={escalate.to}
                  people={people}
                  field="escalate.to"
                  testId="builder-collect-escalate-to"
                  allowLead
                  onChange={(to) =>
                    set("escalate.to", (s) =>
                      s.escalate
                        ? { ...s, escalate: { ...s.escalate, to: to ?? "client_admin" } }
                        : s,
                    )
                  }
                />
              </Row>
            </div>
            <DurationPicker
              label="When it is this late"
              field="escalate.after"
              testId="builder-collect-escalate-after"
              errors={errors}
              value={escalate.after}
              business={escalate.hours === "business"}
              onChange={(after) =>
                set("escalate.after", (s) =>
                  s.escalate ? { ...s, escalate: { ...s.escalate, after } } : s,
                )
              }
              beside={
                <Row label="Counted in" field="escalate.hours" errors={errors}>
                  <SmallSelect
                    data-field="escalate.hours"
                    data-testid="builder-collect-escalate-hours"
                    value={escalate.hours}
                    onChange={(e) =>
                      set("escalate.hours", (s) =>
                        s.escalate
                          ? {
                              ...s,
                              escalate: {
                                ...s.escalate,
                                hours: e.target.value as "clock" | "business",
                              },
                            }
                          : s,
                      )
                    }
                  >
                    <option value="business">Business hours</option>
                    <option value="clock">Clock time</option>
                  </SmallSelect>
                </Row>
              }
            />
            <DeadlineEditor
              value={escalate.deadline}
              prefix="escalate.deadline"
              testId="builder-collect-escalate-deadline"
              errors={errors}
              people={people}
              afterLabel="They have this long to answer"
              proceedBlocked={null}
              onChange={(deadline, key) =>
                set(key, (s) => (s.escalate ? { ...s, escalate: { ...s.escalate, deadline } } : s))
              }
            />
          </>
        ) : null}
        <Row
          label="If a required report never comes"
          field="ifMissing"
          errors={errors}
          hint="When nobody said to go on without it, or its follow-ups ran out."
        >
          <SmallSelect
            data-field="ifMissing"
            data-testid="builder-collect-if-missing"
            value={step.ifMissing}
            onChange={(e) =>
              set("ifMissing", (s) => ({ ...s, ifMissing: e.target.value as "stop" | "proceed" }))
            }
          >
            <option value="stop">Stop the run</option>
            <option value="proceed">Go on with what came in</option>
          </SmallSelect>
        </Row>
      </section>
    </div>
  );
}

function ReportCard({
  index,
  item,
  errors,
  bundle,
  people,
  agentId,
  onChange,
  onRemove,
}: {
  index: number;
  item: Report;
  errors: FieldErrors;
  bundle: { people?: readonly { role: string; label?: string | undefined }[] | undefined };
  people: People;
  agentId: string | undefined;
  onChange(key: string, patch: Partial<Report>): void;
  onRemove: (() => void) | undefined;
}) {
  const at = `items.${index}`;
  const t = `builder-collect-${index}`;
  const sheet = item.formats.includes("spreadsheet");
  const contacts = people.people.filter((p) => p.kind === "contact");
  const roles = bundle.people ?? [];
  const known =
    item.owner === "" ||
    roles.some((r) => `seat:${r.role}` === item.owner) ||
    contacts.some((c) => c.id === item.owner);
  return (
    <section className="flex flex-col gap-3 rounded border border-line p-3" data-testid={`${t}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="eyebrow text-ink-muted">Report {index + 1}</h3>
        {onRemove ? (
          <Button size="sm" variant="ghost" data-testid={`${t}-remove`} onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Row label="Name" field={`${at}.name`} errors={errors}>
          <SmallInput
            data-field={`${at}.name`}
            data-testid={`${t}-name`}
            value={item.name}
            onChange={(e) => onChange("name", { name: e.target.value })}
          />
        </Row>
        <Row
          label="Owner"
          field={`${at}.owner`}
          errors={errors}
          hint="Who sends it: one of the agent's people, or a contact."
        >
          <SmallSelect
            data-field={`${at}.owner`}
            data-testid={`${t}-owner`}
            value={item.owner}
            invalid={errors.at(`${at}.owner`).length > 0 || item.owner === ""}
            onChange={(e) => onChange("owner", { owner: e.target.value })}
          >
            <option value="">Choose who sends it…</option>
            {roles.length ? (
              <optgroup label="The agent's people">
                {roles.map((r) => (
                  <option key={r.role} value={`seat:${r.role}`}>
                    {r.label ?? r.role}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {contacts.length ? (
              <optgroup label="Contacts">
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {known ? null : <option value={item.owner}>{item.owner}</option>}
          </SmallSelect>
        </Row>
      </div>
      <Row
        label="What it is"
        field={`${at}.describe`}
        errors={errors}
        hint="Shown to the owner on the page where they send it."
      >
        <TextArea
          rows={2}
          data-field={`${at}.describe`}
          data-testid={`${t}-describe`}
          value={item.describe ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            onChange("describe", { describe: v === "" ? undefined : v });
          }}
        />
      </Row>
      <div className="grid grid-cols-2 gap-3">
        <Row label="How often it comes" field={`${at}.frequency`} errors={errors}>
          <SmallSelect
            data-field={`${at}.frequency`}
            data-testid={`${t}-frequency`}
            value={item.frequency}
            onChange={(e) =>
              onChange("frequency", { frequency: e.target.value as processes.ReportFrequency })
            }
          >
            {processes.REPORT_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABEL[f]}
              </option>
            ))}
          </SmallSelect>
        </Row>
        <Row label="Required" field={`${at}.required`} errors={errors}>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              data-testid={`${t}-required`}
              checked={item.required}
              onChange={(e) => onChange("required", { required: e.target.checked })}
            />
            The step waits for it
          </label>
        </Row>
      </div>

      <Row label="File" field={`${at}.formats`} errors={errors}>
        <div className="flex flex-wrap gap-3">
          {processes.REPORT_FORMATS.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                data-testid={`${t}-format-${f}`}
                checked={item.formats.includes(f)}
                onChange={(e) => {
                  const formats = e.target.checked
                    ? [...item.formats, f]
                    : item.formats.filter((x) => x !== f);
                  if (formats.length > 0) onChange("formats", { formats });
                }}
              />
              {FORMAT_LABEL[f]}
            </label>
          ))}
        </div>
      </Row>
      <SampleFile item={item} agentId={agentId} testId={t} onChange={onChange} />
      {sheet ? <SheetChecks item={item} at={at} t={t} errors={errors} onChange={onChange} /> : null}

      <DurationPicker
        label="Due after the step starts"
        field={`${at}.due`}
        testId={`${t}-due`}
        errors={errors}
        value={item.due}
        business={item.hours === "business"}
        onChange={(due) => onChange("due", { due })}
        beside={
          <Row label="Counted in" field={`${at}.hours`} errors={errors}>
            <SmallSelect
              data-field={`${at}.hours`}
              data-testid={`${t}-hours`}
              value={item.hours}
              onChange={(e) => onChange("hours", { hours: e.target.value as Report["hours"] })}
            >
              <option value="business">Business hours</option>
              <option value="clock">Clock time</option>
            </SmallSelect>
          </Row>
        }
      />
      <DurationPicker
        label="First follow-up, after it's due"
        field={`${at}.followUp.after`}
        testId={`${t}-follow-after`}
        errors={errors}
        value={item.followUp.after}
        onChange={(after) => onChange("followUp", { followUp: { ...item.followUp, after } })}
      />
      <div className="grid grid-cols-2 gap-3">
        <DurationPicker
          label="Then follow up every"
          field={`${at}.followUp.every`}
          testId={`${t}-follow-every`}
          errors={errors}
          value={item.followUp.every}
          onChange={(every) => onChange("followUp", { followUp: { ...item.followUp, every } })}
        />
        <Row label="Follow-ups, at most" field={`${at}.followUp.max`} errors={errors}>
          <SmallInput
            type="number"
            min={0}
            max={processes.COLLECT_FOLLOW_UPS_MAX}
            data-field={`${at}.followUp.max`}
            data-testid={`${t}-follow-max`}
            value={String(item.followUp.max)}
            onChange={(e) => {
              const max = Math.min(
                processes.COLLECT_FOLLOW_UPS_MAX,
                Math.max(0, Math.floor(Number(e.target.value) || 0)),
              );
              onChange("followUp", { followUp: { ...item.followUp, max } });
            }}
          />
        </Row>
      </div>
    </section>
  );
}

/** A spreadsheet's checks: its columns, its date column and its fewest rows. */
function SheetChecks({
  item,
  at,
  t,
  errors,
  onChange,
}: {
  item: Report;
  at: string;
  t: string;
  errors: FieldErrors;
  onChange(key: string, patch: Partial<Report>): void;
}) {
  const columns = item.columns ?? [];
  const setColumns = (next: TableColumn[], dates = item.dates) =>
    onChange("columns", {
      columns: next.length > 0 ? next : undefined,
      dates: dates && next.some((c) => c.field === dates.field) ? dates : undefined,
    });
  const dateColumns = columns.filter((c) => c.type === "date");
  return (
    <div className="flex flex-col gap-3" data-testid={`${t}-sheet`}>
      <Row
        label="Columns"
        field={`${at}.columns`}
        errors={errors}
        hint="A required column missing from the file sends it back to its owner."
      >
        <div className="flex flex-col gap-2">
          {columns.map((c, k) => (
            <div key={c.field} className="flex flex-wrap items-center gap-2">
              <SmallInput
                aria-label="Header in the file"
                data-testid={`${t}-col-${k}-header`}
                value={c.headers[0] ?? c.field}
                onChange={(e) => {
                  const header = e.target.value;
                  const taken = columns.filter((_, x) => x !== k).map((x) => x.field);
                  const field = processes.fieldFromHeader(header || c.field, taken);
                  const next = columns.map((x, y) =>
                    y === k ? { ...x, field, headers: header ? [header] : [] } : x,
                  );
                  const dates = item.dates?.field === c.field ? { field } : item.dates;
                  setColumns(next, dates);
                }}
              />
              <SmallSelect
                aria-label="Type"
                data-testid={`${t}-col-${k}-type`}
                value={c.type}
                onChange={(e) =>
                  setColumns(
                    columns.map((x, y) =>
                      y === k ? { ...x, type: e.target.value as TableColumn["type"] } : x,
                    ),
                  )
                }
              >
                {(Object.keys(TYPE_LABEL) as TableColumn["type"][]).map((ty) => (
                  <option key={ty} value={ty}>
                    {TYPE_LABEL[ty]}
                  </option>
                ))}
              </SmallSelect>
              <label className="flex items-center gap-1 text-sm text-ink">
                <input
                  type="checkbox"
                  data-testid={`${t}-col-${k}-required`}
                  checked={c.required === true}
                  onChange={(e) =>
                    setColumns(
                      columns.map((x, y) => (y === k ? { ...x, required: e.target.checked } : x)),
                    )
                  }
                />
                Required
              </label>
              <Button
                size="sm"
                variant="ghost"
                data-testid={`${t}-col-${k}-remove`}
                onClick={() => setColumns(columns.filter((_, y) => y !== k))}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            className="self-start"
            data-testid={`${t}-col-add`}
            onClick={() => {
              const field = processes.fieldFromHeader(
                `column ${columns.length + 1}`,
                columns.map((c) => c.field),
              );
              setColumns([...columns, { field, headers: [], type: "text", required: true }]);
            }}
          >
            Add a column
          </Button>
        </div>
      </Row>
      <div className="grid grid-cols-2 gap-3">
        <Row
          label="Dates must fall in the period"
          field={`${at}.dates.field`}
          errors={errors}
          hint="Every dated row must be inside the period the report covers."
        >
          <SmallSelect
            data-field={`${at}.dates.field`}
            data-testid={`${t}-dates`}
            value={item.dates?.field ?? ""}
            onChange={(e) =>
              onChange("dates", { dates: e.target.value ? { field: e.target.value } : undefined })
            }
          >
            <option value="">Don't check dates</option>
            {dateColumns.map((c) => (
              <option key={c.field} value={c.field}>
                {c.headers[0] ?? c.field}
              </option>
            ))}
          </SmallSelect>
        </Row>
        <Row label="Rows, at least" field={`${at}.minRows`} errors={errors}>
          <SmallInput
            type="number"
            min={0}
            data-field={`${at}.minRows`}
            data-testid={`${t}-min-rows`}
            value={item.minRows === undefined ? "" : String(item.minRows)}
            placeholder="Any"
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value) || 0);
              onChange("minRows", { minRows: n > 0 ? n : undefined });
            }}
          />
        </Row>
      </div>
    </div>
  );
}

/** "Add a sample": its format, and a spreadsheet's columns, read by the server; never kept. */
function SampleFile({
  item,
  agentId,
  testId,
  onChange,
}: {
  item: Report;
  agentId: string | undefined;
  testId: string;
  onChange(key: string, patch: Partial<Report>): void;
}) {
  const read = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<CollectSampleView | null>(null);
  const [tooLarge, setTooLarge] = useState(false);

  async function pick(f: File) {
    if (!agentId) return;
    setResult(null);
    setTooLarge(f.size > MAX_BYTES);
    if (f.size > MAX_BYTES) return;
    const res = await read.call(apiRoutes.opsCollectSample, {
      params: { id: agentId },
      body: {
        file: { filename: f.name, mimeType: f.type, base64: base64Of(await f.arrayBuffer()) },
      },
    });
    if (!res.ok) return;
    const view = res.data;
    setResult(view);
    if (!view.format) return;
    onChange("sample", {
      sample: { filename: view.filename.slice(0, 255) },
      formats: item.formats.includes(view.format) ? item.formats : [...item.formats, view.format],
      ...(view.format === "spreadsheet" && view.columns.length > 0 && !view.failure
        ? { columns: view.columns, dates: undefined }
        : {}),
    });
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`${testId}-sample`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          className="sr-only"
          data-testid={`${testId}-sample-file`}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          data-testid={`${testId}-sample-pick`}
          disabled={read.busy || !agentId}
          onClick={() => input.current?.click()}
        >
          {item.sample ? "Use another sample" : "Add a sample file"}
        </Button>
        <span className="text-sm text-ink-muted">
          {item.sample
            ? `Set up from ${item.sample.filename}. Nothing of it is kept.`
            : "Sets the format and, for a spreadsheet, its columns. Nothing of it is kept."}
        </span>
      </div>
      {tooLarge ? <p className="ds-error text-sm">The file is over 5 MB.</p> : null}
      {read.busy ? <p className="text-sm text-ink-muted">Reading the file…</p> : null}
      {read.error ? <p className="ds-error text-sm">{errorText(read.error)}</p> : null}
      {result && !result.format ? (
        <p className="ds-error text-sm" data-testid={`${testId}-sample-unknown`}>
          {result.filename} isn't a PDF, a spreadsheet or an image.
        </p>
      ) : null}
      {result?.failure ? (
        <p className="ds-error text-sm">We couldn't read its columns: {result.failure}</p>
      ) : null}
      {result?.format === "spreadsheet" && !result.failure ? (
        <p className="text-sm text-ink" data-testid={`${testId}-sample-summary`}>
          {result.columns.length} {result.columns.length === 1 ? "column" : "columns"} from{" "}
          {result.rowCount.toLocaleString("en-US")} {result.rowCount === 1 ? "row" : "rows"}
          {result.sheet ? ` on the sheet ${result.sheet}` : ""}. Check their types below.
        </p>
      ) : null}
    </div>
  );
}
