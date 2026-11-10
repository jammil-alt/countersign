// `/settings/team` (UI-3a, drafted in the prototype's style): the people in your business who use
// the portal, each with their role and what they sign (the approver rules, in the API's words). The
// client admin also sees who hasn't signed in yet and invites people (`/api/users`); everyone else
// reads the team (`/api/team`). Mezonas sets roles and signing; nothing here loosens a rule.
//
// R8 (docs/plan.md §1.86; ARCHITECTURE §10.14 "Business hours"): each person's hours (their own
// week, or the business's) and away dates. The client admin sees and changes everyone's
// (`/api/settings/people-hours`); a client user sees and changes their own (`/api/settings/my-
// hours`), as the routes allow.
import type { Member, processes, TeamMember } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { PersonHoursEditor, PersonHoursLine } from "../../hours/HoursParts";
import { useI18n } from "../../i18n/i18n";
import { InviteForm, ROLE_LABEL } from "../../people/People";
import { useSession } from "../../session/session";
import { PersonBadge } from "../../ui/badges";
import { Icon } from "../../ui/icons";
import { Loaded, Page, Section } from "../../ui/page";
import { Badge, Button, Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";
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

/** A person's hours on their row, and how to save them (null: not shown). */
interface RowHours {
  hours: processes.PersonHours | null;
  business: processes.BusinessHours;
  save: (hours: processes.PersonHours | null) => Promise<void>;
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

/** `embedded`: inside Settings (its Team section), without a header of its own. */
export function PortalTeamScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  const isAdmin = client?.role === "client_admin";
  const team = useApi(apiRoutes.portalTeam);

  if (embedded) {
    return (
      <div className="flex flex-col gap-8" data-testid="portal-team-page">
        {isAdmin ? <AdminTeam team={team} /> : <MemberTeam team={team} />}
      </div>
    );
  }
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
  return (
    <>
      <MyHours />
      <Loaded state={team}>{(data) => <TeamList rows={teamRows(null, data.members)} />}</Loaded>
    </>
  );
}

/** A client user's own hours and away dates: the only ones they may read and change. */
function MyHours() {
  const { t } = useI18n();
  const api = useApiClient();
  const mine = useApi(apiRoutes.portalMyHours);
  const business = useApi(apiRoutes.portalBusinessHours);
  return (
    <Card title={t("teamPage.yourHours")} testId="portal-my-hours">
      <div className="ui-card__body flex flex-col gap-4">
        <p className="text-sm text-ink-muted">{t("teamPage.yourHoursHelp")}</p>
        <Loaded state={mine}>
          {(me) => (
            <Loaded state={business}>
              {(b) => (
                <PersonHoursEditor
                  person={me.person}
                  business={b.hours}
                  onSave={async (hours) => {
                    await api.call(apiRoutes.portalSetMyHours, { body: { hours } });
                    mine.reload();
                  }}
                  testId="portal-my-hours-editor"
                />
              )}
            </Loaded>
          )}
        </Loaded>
      </div>
    </Card>
  );
}

function AdminTeam({ team }: { team: ReturnType<typeof useApi<typeof apiRoutes.portalTeam>> }) {
  const { t } = useI18n();
  const api = useApiClient();
  const users = useApi(apiRoutes.portalUsers);
  const people = useApi(apiRoutes.portalPeopleHours);
  const hours = people.data;
  // The client admin may change anyone's hours on the People list (the route's rule).
  const hoursOf = hours
    ? (userId: string): RowHours | null => {
        const person = hours.people.find((p) => p.kind === "user" && p.id === userId);
        if (!person) return null;
        return {
          hours: person.hours,
          business: hours.business.hours,
          save: async (next) => {
            await api.call(apiRoutes.portalSetUserHours, {
              params: { id: userId },
              body: { hours: next },
            });
            people.reload();
          },
        };
      }
    : undefined;
  return (
    <>
      <Loaded state={users}>
        {(data) => (
          <TeamList
            rows={teamRows(data.users, team.data?.members ?? [])}
            {...(hoursOf ? { hoursOf } : {})}
          />
        )}
      </Loaded>
      <Section title={t("teamPage.invite")}>
        <InviteForm
          surface="portal"
          testId="portal-invite"
          onInvite={async (body) => {
            const result = await api.call(apiRoutes.portalInvite, { body });
            users.reload();
            team.reload();
            people.reload();
            return result;
          }}
        />
        <p className="mt-3 text-sm">
          <Link
            to={PORTAL_PATHS.contacts}
            className="text-link hover:underline"
            data-testid="portal-invite-directory"
          >
            {t("people.fromDirectory.link")}
          </Link>
        </p>
      </Section>
    </>
  );
}

function TeamList({
  rows,
  hoursOf,
}: {
  rows: Row[];
  /** Each person's hours, where this reader may see them. */
  hoursOf?: (userId: string) => RowHours | null;
}) {
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
          <TeamRow key={r.userId} row={r} hours={hoursOf?.(r.userId) ?? null} />
        ))}
      </ul>
    </Card>
  );
}

function TeamRow({ row: r, hours }: { row: Row; hours: RowHours | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <li
      data-testid={`portal-team-${r.email}`}
      className="border-b border-line px-6 py-4 last:border-b-0 max-sm:px-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
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
            {hours ? (
              <div className="mt-1">
                <PersonHoursLine hours={hours.hours} testId={`portal-team-${r.email}-hours`} />
              </div>
            ) : null}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {r.invited ? <Badge>{t("people.invited")}</Badge> : null}
          <Tag tone={r.role === "operator" ? "person" : "neutral"}>{t(ROLE_LABEL[r.role])}</Tag>
          {hours ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              data-testid={`portal-team-${r.email}-hours-toggle`}
            >
              {t("teamPage.hours")}
              <Icon name={open ? "chevron-down" : "chevron-right"} size={16} />
            </Button>
          ) : null}
        </span>
      </div>
      {hours && open ? (
        <div className="mt-4 border-t border-line pt-4">
          <PersonHoursEditor
            person={{ hours: hours.hours }}
            business={hours.business}
            onSave={hours.save}
            testId={`portal-team-${r.email}-hours-editor`}
          />
        </div>
      ) : null}
    </li>
  );
}
