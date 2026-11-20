// Connectors C5 (docs/connectors-plan.md §7.2): Changes by Mezonas, the client admin's standing say
// over what Mezonas may change on this connection without asking each time: Ask me each time (the
// default), Allow what agents need, or Allow any change; until turned off or for 30 days. On its
// own always needs their yes. Who set it and until when show; a client user reads it.
import {
  connectorAccessRoutes,
  type MezonasMayView,
  type SetMezonasMayBody,
} from "@countersign/core";
import { useState } from "react";
import { useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { ErrorNotice } from "../../ui/primitives";

type Choice = SetMezonasMayBody["choice"];
type Duration = SetMezonasMayBody["duration"];

const CHOICES: { choice: Choice; title: PlainKey; help: PlainKey }[] = [
  { choice: "ask", title: "connectors.may.ask", help: "connectors.may.askHelp" },
  { choice: "needs", title: "connectors.may.needs", help: "connectors.may.needsHelp" },
  { choice: "any", title: "connectors.may.any", help: "connectors.may.anyHelp" },
];

export function MezonasMaySection({
  connectionId,
  value,
  mayEdit,
  onChanged,
}: {
  connectionId: string;
  value: MezonasMayView | null;
  mayEdit: boolean;
  onChanged: (next: MezonasMayView | null) => void;
}) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  // An ended go-ahead covers nothing: the page reads as Ask me each time, and says it ended.
  const current: Choice = value?.active ? value.choice : "ask";
  // DECISION (C5): a new go-ahead starts at For 30 days, as the mockup shows (handy while agents
  // are being set up); the client admin picks Until I turn it off when they want it to last.
  const [duration, setDuration] = useState<Duration>(
    value?.active ? (value.until ? "30_days" : "until_off") : "30_days",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(choice: Choice, length: Duration) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.call(connectorAccessRoutes.portalSetMezonasMay, {
        params: { connectionId },
        body: { choice, duration: length },
      });
      onChanged(res.mezonasMay);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const who = value?.setBy.name ?? t("connectors.someone");
  return (
    <section data-testid="mezonas-may">
      <div className="rounded-t-md border border-b-0 border-line bg-surface-subtle px-4 py-3">
        <h3 className="type-subheading text-ink">{t("connectors.may.title")}</h3>
        <p className="text-sm text-ink-muted">{t("connectors.may.help")}</p>
      </div>
      <div
        role="radiogroup"
        aria-label={t("connectors.may.title")}
        className="flex flex-col overflow-hidden rounded-b-md border border-line bg-surface"
      >
        {CHOICES.map((c) => (
          // biome-ignore lint/a11y/useSemanticElements: the design system's Radio is a button with role=radio.
          <button
            key={c.choice}
            type="button"
            role="radio"
            aria-checked={current === c.choice}
            disabled={!mayEdit || busy}
            data-testid={`mezonas-may-${c.choice}`}
            onClick={() => {
              if (c.choice !== current) void save(c.choice, duration);
            }}
            className="ds-choice items-start border-t border-line px-4 py-3 text-left first:border-t-0 disabled:cursor-default"
          >
            <span className="ds-radio mt-0.5" />
            <span>
              <span className="block font-medium text-ink">{t(c.title)}</span>
              <span className="block text-sm text-ink-muted">{t(c.help)}</span>
            </span>
          </button>
        ))}
        {current !== "ask" ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
            <span className="font-medium text-ink">{t("connectors.may.howLong")}</span>
            <fieldset
              className="ds-seg"
              disabled={!mayEdit || busy}
              data-testid="mezonas-may-duration"
            >
              <legend className="sr-only">{t("connectors.may.howLong")}</legend>
              {(["until_off", "30_days"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={duration === d}
                  data-testid={`mezonas-may-duration-${d}`}
                  onClick={() => {
                    if (d === duration) return;
                    setDuration(d);
                    void save(current, d);
                  }}
                >
                  {t(d === "until_off" ? "connectors.may.untilOff" : "connectors.may.days30")}
                </button>
              ))}
            </fieldset>
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-sm text-ink-muted" data-testid="mezonas-may-note">
        {value && !value.active
          ? t("connectors.may.ended", {
              name: who,
              date: value.until ? fmt.date(value.until) : "",
            })
          : value
            ? value.until
              ? t("connectors.may.setUntil", {
                  name: who,
                  date: fmt.date(value.setAt),
                  until: fmt.date(value.until),
                })
              : t("connectors.may.setUntilOff", { name: who, date: fmt.date(value.setAt) })
            : null}{" "}
        {t("connectors.may.note")}
      </p>
      {mayEdit ? null : (
        <p className="text-sm text-ink-muted" data-testid="mezonas-may-admin-only">
          {t("connectors.may.adminOnly")}
        </p>
      )}
      {error ? <ErrorNotice error={error} /> : null}
    </section>
  );
}
