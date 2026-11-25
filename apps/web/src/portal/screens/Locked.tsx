// Lockdown in the portal (docs/plan.md §1.243, docs/lockdown-plan.md §7): the locked page, shown in
// place of any screen once the API answers 423 `client_locked`, with no data on it; and, in Settings,
// a client admin's "Lock our account". The page never shows our reason; a lock the client's own side
// made shows theirs, and a client admin may lift it.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient, useApiStore } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { clearLocked } from "../../lockdown/locked";
import { Field, TextArea } from "../../ui/forms";
import { Button, Card } from "../../ui/primitives";

/** The page every screen gives way to while the account is locked. */
export function LockedPage() {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const store = useApiStore();
  const state = useApi(apiRoutes.accountLock);
  const lock = state.data;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function unlock() {
    setBusy(true);
    setFailed(false);
    try {
      await api.call(apiRoutes.accountUnlock, { body: { note: note.trim() } });
      // Every screen asks again: the answers kept from while it was locked were refusals.
      store.clear();
      clearLocked();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const ours = lock?.side !== "client";
  return (
    <div className="mx-auto max-w-xl py-10" data-testid="portal-locked">
      <Card pad>
        <h1 className="text-lg font-semibold text-ink">{t("lockdown.title")}</h1>
        <p className="mt-3 text-ink" data-testid="portal-locked-body">
          {ours
            ? t("lockdown.ours")
            : t("lockdown.yours", { when: lock?.lockedAt ? fmt.dateTime(lock.lockedAt) : "" })}
        </p>
        {lock?.reason ? (
          <p className="mt-2 text-sm text-ink-muted" data-testid="portal-locked-reason">
            {t("lockdown.reason", { reason: lock.reason })}
          </p>
        ) : null}
        {lock?.canUnlock ? (
          <div className="mt-5 flex flex-col gap-3" data-testid="portal-unlock">
            <Field label={t("lockdown.noteLabel")}>
              <TextArea
                data-testid="portal-unlock-note"
                value={note}
                maxLength={500}
                rows={2}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <div>
              <Button
                variant="primary"
                data-testid="portal-unlock-confirm"
                disabled={busy || !note.trim()}
                onClick={() => void unlock()}
              >
                {busy ? t("lockdown.unlocking") : t("lockdown.unlock")}
              </Button>
            </div>
            <p className="text-sm text-ink-muted">{t("lockdown.resume")}</p>
            {failed ? (
              <p role="alert" className="ds-error text-sm" data-testid="portal-unlock-error">
                {t("lockdown.unlockFailed")}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-sm text-ink-muted">{t("lockdown.contact")}</p>
        )}
      </Card>
    </div>
  );
}

/** Settings → General, for a client admin: lock the account, with what happened. */
export function LockAccountCard() {
  const { t } = useI18n();
  const api = useApiClient();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function lock() {
    setBusy(true);
    setFailed(false);
    try {
      await api.call(apiRoutes.accountLockSet, { body: { reason: reason.trim() } });
      setReason("");
      // The next call is answered 423 and the locked page takes over; ask one now so it does.
      await api.call(apiRoutes.portalOverview).catch(() => undefined);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card pad testId="portal-settings-lock" title={t("lockdown.settingsTitle")}>
      <p className="text-sm text-ink-muted">{t("lockdown.settingsBody")}</p>
      <div className="mt-3 flex flex-col gap-3">
        <Field label={t("lockdown.reasonLabel")}>
          <TextArea
            data-testid="portal-settings-lock-reason"
            value={reason}
            maxLength={500}
            rows={2}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div>
          <Button
            className="text-risk"
            data-testid="portal-settings-lock-confirm"
            disabled={busy || !reason.trim()}
            onClick={() => void lock()}
          >
            {busy ? t("lockdown.locking") : t("lockdown.lock")}
          </Button>
        </div>
        {failed ? (
          <p role="alert" className="ds-error text-sm" data-testid="portal-settings-lock-error">
            {t("lockdown.lockFailed")}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
