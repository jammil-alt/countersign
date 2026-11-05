// Human release on the portal (docs/plan.md §1.26, phase 4): on the Access page, each vault item's
// setting (who releases it with a code, by text or email, for one run or some hours), the releases
// live now with Revoke; in the inbox, the code entry for the person the code went to. The client
// admin turns it on or off; we can only turn it on. The page never holds a code once it is sent.
import type { ReleaseWindow } from "@countersign/core";
import { useState } from "react";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { type I18n, useI18n } from "../../i18n/i18n";
import { shortTime } from "../../runs/format";
import { Field, Select, TextInput } from "../../ui/forms";
import { Badge, Button, ErrorNotice, Loading } from "../../ui/primitives";

type View = ResponseOf<typeof apiRoutes.portalAccess>;
type Item = View["items"][number];
type Person = View["people"][number];
type Release = Item["release"];

const HOURS = [1, 2, 4, 8, 12, 24] as const;

/** "Ana releases it with a code by text, for one run." */
export function releaseSummary(release: Release, { t }: Pick<I18n, "t">): string {
  if (release.mode === "off" || !release.person) return t("release.off");
  return t("release.on", {
    person: release.person.name ?? "—",
    channel: release.channel === "sms" ? t("release.byText") : t("release.byEmail"),
    window:
      release.window === "run"
        ? t("release.forRun")
        : t("release.forHours", { count: release.window.hours }),
  });
}

