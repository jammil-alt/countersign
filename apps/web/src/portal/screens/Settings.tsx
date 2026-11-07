// `/settings` (C7, docs/ui-plan.md): your company's settings in one place, with a section list
// beside them. Everyone: their own notifications and language, and who signs what (the approver
// rules, read-only unless the admin tightens them). The client admin also: billing (this month's
// credits, with statements on `/settings/billing`), what happens when credits run out, the people
// who use the portal and invites, and the team's emails. Never what the work cost us (invariant 11).
import type { MyNotifications, NotificationSettings, OnCreditsOut } from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi, useApiClient } from "../../api/useApi";
import { CreditMeter } from "../../billing/parts";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { LanguageMenu } from "../../i18n/LanguageMenu";
import { useSession } from "../../session/session";
import { Icon } from "../../ui/icons";
import { Loaded, Page, Section } from "../../ui/page";
import { Badge, Button, buttonClass, Card, ErrorNotice, PageHeader } from "../../ui/primitives";
import { PORTAL_PATHS } from "../paths";
import { PortalApproverRules } from "./ApproverRules";

type SectionId = "billing" | "team" | "signoff" | "notifications" | "language";

const SECTION_WORDS: Record<SectionId, PlainKey> = {
  billing: "settingsPage.billing",
  team: "settingsPage.team",
  signoff: "settingsPage.signoff",
  notifications: "settingsPage.notifications",
  language: "settingsPage.language",
};

export function PortalSettingsScreen() {
  const { t } = useI18n();
  const session = useSession();
  const role = session.tenants.find((x) => x.id === session.activeTenantId)?.role;
  const isAdmin = role === "client_admin";
  // DECISION (QA round 1): Notifications stays hidden until we send these emails (`emailsOn`), so
  // no "we don't send these yet" and no Save for nothing. Language saves as it is chosen.
  const mine = useApi(apiRoutes.portalMyNotifications);
  const emailsOn = mine.data?.emailsOn === true;
  const sections = (
    isAdmin
      ? (["billing", "team", "signoff", "notifications", "language"] as const)
      : (["signoff", "notifications", "language"] as const)
  ).filter((s): s is SectionId => s !== "notifications" || emailsOn);

  return (
    <Page testId="portal-settings">
      <PageHeader
        title={t("nav.settings")}
        subtitle={isAdmin ? t("settingsPage.subtitle") : t("settingsPage.subtitleMember")}
      />
      <div className="ui-settings">
        <nav className="ui-settings__nav" aria-label={t("common.sections")}>
          {sections.map((s) => (
            <a key={s} href={`#${s}`} className="ds-navitem ui-navitem">
              {t(SECTION_WORDS[s])}
            </a>
          ))}
        </nav>
        <div className="ui-settings__body">
          {isAdmin ? (
            <>
              <Anchor id="billing" title={t("settingsPage.billing")}>
                <Plan />
                <CreditsOut />
              </Anchor>
              <Anchor id="team" title={t("settingsPage.team")}>
                <Team />
              </Anchor>
            </>
          ) : (
            <p className="text-sm text-ink-muted" data-testid="portal-settings-admin-only">
              {t("settings.adminOnly")}
            </p>
          )}
          <Anchor id="signoff" title={t("settingsPage.signoff")}>
            {isAdmin ? (
              <WhoApproves />
            ) : (
              <Card pad testId="portal-settings-approvals-member">
                <p className="text-sm text-ink-muted">{t("settings.approvals.askAdmin")}</p>
                <div className="mt-2">
                  <TeamLink />
                </div>
              </Card>
            )}
            <PortalApproverRules />
          </Anchor>
          {emailsOn ? (
            <Anchor id="notifications" title={t("settingsPage.notifications")}>
              <MyNotificationsCard state={mine} />
              {isAdmin ? <TeamNotifications /> : null}
            </Anchor>
          ) : null}
          <Anchor id="language" title={t("settingsPage.language")}>
            <Card pad testId="portal-settings-language">
              <p className="text-sm text-ink-muted">{t("settingsPage.languageBody")}</p>
              <LanguageMenu />
            </Card>
          </Anchor>
        </div>
      </div>
    </Page>
  );
}

