// `/settings` (C7, docs/ui-plan.md; Review 1): your settings, one section at a time, with the
// section list beside it (each section has its own address, so nothing is one long scroll).
// - General (`/settings`): your own notifications and language, the team's emails (the admin), and
//   what Sloan is.
// - Approvals (`/settings/approvals`): who approves changes to your tools, who approves what on
//   your team, the undo window, and the approver rules (read-only unless the admin tightens them).
// - Team (`/settings/team`): who uses the portal, and invites (the admin).
// The client admin also has Billing (credits, statements, what happens when credits run out),
// Exports, Conversations (WhatsApp capture) and Voice samples. Never what the work cost us
// (invariant 11).
import type { MyNotifications, NotificationSettings, OnCreditsOut } from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi, useApiClient } from "../../api/useApi";
import { PortalTeamApprovals } from "../../approvals/TeamApprovals";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { LanguageMenu } from "../../i18n/LanguageMenu";
import { useSession } from "../../session/session";
import { AgentBadge } from "../../ui/badges";
import { Loaded, Page, Section } from "../../ui/page";
import { Badge, Button, Card, EmptyState, ErrorNotice, PageHeader } from "../../ui/primitives";
import { PORTAL_PATHS } from "../paths";
import { PortalApproverRules } from "./ApproverRules";
import { PortalBillingScreen } from "./Billing";
import { PortalConversationsScreen } from "./Conversations";
import { PortalExportsScreen } from "./Exports";
import { PortalTeamScreen } from "./Team";
// P-8
import { PortalTextingRegistration } from "./TextingRegistration";
import { VoiceSamples } from "./VoiceSamples";

export type SettingsSection =
  | "general"
  | "approvals"
  | "team"
  | "billing"
  | "exports"
  | "conversations"
  | "voice"
  // P-8: US texting registration (docs/plan.md §1.70)
  | "texting";

const SECTION_WORDS: Record<SettingsSection, PlainKey> = {
  general: "settingsPage.general",
  approvals: "settingsPage.approvals",
  team: "settingsPage.team",
  billing: "settingsPage.billing",
  exports: "settingsPage.exports",
  conversations: "settingsPage.conversations",
  voice: "settingsPage.voice",
  texting: "settingsPage.texting",
};

const SECTION_PATH: Record<SettingsSection, string> = {
  general: PORTAL_PATHS.settings,
  approvals: PORTAL_PATHS.approvals,
  team: PORTAL_PATHS.team,
  billing: PORTAL_PATHS.billing,
  exports: PORTAL_PATHS.exports,
  conversations: PORTAL_PATHS.conversations,
  voice: PORTAL_PATHS.voice,
  texting: PORTAL_PATHS.texting,
};

/** The sections everyone has; the client admin has the rest too. */
const EVERYONE: readonly SettingsSection[] = ["general", "approvals", "team"];
const ADMIN: readonly SettingsSection[] = [
  "general",
  "approvals",
  "team",
  "billing",
  "exports",
  "conversations",
  "voice",
  "texting",
];

/** What a client user reads on an admin's section, where the section has words of its own. */
const ADMIN_ONLY: Partial<Record<SettingsSection, PlainKey>> = {
  exports: "exports.adminOnly",
  conversations: "conversations.adminOnly",
  texting: "texting.adminOnly",
};

export function PortalSettingsScreen({ section = "general" }: { section?: SettingsSection }) {
  const { t } = useI18n();
  const session = useSession();
  const role = session.tenants.find((x) => x.id === session.activeTenantId)?.role;
  const isAdmin = role === "client_admin";
  const sections = isAdmin ? ADMIN : EVERYONE;

  return (
    <Page testId="portal-settings">
      <PageHeader
        title={t("nav.settings")}
        subtitle={isAdmin ? t("settingsPage.subtitle") : t("settingsPage.subtitleMember")}
      />
      <div className="ui-settings">
        <nav className="ui-settings__nav" aria-label={t("common.sections")}>
          {sections.map((s) => (
            <NavLink
              key={s}
              to={SECTION_PATH[s]}
              end
              className="ds-navitem ui-navitem"
              data-testid={`portal-settings-nav-${s}`}
            >
              {t(SECTION_WORDS[s])}
            </NavLink>
          ))}
        </nav>
        <div className="ui-settings__body" data-testid={`portal-settings-section-${section}`}>
          {!sections.includes(section) ? (
            <EmptyState>{t(ADMIN_ONLY[section] ?? "settings.adminOnly")}</EmptyState>
          ) : (
            <Body section={section} isAdmin={isAdmin} />
          )}
        </div>
      </div>
    </Page>
  );
}