export function ReleaseSection({
  item,
  people,
  canEdit,
  onChanged,
}: {
  item: Item;
  people: Person[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const { release } = item;
  const on = release.mode === "code";
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalSetRelease, {
        params: { connectionId: item.connectionId },
        body: { mode: "off" },
      });
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api.call(apiRoutes.portalRevokeRelease, { params: { id } });
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="mt-4 rounded-md border border-line p-3" data-testid="release-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">{t("release.title")}</p>
        <Badge tone={on ? "person" : "neutral"} testId="release-state">
          {on ? t("release.stateOn") : t("release.stateOff")}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-ink" data-testid="release-summary">
        {releaseSummary(release, i18n)}
      </p>
      <p className="mt-1 text-sm text-ink-muted">{t("release.hint")}</p>

      {on ? (
        <div className="mt-3" data-testid="release-live">
          <p className="mb-1 text-sm font-medium text-ink">{t("release.live")}</p>
          {release.live.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("release.noLive")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {release.live.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  data-testid={`release-live-${r.id}`}
                >
                  <span className="text-ink">
                    {t("release.liveBy", { agent: r.agentName, person: r.person.name ?? "—" })}
                    <span className="text-ink-muted">
                      {" · "}
                      {r.validUntil
                        ? t("release.liveUntil", {
                            time: shortTime(r.validUntil, undefined, i18n),
                          })
                        : t("release.liveRun")}
                    </span>
                  </span>
                  {canEdit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`release-revoke-${r.id}`}
                      onClick={() => void revoke(r.id)}
                    >
                      {t("release.revoke")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {error ? (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      ) : null}

      {editing ? (
        <ReleaseForm
          item={item}
          people={people}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : canEdit ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" data-testid="release-edit" onClick={() => setEditing(true)}>
            {on ? t("release.change") : t("release.turnOn")}
          </Button>
          {on ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="release-turn-off"
              disabled={busy}
              onClick={() => void turnOff()}
            >
              {t("release.turnOff")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {canEdit && on && !editing ? (
        <p className="mt-2 text-sm text-ink-muted">{t("release.offNote")}</p>
      ) : null}
    </div>
  );
}

function ReleaseForm({
  item,
  people,
  onDone,
  onCancel,
}: {
  item: Item;
  people: Person[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const current = item.release;
  const [personId, setPersonId] = useState(current.person?.id ?? people[0]?.id ?? "");
  const person = people.find((p) => p.id === personId);
  const [channel, setChannel] = useState<"sms" | "email">(current.channel);
  const [hours, setHours] = useState<number>(current.window === "run" ? 0 : current.window.hours);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const textBlocked = channel === "sms" && person !== undefined && !person.canText;

  async function save() {
    setBusy(true);
    setError(null);
    const window: ReleaseWindow = hours === 0 ? "run" : { hours };
    try {
      await api.call(apiRoutes.portalSetRelease, {
        params: { connectionId: item.connectionId },
        body: { mode: "code", personId, channel, window },
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="release-form">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label={t("release.person")}>
          <Select
            data-testid="release-person"
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
          >
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ? `${p.name} · ${p.email}` : p.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("release.channel")}>
          <Select
            data-testid="release-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as "sms" | "email")}
          >
            <option value="sms">{t("release.channelText")}</option>
            <option value="email">{t("release.channelEmail")}</option>
          </Select>
        </Field>
        <Field label={t("release.window")}>
          <Select
            data-testid="release-window"
            value={String(hours)}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            <option value="0">{t("release.windowRun")}</option>
            {HOURS.map((h) => (
              <option key={h} value={String(h)}>
                {t("release.windowHours", { count: h })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {textBlocked ? (
        <p className="text-sm text-ink-muted" data-testid="release-no-text">
          {t("release.noText")}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex gap-2">
        <Button
          data-testid="release-save"
          variant="primary"
          disabled={busy || !personId || textBlocked}
          onClick={() => void save()}
        >
          {current.mode === "code" ? t("common.save") : t("release.turnOn")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

type Result = ResponseOf<typeof apiRoutes.portalEnterReleaseCode>["result"];

/**
 * The inbox item's code entry: only for the person the code went to. The code typed is sent once
 * and the field is cleared, whatever came of it.
 */
export function ReleaseCodeEntry({
  inboxItemId,
  onDone,
}: {
  inboxItemId: string;
  onDone: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const state = useApi(apiRoutes.portalReleaseRequest, { params: { id: inboxItemId } });
  const [code, setCode] = useState("");
  const [result, setResult] = useState<Result | "sent" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const request = state.data?.request;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(apiRoutes.portalEnterReleaseCode, {
        params: { id: inboxItemId },
        body: { code },
      });
      setResult(out.result);
      state.reload();
      if (out.result === "released") onDone();
    } catch (e) {
      setError(e);
    } finally {
      setCode("");
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalResendReleaseCode, { params: { id: inboxItemId } });
      setResult("sent");
      state.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (state.loading && !request) return <Loading />;
  if (state.error) return <ErrorNotice error={state.error} onRetry={state.reload} />;
  if (!request) return null;
  if (!request.mine) {
    return (
      <p className="text-sm text-ink-muted" data-testid="release-code-not-mine">
        {t("release.code.notMine")}
      </p>
    );
  }
  const open = request.status === "pending";
  const message =
    result === "released" || request.status === "released"
      ? t("release.code.released")
      : request.status === "failed"
        ? t("release.code.failed")
        : request.status === "expired" || result === "expired"
          ? t("release.code.expired")
          : result === "wrong"
            ? t("release.code.wrong", { count: request.triesLeft })
            : result === "sent"
              ? t("release.code.sent")
              : result === "closed"
                ? t("release.code.closed")
                : null;

  return (
    <div className="flex flex-col gap-3" data-testid="release-code-entry">
      <p className="text-sm text-ink">
        {t("release.code.sentTo", {
          to: request.sentTo,
          time: shortTime(request.expiresAt, undefined, i18n),
        })}
      </p>
      <p className="text-sm text-ink-muted">{t("release.code.replyHint")}</p>
      {open ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && /^\d{6}$/.test(code)) void submit();
          }}
        >
          <Field label={t("release.code.label")}>
            <TextInput
              data-testid="release-code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            data-testid="release-code-submit"
            disabled={busy || !/^\d{6}$/.test(code)}
          >
            {t("release.code.submit")}
          </Button>
        </form>
      ) : null}
      {message ? (
        <p className="text-sm text-ink" data-testid="release-code-message" role="status">
          {message}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {request.resendsLeft > 0 && request.status !== "released" ? (
        <div>
          <Button
            size="sm"
            variant="ghost"
            data-testid="release-code-resend"
            disabled={busy}
            onClick={() => void resend()}
          >
            {t("release.code.resend", { count: request.resendsLeft })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
