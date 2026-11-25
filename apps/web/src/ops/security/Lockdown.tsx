// Lockdown in the back office (docs/plan.md §1.243, docs/lockdown-plan.md §7): what is locked, with
// who, why and since when; locking one client (its settings) or every client (here); unlocking, by
// the security officer only. Each lock stops everything for the client at once, so each asks for
// something typed: the client's name, or "lock everything".
import { type ClientLockRow, LOCK_EVERYTHING_CONFIRM, type LockdownState } from "@countersign/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { EN } from "../../i18n/i18n";
import { Field, TextArea, TextInput } from "../../ui/forms";
import { Loaded } from "../../ui/page";
import { Badge, Button, Card } from "../../ui/primitives";
import { clientPagePath } from "../client/ClientFrame";
import { failureText } from "../screens/ClientComplianceSetting";
import { SecurityPage } from "./SecurityScreens";

const when = (iso: string) => EN.fmt.dateTime(iso);

/** What came in while locked, by kind, in words. Counts only: nothing that came is kept. */
const INBOUND_WORDS: Record<string, string> = {
  email: "Emails",
  webhook: "Webhook calls",
  text: "Texts",
  text_status: "Text receipts",
  call: "Calls",
  call_status: "Call updates",
  voice_agent: "Voice agent calls",
  quickbooks: "QuickBooks notices",
  zoho_crm: "Zoho CRM notices",
  bank_feed: "Bank feed notices",
  google_chat: "Google Chat messages",
  teams: "Teams messages",
  whatsapp: "WhatsApp messages",
  beacon: "Site visits",
  email_event: "Email receipts",
};

export function inboundText(inbound: Record<string, number>): string | null {
  const parts = Object.entries(inbound)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => `${INBOUND_WORDS[kind] ?? kind}: ${n}`);
  return parts.length ? parts.join(" · ") : null;
}

/** "Locked by sam@… on 24 Nov, 14:02." */
function byLine(at: string, by: ClientLockRow["by"]): string {
  return `Locked ${by ? `by ${by.name ?? by.email} ` : ""}on ${when(at)}.`;
}

