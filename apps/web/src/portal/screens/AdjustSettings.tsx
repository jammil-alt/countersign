// The agent's Settings tab: what the client may adjust (docs/builder-plan.md §7, B5). Each setting
// we marked as adjustable, with its limits and its value now. The client admin changes one here:
// within its limits (or stricter), it applies at once; beyond them it comes to us as a request,
// which the client follows on Requests. Read from `/api/services/:id/adjustable`: the settings'
// own words and values, never which skill, parameter or step they set (invariant 11). Approvals,
// permissions and steps are never here: they are ours.

import { type AdjustResult, type AdjustRowView, adjustRoutes } from "@countersign/core";
import { useState } from "react";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { Select, TextInput } from "../../ui/forms";
import { Loaded } from "../../ui/page";
import { Button, Card, ErrorNotice, Tag } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";

/** A value "other" in a schedule's list: the person asks for one we don't offer. */
const OTHER = "__other__";

export function AdjustSettings({
  id,
  name,
  isAdmin,
  scheduleText,
}: {
  id: string;
  name: string | null;
  isAdmin: boolean;
  /** A schedule's cron in the reader's words ("Weekdays at 7:00 AM"). */
  scheduleText: (cron: string) => string;
}) {
  const { t } = useI18n();
  const state = useApi(adjustRoutes.portalAgentAdjustable, { params: { id } });
  const [settings, setSettings] = useState<AdjustRowView[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Nothing marked: the card stays away, as the agent has nothing to adjust.
  const list = settings ?? state.data?.settings ?? [];
  if (state.data && list.length === 0) return null;
  const done = (row: AdjustRowView, out: AdjustResult) => {
    setSettings(out.settings);
    const value =
      row.kind === "schedule"
        ? scheduleText(out.settings.find((s) => s.id === row.id)?.current ?? "")
        : (out.settings.find((s) => s.id === row.id)?.current ?? "");
    setNotice(
      out.outcome === "requested" && out.request
        ? t("adjust.requested", { number: String(out.request.number) })
        : out.outcome === "unchanged"
          ? t("adjust.unchanged", { label: row.label, value })
          : t("adjust.applied", { label: row.label, value }),
    );
  };
  return (
    <Card titleAbove title={t("adjust.title")} testId="agent-adjust">
      <Loaded state={state} skeleton={<SkeletonRows rows={2} columns={2} />}>
        {() => (
          <div className="flex flex-col">
            <p className="px-6 pt-4 text-sm text-ink-muted max-sm:px-4">
              {isAdmin ? t("adjust.help", { name: name ?? "" }) : t("adjust.adminOnly")}
            </p>
            {notice ? (
              <p
                className="px-6 pt-3 text-sm text-ink max-sm:px-4"
                role="status"
                data-testid="agent-adjust-notice"
              >
                {notice}
              </p>
            ) : null}
            <ul className="divide-y divide-line">
              {list.map((row) => (
                <AdjustRow
                  key={row.id}
                  agentId={id}
                  row={row}
                  canChange={isAdmin}
                  scheduleText={scheduleText}
                  onDone={(out) => done(row, out)}
                />
              ))}
            </ul>
          </div>
        )}
      </Loaded>
    </Card>
  );
}

function AdjustRow({
  agentId,
  row,
  canChange,
  scheduleText,
  onDone,
}: {
  agentId: string;
  row: AdjustRowView;
  canChange: boolean;
  scheduleText: (cron: string) => string;
  onDone(out: AdjustResult): void;
}) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.current ?? "");
  const [other, setOther] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const words = (v: string | null) =>
    v === null ? t("adjust.notSet") : row.kind === "schedule" ? scheduleText(v) : v;
  const limits =
    row.min !== null && row.max !== null
      ? t("adjust.between", { min: row.min, max: row.max })
      : row.min !== null
        ? t("adjust.atLeast", { min: row.min })
        : row.max !== null
          ? t("adjust.atMost", { max: row.max })
          : null;
  const asked = value === OTHER ? other.trim() : value.trim();

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(adjustRoutes.portalAgentAdjust, {
        params: { id: agentId, settingId: row.id },
        body: { value: asked, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      setEditing(false);
      setNote("");
      onDone(out);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className="flex flex-col gap-1 px-6 py-4 max-sm:px-4"
      data-testid={`agent-adjust-${row.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{row.label}</span>
        <span className="text-ink" data-testid={`agent-adjust-${row.id}-value`}>
          {words(row.current)}
        </span>
      </div>
      {row.hint ? <p className="text-sm text-ink-muted">{row.hint}</p> : null}
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        {limits ? <Tag>{limits}</Tag> : null}
        {row.tighter ? (
          <span>
            {row.tighter === "lower" ? t("adjust.tighterLower") : t("adjust.tighterHigher")}
          </span>
        ) : null}
      </div>
      {row.changedAt && row.changedSide ? (
        <p className="text-sm text-ink-muted" data-testid={`agent-adjust-${row.id}-by`}>
          {row.changedBy
            ? t("manual.changedBy", { who: row.changedBy, date: fmt.date(row.changedAt) })
            : t("manual.changedByUs", { date: fmt.date(row.changedAt) })}
        </p>
      ) : null}
      {canChange && !editing ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`agent-adjust-${row.id}-change`}
            onClick={() => {
              setValue(row.current ?? "");
              setEditing(true);
            }}
          >
            {t("adjust.change")}
          </Button>
        </div>
      ) : null}
      {canChange && editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            {row.options ? (
              <Select
                className="w-72"
                aria-label={row.label}
                data-testid={`agent-adjust-${row.id}-input`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              >
                {row.options.map((o) => (
                  <option key={o} value={o}>
                    {row.kind === "schedule" ? scheduleText(o) : o}
                  </option>
                ))}
                <option value={OTHER}>{t("adjust.other")}</option>
              </Select>
            ) : (
              <TextInput
                className="w-60"
                aria-label={row.label}
                data-testid={`agent-adjust-${row.id}-input`}
                value={value}
                maxLength={2000}
                inputMode={row.kind === "number" || row.kind === "money" ? "decimal" : undefined}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            {value === OTHER ? (
              <TextInput
                className="w-60"
                aria-label={t("adjust.otherWhat")}
                placeholder={t("adjust.otherWhat")}
                data-testid={`agent-adjust-${row.id}-other`}
                value={other}
                maxLength={2000}
                onChange={(e) => setOther(e.target.value)}
              />
            ) : null}
          </div>
          <TextInput
            aria-label={t("adjust.why")}
            placeholder={t("adjust.why")}
            data-testid={`agent-adjust-${row.id}-note`}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !asked}
              data-testid={`agent-adjust-${row.id}-save`}
              onClick={() => void send()}
            >
              {t("common.save")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </li>
  );
}