function Body({ section, isAdmin }: { section: SettingsSection; isAdmin: boolean }) {
  const { t } = useI18n();
  const title = t(SECTION_WORDS[section]);
  switch (section) {
    case "general":
      return (
        <Part title={title}>
          <NotificationsPart isAdmin={isAdmin} />
          <Card pad testId="portal-settings-language" title={t("settingsPage.language")}>
            <p className="text-sm text-ink-muted">{t("settingsPage.languageBody")}</p>
            <LanguageMenu />
          </Card>
          <SloanCard />
        </Part>
      );
    case "approvals":
      return (
        <Part title={title}>
          {isAdmin ? (
            <WhoApproves />
          ) : (
            <Card pad testId="portal-settings-approvals-member">
              <p className="text-sm text-ink-muted">{t("settings.approvals.askAdmin")}</p>
            </Card>
          )}
          <PortalTeamApprovals isAdmin={isAdmin} />
          <PortalApproverRules />
        </Part>
      );
    case "team":
      return (
        <Part title={title}>
          <PortalTeamScreen embedded />
        </Part>
      );
    case "billing":
      return (
        <Part title={title}>
          <CreditsOut />
          <PortalBillingScreen embedded />
        </Part>
      );
    case "exports":
      return (
        <Part title={title} subtitle={t("exports.subtitle")}>
          <PortalExportsScreen embedded />
        </Part>
      );
    case "conversations":
      return (
        <Part title={title} subtitle={t("conversations.subtitle")}>
          <PortalConversationsScreen embedded />
        </Part>
      );
    case "voice":
      return (
        <Part title={title}>
          <VoiceSamples />
        </Part>
      );
    case "texting":
      return (
        <Part title={title} subtitle={t("texting.subtitle")}>
          <PortalTextingRegistration />
        </Part>
      );
  }
}

function Part({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Section title={title}>
      {subtitle ? <p className="text-sm text-ink-muted">{subtitle}</p> : null}
      {children}
    </Section>
  );
}

/** What Sloan is, where it is offered: the search box's "Ask Sloan". */
function SloanCard() {
  const { t } = useI18n();
  return (
    <Card pad testId="portal-settings-sloan" title={t("nav.sloan")}>
      <div className="flex items-start gap-3">
        <AgentBadge name="Sloan" size="sm" />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm text-ink">{t("settingsPage.sloanBody")}</p>
          <Link
            to={PORTAL_PATHS.sloan}
            className="text-sm text-link hover:underline"
            data-testid="portal-settings-sloan-open"
          >
            {t("settingsPage.sloanOpen")}
          </Link>
        </div>
      </div>
    </Card>
  );
}

const CREDITS_OUT_WORDS: Record<OnCreditsOut, PlainKey> = {
  continue: "settingsPage.creditsOut.continue",
  pause: "settingsPage.creditsOut.pause",
};

