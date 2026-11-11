// The run pages' step panel (docs/plan.md §1.95): a step of a run opened beside it, as a side sheet
// from the right. The back office (`/ops/runs/:id`) and the portal (`/runs/:id`) build their own
// contents from what their route returns; this file holds what both share: the `?step=` address
// (a link to the run with its step open), the sheet with its Step and Data tabs, the step's facts,
// its input and output read as fields, lists and tables (raw JSON behind a toggle), and the Data
// tab's list of records, documents and changes with links where a page exists.

import { isPlainObject, isUuid } from "@countersign/core";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "../i18n/i18n";
import { fieldLabel, formatValue } from "../inbox/change";
import { Icon } from "../ui/icons";
import { Button, cx } from "../ui/primitives";
import { SheetSection, SideSheet } from "../ui/sheet";

// ── The address ──

/** The query parameter that names the open step: `/runs/<id>?step=<step run id>`. */
export const STEP_PARAM = "step";

/**
 * The open step, from the address, and how to open and close it; the page's other parameters
 * (its tab) stay. The address can be shared: the run opens with that step's panel.
 */
export function useStepParam(): {
  stepId: string | null;
  openStep: (id: string) => void;
  closeStep: () => void;
} {
  const [params, setParams] = useSearchParams();
  const stepId = params.get(STEP_PARAM);
  const set = (id: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set(STEP_PARAM, id);
        else next.delete(STEP_PARAM);
        return next;
      },
      { replace: true },
    );
  return { stepId, openStep: (id) => set(id), closeStep: () => set(null) };
}

// ── The sheet ──

export type StepPanelTab = "step" | "data";

/**
 * The panel: the step's name and state at its head, then Step (what it did) and, when the step
 * made, changed or cited anything, Data. Escape, the scrim and Close shut it; focus stays inside.
 */