function Anchor({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div id={id} className="scroll-mt-6">
      <Section title={title}>{children}</Section>
    </div>
  );
}

/** This month's credits, with the statements a click away. */
function Plan() {
  const { t, fmt } = useI18n();
  const state = useApi(apiRoutes.portalBilling);
  return (
    <Card
      title={t("settingsPage.plan")}
      meta={
        <Link
          to={PORTAL_PATHS.billing}
          className={buttonClass("secondary", undefined, "sm")}
          data-testid="portal-settings-statements"
        >
          {t("settingsPage.statements")}
        </Link>
      }
      testId="portal-settings-plan"
    >
      <div className="ui-card__body">
        <Loaded state={state}>
          {(data) =>
            data.setUp && data.monthSoFar ? (
              <div className="flex flex-col gap-3">
                {data.paymentProblem ? (
                  <div role="alert" className="ds-banner">
                    <span>{t("billing.paymentProblem")}</span>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-ink">{t("settingsPage.creditsThisMonth")}</span>
                  <span className="text-sm text-ink figures">
                    {t("settingsPage.creditsUsed", {
                      used: fmt.number(data.monthSoFar.creditsUsed),
                      included: fmt.number(data.monthSoFar.creditsIncluded),
                    })}
                  </span>
                </div>
                <CreditMeter
                  used={data.monthSoFar.creditsUsed}
                  allowance={data.monthSoFar.creditsIncluded}
                  testId="portal-settings-meter"
                />
                {/* creditsIncluded is the month so far: each agent's credits × days billed ÷ days
                    in the month (core buildStatement), so it grows through the month. */}
                <p className="text-sm text-ink-muted" data-testid="portal-settings-credits-help">
                  {t("settingsPage.creditsIncludedHelp")}
                </p>
              </div>
            ) : (
              <p className="text-ink-muted">{t("billing.notSetUp")}</p>
            )
          }
        </Loaded>
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

/**
 * UI-3a: the team and the exports have pages of their own (`/settings/team`, `/settings/exports`);
 * Settings links to them, with how many people use the portal.
 */
function Team() {
  const { t } = useI18n();
  const users = useApi(apiRoutes.portalUsers);
  const rows = [
    {
      to: PORTAL_PATHS.team,
      title: t("settingsPage.teamLink"),
      line: users.data
        ? t("settings.peopleCount", { count: users.data.users.length })
        : t("settingsPage.teamLinkHelp"),
      testId: "portal-settings-team-link",
    },
    {
      to: PORTAL_PATHS.exports,
      title: t("settingsPage.exportsLink"),
      line: t("settingsPage.exportsLinkHelp"),
      testId: "portal-settings-exports-link",
    },
  ];
  return (
    <Card testId="portal-settings-people">
      <ul>
        {rows.map((r) => (
          <li key={r.to} className="border-b border-line last:border-b-0">
            <Link
              to={r.to}
              data-testid={r.testId}
              className="flex items-center justify-between gap-3 px-6 py-4 hover:bg-surface-subtle max-sm:px-4"
            >
              <span className="min-w-0">
                <span className="block font-medium text-ink">{r.title}</span>
                <span className="block text-sm text-ink-muted">{r.line}</span>
              </span>
              <Icon name="chevron-right" className="text-ink-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A client user reads the team (who approves what); the admin reaches it from Team above. */
function TeamLink() {
  const { t } = useI18n();
  return (
    <Link
      to={PORTAL_PATHS.team}
      className="text-sm text-link hover:underline"
      data-testid="portal-settings-team-link"
    >
      {t("settingsPage.seeTeam")}
    </Link>
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
