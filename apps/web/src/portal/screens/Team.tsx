// `/settings/team` (UI-3a, drafted in the prototype's style): the people in your business who use
// the portal, each with their role and what they sign (the approver rules, in the API's words). The
// client admin also sees who hasn't signed in yet and invites people (`/api/users`); everyone else
// reads the team (`/api/team`). Mezonas sets roles and signing; nothing here loosens a rule.
import type { Member, TeamMember } from "@countersign/core";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { InviteForm, ROLE_LABEL } from "../../people/People";
import { useSession } from "../../session/session";
import { PersonBadge } from "../../ui/badges";
import { Loaded, Page, Section } from "../../ui/page";
import { Badge, Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { PORTAL_PATHS } from "../paths";

/** One row: a person, their role, and what they sign. */
interface Row {
  userId: string;
  name: string | null;
  email: string;
  role: Member["role"];
  invited: boolean;
  canSign: boolean;
  signs: string[];
}

/** The admin's list (with who hasn't signed in) joined to what each person signs. */
export function teamRows(users: Member[] | null, team: TeamMember[]): Row[] {
  const byId = new Map(team.map((m) => [m.userId, m]));
  if (!users) {
    return team.map((m) => ({ ...m, invited: false }));
  }
  return users.map((u) => {
    const m = byId.get(u.userId);
    return {
      userId: u.userId,
      name: u.name,
      email: u.email,
      role: u.role,
      invited: u.signedIn === false,
      canSign: m?.canSign ?? u.canSign ?? true,
      signs: m?.signs ?? [],
    };
  });
}

export function PortalTeamScreen() {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  const isAdmin = client?.role === "client_admin";
  const team = useApi(apiRoutes.portalTeam);

  return (
    <Page testId="portal-team-page">
      <div>
        <p className="eyebrow mb-2 text-ink-muted">
          <Link to={PORTAL_PATHS.settings} className="text-link hover:underline">
            {t("nav.settings")}
          </Link>
        </p>
        <PageHeader
          title={t("teamPage.title")}
          subtitle={isAdmin ? t("teamPage.subtitle") : t("teamPage.subtitleMember")}
        />
      </div>
      {isAdmin ? <AdminTeam team={team} /> : <MemberTeam team={team} />}
    </Page>
  );
}

function MemberTeam({ team }: { team: ReturnType<typeof useApi<typeof apiRoutes.portalTeam>> }) {
  return <Loaded state={team}>{(data) => <TeamList rows={teamRows(null, data.members)} />}</Loaded>;
}

function AdminTeam({ team }: { team: ReturnType<typeof useApi<typeof apiRoutes.portalTeam>> }) {
  const { t } = useI18n();
  const api = useApiClient();
  const users = useApi(apiRoutes.portalUsers);
  return (
    <>
      <Loaded state={users}>
        {(data) => <TeamList rows={teamRows(data.users, team.data?.members ?? [])} />}
      </Loaded>
      <Section title={t("teamPage.invite")}>
        <InviteForm
          surface="portal"
          testId="portal-invite"
          onInvite={async (body) => {
            const result = await api.call(apiRoutes.portalInvite, { body });
            users.reload();
            team.reload();
            return result;
          }}
        />
      </Section>
    </>
  );
}

function TeamList({ rows }: { rows: Row[] }) {
  const { t } = useI18n();
  if (rows.length === 0) return <EmptyState>{t("people.none")}</EmptyState>;
  return (
    <Card
      title={t("teamPage.people")}
      meta={t("settings.peopleCount", { count: rows.length })}
      testId="portal-team"
    >
      <ul>
        {rows.map((r) => (
          <li
            key={r.userId}
            data-testid={`portal-team-${r.email}`}
            className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-6 py-4 last:border-b-0 max-sm:px-4"
          >
            <div className="flex min-w-0 items-start gap-3">
              <PersonBadge name={r.name ?? r.email} plain={r.role !== "operator"} size="sm" />
              <div className="min-w-0">
                <p className="truncate font-medium text-ink">{r.name ?? r.email}</p>
                {r.name ? <p className="truncate text-sm text-ink-muted">{r.email}</p> : null}
                <div className="mt-1 flex flex-col gap-0.5 text-sm text-ink-muted">
                  {!r.canSign ? (
                    <p>{t("teamPage.viewer")}</p>
                  ) : r.signs.length > 0 ? (
                    r.signs.map((line) => <p key={line}>{line}</p>)
                  ) : null}
                </div>
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              {r.invited ? <Badge>{t("people.invited")}</Badge> : null}
              <Tag tone={r.role === "operator" ? "person" : "neutral"}>{t(ROLE_LABEL[r.role])}</Tag>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