export function StepSheet({
  title,
  eyebrow,
  onClose,
  step,
  data,
  dataCount,
  testId,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  onClose: () => void;
  /** The Step tab. */
  step: ReactNode;
  /** The Data tab, when the step made, changed or cited anything. */
  data?: ReactNode;
  dataCount?: number;
  testId: string;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<StepPanelTab>("step");
  const shown: StepPanelTab = data ? tab : "step";
  const tabs: [StepPanelTab, string, number | undefined][] = [
    ["step", t("stepPanel.tab.step"), undefined],
    ["data", t("stepPanel.tab.data"), dataCount],
  ];
  return (
    <SideSheet
      title={title}
      eyebrow={eyebrow}
      onClose={onClose}
      testId={testId}
      wide
      tabs={
        data ? (
          <div className="ds-tabs" role="tablist" aria-label={t("stepPanel.tab.step")}>
            {tabs.map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={shown === id}
                data-testid={`${testId}-tab-${id}`}
                onClick={() => setTab(id)}
              >
                {label}
                {count !== undefined ? <span className="ds-num">· {count}</span> : null}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      {shown === "data" ? data : step}
    </SideSheet>
  );
}

// ── Facts ──

/** Label and value in two columns: status, times, tries, model. Empty values are left out. */
export function StepFacts({
  facts,
  testId,
}: {
  facts: readonly (readonly [string, ReactNode])[];
  testId?: string;
}) {
  const shown = facts.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="ui-stepfacts" data-testid={testId}>
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Data read as fields ──

/** How many items of a list show before "and N more". */
const LIST_CUT = 20;
/** How deep fields nest before the rest reads as one line of text. */
const NEST_CUT = 3;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DECIMAL = /^-?\d+\.\d+$/;

type Scalar = string | number | boolean | null;

function isScalar(v: unknown): v is Scalar {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/** A list of like rows (a bill's lines): plain objects of scalars sharing at most 6 fields. */
export function tableColumns(rows: readonly unknown[]): string[] | null {
  if (rows.length === 0 || !rows.every(isPlainObject)) return null;
  const columns: string[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    for (const [k, v] of Object.entries(row)) {
      if (v !== undefined && !isScalar(v)) return null;
      if (!columns.includes(k)) columns.push(k);
    }
  }
  return columns.length > 0 && columns.length <= 6 ? columns : null;
}

function ScalarText({ value }: { value: Scalar }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  if (value === null || value === "") return <span className="text-ink-muted">—</span>;
  if (typeof value === "boolean") return <>{value ? t("common.yes") : t("common.no")}</>;
  if (typeof value === "number")
    return <span className="figures">{fmt.figure(String(value))}</span>;
  if (isUuid(value)) {
    return (
      <span className="reference" title={value}>
        ·{value.slice(-6)}
      </span>
    );
  }
  if (ISO_TIME.test(value) && !Number.isNaN(Date.parse(value))) {
    return <span className="figures">{fmt.time(value)}</span>;
  }
  if (DECIMAL.test(value)) return <span className="figures">{fmt.figure(value)}</span>;
  return <>{value}</>;
}

function More({ count }: { count: number }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return <p className="text-sm text-ink-muted">{t("stepPanel.more", { count })}</p>;
}

/**
 * Any stored value as a person reads it: fields as label and value, a list of like rows as a
 * table, other lists one item under another, ids by their tail, times and figures in the reader's
 * locale. Never JSON.
 */
export function FieldsView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const i18n = useI18n();
  if (value === undefined) return <span className="text-ink-muted">—</span>;
  if (isScalar(value)) return <ScalarText value={value} />;
  if (depth >= NEST_CUT) return <>{formatValue(value, i18n)}</>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-muted">—</span>;
    if (value.every(isScalar)) {
      const shown = value.slice(0, LIST_CUT);
      return (
        <>
          {shown.map((v, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a stored list, in order, never moves.
            <span key={i}>
              {i > 0 ? ", " : null}
              <ScalarText value={v} />
            </span>
          ))}
          {value.length > LIST_CUT
            ? ` ${i18n.t("stepPanel.more", { count: value.length - LIST_CUT })}`
            : null}
        </>
      );
    }
    const columns = tableColumns(value);
    const shown = value.slice(0, LIST_CUT);
    if (columns) {
      return (
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="ui-stepdata__table">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c} scope="col">
                      {fieldLabel(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(shown as Record<string, unknown>[]).map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a stored list, in order.
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c}>
                        <ScalarText value={(row[c] ?? null) as Scalar} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <More count={value.length - shown.length} />
        </div>
      );
    }
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {shown.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a stored list, in order.
          <div key={i} className="ui-stepdata__item">
            <FieldsView value={v} depth={depth + 1} />
          </div>
        ))}
        <More count={value.length - shown.length} />
      </div>
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return <span className="text-ink-muted">—</span>;
    return (
      <dl className={cx("ui-stepdata", depth > 0 && "ui-stepdata__nest")}>
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{fieldLabel(k)}</dt>
            <dd>
              <FieldsView value={v} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <>{String(value)}</>;
}

/** A labelled value (what went in, what came out), read as fields, with its raw JSON behind a toggle. */
export function DataBlock({
  label,
  value,
  testId,
}: {
  label: string;
  value: unknown;
  testId?: string;
}) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(false);
  const empty =
    value === undefined ||
    value === null ||
    (isPlainObject(value) && Object.keys(value).length === 0);
  return (
    <SheetSection label={label}>
      <div data-testid={testId} className="flex min-w-0 flex-col gap-2">
        {empty ? (
          <p className="text-sm text-ink-muted">{t("stepPanel.nothing")}</p>
        ) : raw ? (
          <pre className="ui-stepraw" data-testid={testId ? `${testId}-raw` : undefined}>
            {JSON.stringify(value, null, 2)}
          </pre>
        ) : (
          <FieldsView value={value} />
        )}
        {empty ? null : (
          <Button
            variant="link"
            size="sm"
            className="self-start"
            aria-pressed={raw}
            data-testid={testId ? `${testId}-toggle` : undefined}
            onClick={() => setRaw(!raw)}
          >
            {raw ? t("stepPanel.raw.hide") : t("stepPanel.raw.show")}
          </Button>
        )}
      </div>
    </SheetSection>
  );
}

// ── The Data tab ──

export interface StepDataEntry {
  key: string;
  kind: "record" | "document" | "change";
  label: ReactNode;
  /** Beside the label: a change's status. */
  end?: ReactNode;
  /** The page for it, where one exists. */
  href?: string | undefined;
}

const DATA_ICON = { record: "receipt", document: "document", change: "arrow" } as const;

/** The records, documents and changes a step made, changed or cited, grouped, with links. */
export function StepDataList({
  entries,
  testId,
  changesLabel,
}: {
  entries: readonly StepDataEntry[];
  testId?: string;
  /** "Changes" in the portal, "Changes to the client's tools" in the back office. */
  changesLabel?: string;
}) {
  const { t } = useI18n();
  if (entries.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid={testId}>
        {t("stepPanel.data.empty")}
      </p>
    );
  }
  const groups: [StepDataEntry["kind"], string][] = [
    ["change", changesLabel ?? t("stepPanel.data.changes")],
    ["record", t("stepPanel.data.records")],
    ["document", t("stepPanel.data.documents")],
  ];
  return (
    <div className="flex flex-col gap-5" data-testid={testId}>
      {groups.map(([kind, label]) => {
        const of = entries.filter((e) => e.kind === kind);
        if (of.length === 0) return null;
        return (
          <SheetSection key={kind} label={`${label} · ${of.length}`}>
            <ul className="ui-stepdatalist" data-testid={testId ? `${testId}-${kind}` : undefined}>
              {of.map((e) => (
                <li key={e.key} data-testid={testId ? `${testId}-${e.key}` : undefined}>
                  <Icon
                    name={DATA_ICON[kind]}
                    size={16}
                    className="ds-icon shrink-0 text-ink-muted"
                  />
                  <span className="min-w-0 flex-1">
                    {e.href ? (
                      <Link to={e.href} className="text-link hover:underline">
                        {e.label}
                      </Link>
                    ) : (
                      e.label
                    )}
                  </span>
                  {e.end ?? null}
                </li>
              ))}
            </ul>
          </SheetSection>
        );
      })}
    </div>
  );
}

/** "Document ·3f9a1c": a document named by its id's tail, as records are. */
export function documentLabel(id: string, t: ReturnType<typeof useI18n>["t"]): string {
  return isUuid(id) ? t("stepPanel.data.document", { tail: `·${id.slice(-6)}` }) : id;
}

/** A step's stored status as a chip's state (its words come from `stepStatusLabel`). */
export function stepChipState(status: string): "done" | "running" | "waiting" | "failed" | "idle" {
  switch (status) {
    case "succeeded":
      return "done";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}
