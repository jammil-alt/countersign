// docs/plan.md §1.234 (Y5): the work statement, the same on both surfaces: the month's five
// counters in total, by business area and by agent, from the one answer the PDF and the invoice's
// email are made from. Its own chunk (loaded with the statement's screens), with core's words.
// Work and dollars identified only: never our cost, model or vendor spend (invariant 11).
import {
  WORK_COUNTER_IDS,
  WORK_STATEMENT_WORDS,
  type WorkStatement,
  workCountLines,
  workMonthName,
} from "@countersign/core";
import { type FormEvent, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { StatTile } from "../ui/figures";
import { Field, TextInput } from "../ui/forms";
import { Columns } from "../ui/page";
import { Button, Card, EmptyState } from "../ui/primitives";

/** The month picker: `YYYY-MM`, none for last month. */
export function WorkMonthForm({
  month,
  onChange,
}: {
  month: string | null;
  onChange: (month: string | null) => void;
}) {
  const { locale } = useI18n();
  const w = WORK_STATEMENT_WORDS[locale];
  const [value, setValue] = useState(month ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onChange(value || null);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" data-testid="work-month">
      <Field label={w.monthLabel} className="w-auto">
        <TextInput
          type="month"
          className="w-auto"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid="work-month-input"
        />
      </Field>
      <Button size="sm" type="submit" data-testid="work-month-show">
        {w.show}
      </Button>
    </form>
  );
}

export function WorkStatementView({
  statement: s,
  pdfHref,
}: {
  statement: WorkStatement;
  pdfHref: string;
}) {
  const { locale } = useI18n();
  const w = WORK_STATEMENT_WORDS[locale];
  const month = workMonthName(s.month, locale);
  const num = new Intl.NumberFormat(locale);
  return (
    <div className="flex flex-col gap-6" data-testid="work-statement">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="type-body text-ink-muted" data-testid="work-statement-month">
          {[month, s.partial ? w.soFar : null, s.invoiceNumber ? w.invoice(s.invoiceNumber) : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <a className="text-sm text-link hover:underline" href={pdfHref} download>
          {w.pdf}
        </a>
      </div>
      {s.agents.length === 0 ? (
        <EmptyState line={w.none} />
      ) : (
        <>
          <Columns count={4}>
            {workCountLines(s.totals, locale)
              .filter((l) => l.id !== "dollarsIdentified")
              .map((l) => (
                <StatTile
                  key={l.id}
                  label={l.label}
                  value={l.value}
                  testId={`work-total-${l.id}`}
                />
              ))}
          </Columns>
          <Card title={w.counters.dollarsIdentified} titleAbove testId="work-total-dollars">
            <p className="text-[30px] leading-[1.15] font-medium text-ink figures">
              {workCountLines(s.totals, locale).find((l) => l.id === "dollarsIdentified")?.value}
            </p>
          </Card>
          {s.areas.length > 1 ? (
            <CountsTable
              title={w.byArea}
              first={w.area}
              rows={s.areas.map((a) => ({
                key: a.area,
                name: w.areas[a.area],
                counts: a.counts,
              }))}
              testId="work-by-area"
            />
          ) : null}
          <CountsTable
            title={w.byAgent}
            first={w.agent}
            rows={s.agents.map((a) => ({
              key: a.id,
              name: `${a.name} (${w.areas[a.area]}, ${num.format(a.runs)} ${w.runs.toLowerCase()})`,
              counts: a.counts,
            }))}
            testId="work-by-agent"
          />
        </>
      )}
    </div>
  );
}

function CountsTable({
  title,
  first,
  rows,
  testId,
}: {
  title: string;
  first: string;
  rows: { key: string; name: string; counts: WorkStatement["totals"] }[];
  testId: string;
}) {
  const { locale } = useI18n();
  const w = WORK_STATEMENT_WORDS[locale];
  return (
    <Card title={title} titleAbove testId={testId}>
      <div className="dt dt-ana overflow-x-auto">
        <table>
          <thead>
            <tr className="dt-cols">
              <th>{first}</th>
              {WORK_COUNTER_IDS.map((id) => (
                <th key={id} className="n">
                  {w.counters[id]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-testid={`${testId}-${r.key}`}>
                <td>{r.name}</td>
                {workCountLines(r.counts, locale).map((l) => (
                  <td key={l.id} className="n figures">
                    {l.value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
