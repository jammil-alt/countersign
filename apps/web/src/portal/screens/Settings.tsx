// `/settings` (client admins): the people who use the portal and the invite form, the emails we'll
// send, and who approves changes to the client's tools (Mezonas sets that). Notification emails
// come later (M11); the choices are stored now.
import type { NotificationSettings } from "@countersign/core";
import { useEffect, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { InviteForm, MemberList } from "../../people/People";
import { useSession } from "../../session/session";
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";

export function PortalSettingsScreen() {
  const { t } = useI18n();
  const session = useSession();
  const role = session.tenants.find((x) => x.id === session.activeTenantId)?.role;
  if (role !== "client_admin") {
    return (
      <div>
        <PageHeader title={t("nav.settings")} />
        <p className="text-ink-muted" data-testid="portal-settings-admin-only">
          {t("settings.adminOnly")}
        </p>
      </div>
    );
  }
  return <AdminSettings />;
}

function AdminSettings() {
  const { t } = useI18n();
  const client = useApiClient();
  const users = useApi(apiRoutes.portalUsers);
  const settings = useApi(apiRoutes.portalSettings);

  return (
    <div>
      <PageHeader
        title={t("nav.settings")}
        subtitle={
          users.data ? t("settings.peopleCount", { count: users.data.users.length }) : undefined
        }
      />
      <section data-testid="portal-settings-people">
        <SectionLabel>{t("settings.people")}</SectionLabel>
        {users.loading && !users.data ? <Loading /> : null}
        {users.error ? <ErrorNotice error={users.error} onRetry={users.reload} /> : null}
        {users.data ? <MemberList members={users.data.users} testId="portal-users" /> : null}
        <InviteForm
          surface="portal"
          testId="portal-invite"
          onInvite={async (body) => {
            const result = await client.call(apiRoutes.portalInvite, { body });
            users.reload();
            return result;
          }}
        />
      </section>

      {settings.error ? <ErrorNotice error={settings.error} onRetry={settings.reload} /> : null}
      {settings.data ? (
        <>
          <Notifications initial={settings.data.notifications} emailsOn={settings.data.emailsOn} />
          <section className="mt-8" data-testid="portal-settings-approvals">
            <SectionLabel>{t("settings.approvals")}</SectionLabel>
            <Card className="p-5">
              <p className="text-ink">
                {settings.data.approvals === "operator"
                  ? t("settings.approvals.byUs")
                  : t("settings.approvals.byYou")}
              </p>
              <p className="mt-1 text-sm text-ink-muted">{t("settings.approvals.howToChange")}</p>
            </Card>
          </section>
        </>
      ) : null}
    </div>
  );
}

const NOTIFICATION_LABELS: [keyof NotificationSettings, PlainKey, PlainKey][] = [
  ["itemsWaiting", "settings.email.itemsWaiting", "settings.email.itemsWaitingHelp"],
  ["weeklyDigest", "settings.email.weeklyDigest", "settings.email.weeklyDigestHelp"],
];

function Notifications({
  initial,
  emailsOn,
}: {
  initial: NotificationSettings;
  emailsOn: boolean;
}) {
  const { t } = useI18n();
  const client = useApiClient();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setSaved(initial);
    setDraft(initial);
  }, [initial]);
  const changed =
    draft.itemsWaiting !== saved.itemsWaiting || draft.weeklyDigest !== saved.weeklyDigest;

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const { notifications } = await client.call(apiRoutes.portalNotifications, { body: draft });
      setSaved(notifications);
      setDraft(notifications);
      setNote(t("settings.saved"));
    } catch {
      setNote(t("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8" data-testid="portal-settings-notifications">
      <SectionLabel
        action={
          emailsOn ? null : (
            <Badge testId="portal-notifications-off">{t("settings.emailsSoon")}</Badge>
          )
        }
      >
        {t("settings.emails")}
      </SectionLabel>
      <Card className="p-5">
        <ul className="flex flex-col gap-3">
          {NOTIFICATION_LABELS.map(([key, title, text]) => (
            <li key={key}>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-slate"
                  data-testid={`portal-notifications-${key}`}
                  checked={draft[key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))}
                />
                <span>
                  <span className="block font-medium text-ink">{t(title)}</span>
                  <span className="block text-sm text-ink-muted">{t(text)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {emailsOn ? null : (
          <p className="mt-4 text-sm text-ink-muted">{t("settings.emailsNotYet")}</p>
        )}
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="primary"
            disabled={!changed || busy}
            onClick={() => void save()}
            data-testid="portal-notifications-save"
          >
            {t("common.save")}
          </Button>
          {note ? (
            <span role="status" className="text-sm text-ink-muted">
              {note}
            </span>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