/** If credits run out: keep working and add credits, or pause the agents until next month. */
function CreditsOut() {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const state = useApi(apiRoutes.portalCreditsOut);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function choose(onCreditsOut: OnCreditsOut) {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalSetCreditsOut, { body: { onCreditsOut } });
      state.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("settingsPage.creditsOut")} testId="portal-settings-credits-out">
      <div className="ui-card__body">
        <Loaded state={state}>
          {(data) => (
            <div className="flex flex-col gap-3">
              <div
                role="radiogroup"
                aria-label={t("settingsPage.creditsOut")}
                className="flex flex-col gap-2"
              >
                {(["continue", "pause"] as const).map((choice) => {
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: the design system's Radio is a button with role=radio.
                    <button
                      key={choice}
                      type="button"
                      role="radio"
                      aria-checked={data.onCreditsOut === choice}
                      disabled={busy}
                      data-testid={`portal-credits-out-${choice}`}
                      onClick={() => void choose(choice)}
                      className="ds-choice items-start text-left"
                    >
                      <span className="ds-radio mt-0.5" />
                      <span>
                        <span className="block text-ink">{t(CREDITS_OUT_WORDS[choice])}</span>
                        <span className="block text-sm text-ink-muted">
                          {choice === "continue"
                            ? t("settingsPage.creditsOut.continueHelp", {
                                block: fmt.number(data.creditBlock),
                              })
                            : t("settingsPage.creditsOut.pauseHelp")}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {data.pausedForCredits.length > 0 ? (
                <p className="text-sm text-risk" data-testid="portal-credits-out-paused">
                  {t("settingsPage.creditsOut.paused", {
                    names: data.pausedForCredits.map((s) => s.name).join(", "),
                  })}
                </p>
              ) : null}
              {error ? <ErrorNotice error={error} /> : null}
            </div>
          )}
        </Loaded>
      </div>
    </Card>
  );
}

/** Who approves changes to your tools: us or you (Mezonas sets it). */
function WhoApproves() {
  const { t } = useI18n();
  const settings = useApi(apiRoutes.portalSettings);
  if (settings.error) return <ErrorNotice error={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return null;
  return (
    <Card pad testId="portal-settings-approvals">
      <p className="text-ink">
        {settings.data.approvals === "operator"
          ? t("settings.approvals.byUs")
          : t("settings.approvals.byYou")}
      </p>
      <p className="mt-1 text-sm text-ink-muted">
        {t("settings.approvals.howToChange")}{" "}
        <Link to={PORTAL_PATHS.accounts} className="text-link hover:underline">
          {t("settings.approvals.accountsLink")}
        </Link>
      </p>
    </Card>
  );
}

/**
 * Your notifications and, for the admin, the team's emails.
 */
// DECISION (QA round 1): hidden until we send these emails (`emailsOn`), so no "we don't send these
// yet" and no Save for nothing.
function NotificationsPart({ isAdmin }: { isAdmin: boolean }) {
  const mine = useApi(apiRoutes.portalMyNotifications);
  if (mine.data?.emailsOn !== true) return null;
  return (
    <>
      <MyNotificationsCard state={mine} />
      {isAdmin ? <TeamNotifications /> : null}
    </>
  );
}

/** Your own emails and texts from Mezonas. */
function MyNotificationsCard({ state }: { state: ApiState<MyNotifications> }) {
  const { t } = useI18n();
  const api = useApiClient();
  const [saved, setSaved] = useState<MyNotifications | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const view = saved ?? state.data;

  async function set(body: { email: boolean; sms: boolean }) {
    setBusy(true);
    setError(null);
    try {
      setSaved(await api.call(apiRoutes.portalSetMyNotifications, { body }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("settingsPage.mine")} testId="portal-settings-mine">
      <div className="ui-card__body">
        {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
        {view ? (
          <ul className="flex flex-col gap-3">
            <li>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-slate"
                  data-testid="portal-mine-email"
                  checked={view.email}
                  disabled={busy}
                  onChange={(e) => void set({ email: e.target.checked, sms: view.sms })}
                />
                <span>
                  <span className="block font-medium text-ink">{t("settingsPage.mine.email")}</span>
                  <span className="block text-sm text-ink-muted">
                    {view.emailsOn ? t("settingsPage.mine.emailHelp") : t("settings.emailsNotYet")}
                  </span>
                </span>
              </label>
            </li>
            <li>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-slate"
                  data-testid="portal-mine-sms"
                  checked={view.sms}
                  disabled={busy || !view.canText}
                  onChange={(e) => void set({ email: view.email, sms: e.target.checked })}
                />
                <span>
                  <span className="block font-medium text-ink">{t("settingsPage.mine.sms")}</span>
                  <span className="block text-sm text-ink-muted">
                    {view.canText
                      ? t("settingsPage.mine.smsHelp")
                      : t("settingsPage.mine.cantText")}
                  </span>
                </span>
              </label>
            </li>
          </ul>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Card>
  );
}

const NOTIFICATION_LABELS: [keyof NotificationSettings, PlainKey, PlainKey][] = [
  ["itemsWaiting", "settings.email.itemsWaiting", "settings.email.itemsWaitingHelp"],
  ["weeklyDigest", "settings.email.weeklyDigest", "settings.email.weeklyDigestHelp"],
];

/** The emails we send the client's people (the admin chooses). */
function TeamNotifications() {
  const settings = useApi(apiRoutes.portalSettings);
  if (settings.error) return <ErrorNotice error={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return null;
  return <Notifications initial={settings.data.notifications} emailsOn={settings.data.emailsOn} />;
}

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
    <Card
      title={t("settingsPage.teamEmails")}
      meta={
        emailsOn ? null : (
          <Badge testId="portal-notifications-off">{t("settings.emailsSoon")}</Badge>
        )
      }
      testId="portal-settings-notifications"
    >
      <div className="ui-card__body">
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
      </div>
    </Card>
  );
}