/** The note an unlock asks for, then the unlock. Only the security officer sees it. */
export function UnlockForm({
  label,
  testId,
  onUnlock,
}: {
  label: string;
  testId: string;
  onUnlock: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  async function unlock() {
    setBusy(true);
    setFailed(null);
    try {
      await onUnlock(note.trim());
      setNote("");
    } catch (error) {
      setFailed(failureText(error, "We couldn't unlock it. Try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 flex flex-col gap-3" data-testid={testId}>
      <Field label="What you found (kept in the client's change log)">
        <TextArea
          data-testid={`${testId}-note`}
          value={note}
          maxLength={500}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div>
        <Button
          variant="primary"
          data-testid={`${testId}-confirm`}
          disabled={busy || !note.trim()}
          onClick={() => void unlock()}
        >
          {label}
        </Button>
      </div>
      <p className="text-sm text-ink-muted">
        Nothing resumes by itself: runs the lock stopped stay stopped, and what came in while locked
        isn't replayed.
      </p>
      {failed ? (
        <p role="alert" className="ds-error text-sm" data-testid={`${testId}-error`}>
          {failed}
        </p>
      ) : null}
    </div>
  );
}

/** A reason and something typed again, then a lock. */
function LockForm({
  confirmLabel,
  confirmWord,
  button,
  testId,
  explain,
  onLock,
}: {
  confirmLabel: string;
  confirmWord: string;
  button: string;
  testId: string;
  explain: ReactNode;
  onLock: (reason: string, typed: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ready =
    reason.trim().length > 0 && typed.trim().toLowerCase() === confirmWord.trim().toLowerCase();
  async function lock() {
    if (!ready) return;
    setBusy(true);
    setFailed(null);
    try {
      await onLock(reason.trim(), typed.trim());
      setReason("");
      setTyped("");
    } catch (error) {
      setFailed(failureText(error, "We couldn't lock it. Try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <p className="text-ink">{explain}</p>
      <Field label="Why (the security officer and the change log see this)">
        <TextArea
          data-testid={`${testId}-reason`}
          value={reason}
          maxLength={500}
          rows={2}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={confirmLabel} className="min-w-64 flex-1">
          <TextInput
            data-testid={`${testId}-typed`}
            value={typed}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>
        <Button
          className="text-risk"
          data-testid={`${testId}-confirm`}
          disabled={busy || !ready}
          onClick={() => void lock()}
        >
          {button}
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="ds-error text-sm" data-testid={`${testId}-error`}>
          {failed}
        </p>
      ) : null}
    </div>
  );
}

const LOCK_EFFECTS =
  "Nothing reads or changes its data, its tools or its AI calls; its runs stop now; its people see a locked page. What providers send is answered and counted, not kept.";

/** Security → Lockdown. */
export function SecurityLockdownScreen() {
  const state = useApi(apiRoutes.opsLockdown);
  return (
    <SecurityPage
      testId="ops-lockdown"
      title="Lockdown"
      subtitle="Stop everything for one client, or for every client, while we look into a security concern. Only the security officer unlocks."
    >
      <Loaded state={state}>{(data) => <LockdownBody data={data} reload={state.reload} />}</Loaded>
    </SecurityPage>
  );
}

function LockdownBody({ data, reload }: { data: LockdownState; reload: () => void }) {
  const api = useApiClient();
  return (
    <div className="flex flex-col gap-8">
      <Card title="Every client" pad testId="ops-lockdown-everything">
        {data.everything ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="risk" testId="ops-lockdown-everything-state">
                Locked
              </Badge>
              <p className="text-ink">{byLine(data.everything.lockedAt, data.everything.by)}</p>
            </div>
            <p className="mt-2 text-sm text-ink-muted">Reason: {data.everything.reason}</p>
            {data.canUnlock ? (
              <UnlockForm
                label="Unlock everything"
                testId="ops-lockdown-unlock-everything"
                onUnlock={async (note) => {
                  await api.call(apiRoutes.opsUnlockEverything, { body: { note } });
                  reload();
                }}
              />
            ) : (
              <p className="mt-4 text-sm text-ink-muted">Only the security officer can unlock.</p>
            )}
          </>
        ) : (
          <LockForm
            testId="ops-lockdown-lock-everything"
            explain={`Locks every client at once. ${LOCK_EFFECTS} Only the security officer can still read them, read only.`}
            confirmLabel={`Type ${LOCK_EVERYTHING_CONFIRM} to confirm`}
            confirmWord={LOCK_EVERYTHING_CONFIRM}
            button="Lock everything"
            onLock={async (reason, typed) => {
              await api.call(apiRoutes.opsLockEverything, { body: { reason, confirm: typed } });
              reload();
            }}
          />
        )}
      </Card>

      <Card title="Locked clients" titleAbove testId="ops-lockdown-clients">
        {data.clients.length === 0 ? (
          <p className="p-5 text-ink-muted" data-testid="ops-lockdown-none">
            No client is locked. Lock one from its settings (Lockdown).
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {data.clients.map((c) => (
              <LockedClientRow
                key={c.clientId}
                row={c}
                canUnlock={data.canUnlock}
                onUnlock={async (note) => {
                  await api.call(apiRoutes.opsUnlockClient, {
                    params: { id: c.clientId },
                    body: { note },
                  });
                  reload();
                }}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function LockedClientRow({
  row,
  canUnlock,
  onUnlock,
}: {
  row: ClientLockRow;
  canUnlock: boolean;
  onUnlock: (note: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const counts = inboundText(row.inbound);
  return (
    <li className="p-5" data-testid={`ops-lockdown-client-${row.clientId}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`${clientPagePath(row.clientId, "settings")}/lockdown`}
            className="font-medium text-ink hover:underline"
          >
            {row.clientName}
          </Link>
          <p className="mt-1 text-sm text-ink-muted">
            {row.side === "client" ? "Locked by the client. " : ""}
            {byLine(row.lockedAt, row.by)}
          </p>
          <p className="mt-1 text-sm text-ink">Reason: {row.reason}</p>
          {counts ? (
            <p className="mt-1 text-sm text-ink-muted" data-testid="ops-lockdown-inbound">
              Answered and dropped since: {counts}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <Badge tone="risk">Locked</Badge>
          {canUnlock ? (
            <Button
              data-testid={`ops-lockdown-unlock-open-${row.clientId}`}
              onClick={() => setOpen((o) => !o)}
            >
              Unlock
            </Button>
          ) : null}
        </div>
      </div>
      {canUnlock && open ? (
        <UnlockForm
          label={`Unlock ${row.clientName}`}
          testId={`ops-lockdown-unlock-${row.clientId}`}
          onUnlock={onUnlock}
        />
      ) : null}
    </li>
  );
}

/** A client's settings → Lockdown: lock it (its name typed), or its lock and, for the officer, unlock. */
export function ClientLockSetting({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const api = useApiClient();
  const state = useApi(apiRoutes.opsLockdown);
  return (
    <div data-testid="ops-client-lockdown">
      <Loaded state={state}>
        {(data) => {
          const row = data.clients.find((c) => c.clientId === clientId);
          if (data.everything && !row) {
            return (
              <Card pad>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="risk">Locked</Badge>
                  <p className="text-ink">
                    Every client is locked.{" "}
                    <Link to="/ops/security/lockdown" className="underline">
                      See Lockdown
                    </Link>
                    .
                  </p>
                </div>
              </Card>
            );
          }
          if (row) {
            const counts = inboundText(row.inbound);
            return (
              <Card pad>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="risk" testId="ops-client-lock-state">
                    Locked
                  </Badge>
                  <p className="text-ink">
                    {row.side === "client" ? "Locked by the client. " : ""}
                    {byLine(row.lockedAt, row.by)}
                  </p>
                </div>
                <p className="mt-2 text-sm text-ink">Reason: {row.reason}</p>
                {counts ? (
                  <p className="mt-1 text-sm text-ink-muted">
                    Answered and dropped since: {counts}
                  </p>
                ) : null}
                {data.canUnlock ? (
                  <UnlockForm
                    label={`Unlock ${clientName}`}
                    testId="ops-client-unlock"
                    onUnlock={async (note) => {
                      await api.call(apiRoutes.opsUnlockClient, {
                        params: { id: clientId },
                        body: { note },
                      });
                      state.reload();
                    }}
                  />
                ) : (
                  <p className="mt-4 text-sm text-ink-muted">
                    Only the security officer can unlock.
                  </p>
                )}
              </Card>
            );
          }
          return (
            <Card pad>
              <LockForm
                testId="ops-client-lock"
                explain={`Locks ${clientName} at once. ${LOCK_EFFECTS} Its admins are emailed, and so is the security officer.`}
                confirmLabel={`Type ${clientName} to confirm`}
                confirmWord={clientName}
                button="Lock down"
                onLock={async (reason, typed) => {
                  await api.call(apiRoutes.opsLockClient, {
                    params: { id: clientId },
                    body: { reason, confirmName: typed },
                  });
                  state.reload();
                }}
              />
            </Card>
          );
        }}
      </Loaded>
    </div>
  );
}

/**
 * Every back-office page, while anything is locked: a risk banner saying what, since when, by
 * whom and why, linked to Lockdown. Asked again on each page change, so a lock made elsewhere shows.
 */
export function LockdownBanner() {
  const state = useApi(apiRoutes.opsLockdown);
  const { pathname } = useLocation();
  const { reload } = state;
  const first = useRef(pathname);
  useEffect(() => {
    if (pathname === first.current) return;
    first.current = pathname;
    reload();
  }, [pathname, reload]);
  const data = state.data;
  if (!data || (!data.everything && data.clients.length === 0)) return null;
  const [only] = data.clients;
  const text = data.everything
    ? `Every client is locked. ${byLine(data.everything.lockedAt, data.everything.by)} Reason: ${data.everything.reason}`
    : data.clients.length === 1 && only
      ? `${only.clientName} is locked. ${byLine(only.lockedAt, only.by)} Reason: ${only.reason}`
      : `${data.clients.length} clients are locked: ${data.clients.map((c) => c.clientName).join(", ")}.`;
  return (
    <div role="status" className="ds-banner mb-4 items-center" data-testid="ops-lockdown-banner">
      <span className="min-w-0 flex-1">{text}</span>
      <Link to="/ops/security/lockdown" className="font-medium underline">
        Lockdown
      </Link>
    </div>
  );
}
