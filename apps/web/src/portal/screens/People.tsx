// `/people`, C5 People (docs/ui-plan.md; plan §1.22, §1.25, §1.27, §1.42): everyone the client's
// agents may contact, who they are to the client, and how each wants to be reached. One page with
// tabs: the people (a table, and one person's details beside it), organizations, consent and
// messages, who each agent reaches, voice samples, and import with agents' suggestions. People and
// organizations are the tabs; the other four sit behind the page's "More" menu, for the client
// admin only (QA round 1).
//
// Client users read the people and organizations; the client admin also edits them, records
// consent, and makes a channel stricter for a person (ask first, or never: only we loosen it).
// Names, notes and messages stay as written; the words around them are in the reader's language.
import {
  CONTACT_RELATIONSHIPS,
  type Contact,
  type ContactCreateInput,
  type Organization,
  type PermissionLevel,
  type ReachChannel,
  type Relationship,
} from "@countersign/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ContactsPanel } from "../../contacts/ContactsPanel";
import {
  DirectoryPanel,
  languageUsedText,
  PersonForm,
  RELATIONSHIP_KEY,
} from "../../directory/DirectoryPanel";
import type { PlainKey } from "../../i18n/catalog";
import { type I18n, useI18n } from "../../i18n/i18n";
import { PortalPeopleList } from "../../people/PeoplePanel";
import { shortTime } from "../../runs/format";
import { useSession } from "../../session/session";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { Select, TextInput } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Loaded, Page, PageGrid } from "../../ui/page";
import {
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Tabs,
  Tag,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { PORTAL_PATHS } from "../paths";
import { VoiceSamples } from "./VoiceSamples";

export type PeopleTab = "people" | "organizations" | "consent" | "reach" | "voice" | "import";

/** The tabs only the client admin has. */
const ADMIN_TABS: readonly PeopleTab[] = ["consent", "reach", "voice", "import"];

const CHANNELS: readonly ReachChannel[] = ["email", "sms", "whatsapp", "voice"];

const CHANNEL_KEY: Record<ReachChannel, PlainKey> = {
  email: "peoplePage.channel.email",
  sms: "peoplePage.channel.sms",
  whatsapp: "peoplePage.channel.whatsapp",
  voice: "peoplePage.channel.voice",
};

const FILTER_KEY: Record<Relationship, PlainKey> = {
  employee: "peoplePage.filter.employee",
  contractor: "peoplePage.filter.contractor",
  customer: "peoplePage.filter.customer",
  vendor: "peoplePage.filter.vendor",
  partner: "peoplePage.filter.partner",
  other: "peoplePage.filter.other",
};

/** A person's level on a channel; `unset` adds no limit of its own (each agent's steps decide). */
type Level = PermissionLevel | "unset";
const LEVEL_KEY: Record<Level, PlainKey> = {
  auto: "peoplePage.level.auto",
  approval: "peoplePage.level.approval",
  off: "peoplePage.level.off",
  unset: "peoplePage.level.unset",
};
const STRICTNESS: Record<Level, number> = { unset: 0, auto: 0, approval: 1, off: 2 };

function useIsAdmin(): boolean {
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  return client?.role === "client_admin";
}

export function PeopleScreen({ tab }: { tab: PeopleTab }) {
  const { t } = useI18n();
  const admin = useIsAdmin();
  const tabs: { id: PeopleTab; to: string; label: string }[] = [
    { id: "people", to: PORTAL_PATHS.people, label: t("peoplePage.tab.people") },
    {
      id: "organizations",
      to: PORTAL_PATHS.organizations,
      label: t("peoplePage.tab.organizations"),
    },
    { id: "consent", to: PORTAL_PATHS.contacts, label: t("peoplePage.tab.consent") },
    { id: "reach", to: PORTAL_PATHS.reach, label: t("peoplePage.tab.reach") },
    { id: "voice", to: PORTAL_PATHS.voice, label: t("peoplePage.tab.voice") },
    { id: "import", to: PORTAL_PATHS.peopleImport, label: t("peoplePage.tab.import") },
  ];
  // The admin's pages are in "More"; the one open now also shows as a tab, so you see where you are.
  const shown = tabs.filter((x) => !ADMIN_TABS.includes(x.id) || (admin && x.id === tab));
  const more = admin ? tabs.filter((x) => ADMIN_TABS.includes(x.id)) : [];
  return (
    <Page testId="portal-people">
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t("peoplePage.title")}
          subtitle={t("peoplePage.subtitle")}
          actions={
            admin ? (
              <Link
                to={`${PORTAL_PATHS.people}?add=1`}
                className={buttonClass("primary")}
                data-testid="people-add"
              >
                {t("peoplePage.add")}
              </Link>
            ) : null
          }
        />
        <div className="flex items-end gap-4">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <Tabs
              items={shown.map((x) => ({
                to: x.to,
                label: x.label,
                end: true,
                active: x.id === tab,
              }))}
            />
          </div>
          {more.length > 0 ? <PeopleMore items={more} current={tab} /> : null}
        </div>
      </div>
      {!admin && ADMIN_TABS.includes(tab) ? (
        <EmptyState>{t("peoplePage.adminOnly")}</EmptyState>
      ) : tab === "people" ? (
        <PeopleDirectory admin={admin} />
      ) : tab === "organizations" ? (
        <DirectoryPanel surface={{ kind: "portal" }} canEdit={admin} only={["organizations"]} />
      ) : tab === "consent" ? (
        <ContactsPanel surface={{ kind: "portal" }} />
      ) : tab === "reach" ? (
        <PortalPeopleList />
      ) : tab === "voice" ? (
        <VoiceSamples />
      ) : (
        <DirectoryPanel
          surface={{ kind: "portal" }}
          canEdit={admin}
          only={["import", "suggestions"]}
        />
      )}
    </Page>
  );
}

/** The admin's other People pages, behind one menu at the end of the tabs. */
function PeopleMore({
  items,
  current,
}: {
  items: { id: PeopleTab; to: string; label: string }[];
  current: PeopleTab;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDetailsElement>(null);
  const { pathname } = useLocation();
  // A page chosen from the menu closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on each page change.
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);
  return (
    <details ref={ref} className="relative shrink-0 pb-1.5" data-testid="people-more">
      <summary className="ds-btn ds-btn--ghost ds-btn--sm list-none [&::-webkit-details-marker]:hidden">
        {t("nav.more")}
        <Icon name="chevron-down" size={14} />
      </summary>
      <div className="ui-menu flex flex-col gap-0.5 p-2">
        {items.map((x) => (
          <Link
            key={x.id}
            to={x.to}
            data-testid={`people-more-${x.id}`}
            aria-current={x.id === current ? "page" : undefined}
            className="ds-navitem ui-navitem"
          >
            {x.label}
          </Link>
        ))}
      </div>
    </details>
  );
}

/** The channels a person can be reached on now (an address and consent, not opted out). */
function reachable(p: Contact): ReachChannel[] {
  const can: Record<ReachChannel, boolean> = {
    email: p.canEmail ?? false,
    sms: p.canMessage.sms,
    whatsapp: p.canMessage.whatsapp,
    voice: p.canCall ?? false,
  };
  const order = [...(p.preferredChannels ?? []), ...CHANNELS];
  return [...new Set(order)].filter((ch) => can[ch]);
}

function channelList(channels: ReachChannel[], i18n: I18n): string {
  return new Intl.ListFormat(i18n.intl, { type: "conjunction" }).format(
    channels.map((ch) => i18n.t(CHANNEL_KEY[ch])),
  );
}

/** The People tab: filters by relationship, a search, the table and one person's details. */
function PeopleDirectory({ admin }: { admin: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Relationship | "all">("all");
  const list = useApi(apiRoutes.portalDirectory, { query: q.trim() ? { q: q.trim() } : {} });
  // Who each agent reaches (the client admin's view): the agents in touch with each person.
  const reach = useApi(apiRoutes.portalAgentPeople, admin ? {} : null);
  const adding = admin && params.get("add") === "1";
  const selectedId = params.get("person");

  function select(id: string | null) {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("add");
      if (id) next.set("person", id);
      else next.delete("person");
      return next;
    });
  }

  const agentsOf = new Map<string, string[]>();
  for (const a of reach.data?.items ?? []) {
    for (const binding of Object.values(a.people)) {
      for (const id of binding.contactIds) {
        const names = agentsOf.get(id) ?? [];
        if (!names.includes(a.agentName)) agentsOf.set(id, [...names, a.agentName]);
      }
    }
  }

  return (
    <Loaded state={list}>
      {(data) => {
        const people = data.people;
        const counts = new Map<Relationship, number>();
        for (const p of people) {
          if (p.relationship) counts.set(p.relationship, (counts.get(p.relationship) ?? 0) + 1);
        }
        const shown = filter === "all" ? people : people.filter((p) => p.relationship === filter);
        const selected = people.find((p) => p.id === selectedId) ?? null;
        return (
          <PageGrid
            rail={
              adding ? (
                <Card title={t("peoplePage.addTitle")} pad testId="people-add-form">
                  <PersonForm
                    person={null}
                    organizations={data.organizations}
                    onSubmit={async (body) => {
                      const res = await api.call(apiRoutes.portalCreateContact, {
                        body: body as ContactCreateInput,
                      });
                      list.reload();
                      select(res.contact.id);
                    }}
                  />
                </Card>
              ) : selected ? (
                <PersonDetail
                  key={selected.id}
                  person={selected}
                  organizations={data.organizations}
                  agents={agentsOf.get(selected.id) ?? []}
                  admin={admin}
                  onChanged={list.reload}
                />
              ) : (
                <Card pad testId="people-pick">
                  <p className="text-sm text-ink-muted">{t("peoplePage.pick")}</p>
                </Card>
              )
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* biome-ignore lint/a11y/useSemanticElements: the design system's Segmented control. */}
              <div
                className="ds-seg max-w-full overflow-x-auto"
                role="group"
                aria-label={t("common.filter")}
                data-testid="people-filter"
              >
                <button
                  type="button"
                  aria-pressed={filter === "all"}
                  onClick={() => setFilter("all")}
                  data-testid="people-filter-all"
                >
                  {t("peoplePage.filter.all", { count: people.length })}
                </button>
                {CONTACT_RELATIONSHIPS.filter((r) => (counts.get(r) ?? 0) > 0).map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={filter === r}
                    onClick={() => setFilter(r)}
                    data-testid={`people-filter-${r}`}
                  >
                    {t(FILTER_KEY[r])} · {counts.get(r)}
                  </button>
                ))}
              </div>
              <TextInput
                type="search"
                className="w-full sm:w-72"
                aria-label={t("peoplePage.search")}
                placeholder={t("peoplePage.search")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                data-testid="people-search"
              />
            </div>
            {shown.length === 0 ? (
              <EmptyState>
                {people.length === 0 && !q.trim() ? t("peoplePage.empty") : t("peoplePage.noMatch")}
              </EmptyState>
            ) : (
              <Card className="overflow-hidden">
                <div className="dt dt-ana overflow-x-auto rounded-none border-0">
                  <table data-testid="people-table">
                    <thead>
                      <tr className="dt-cols">
                        <th>{t("peoplePage.col.person")}</th>
                        <th>{t("peoplePage.col.who")}</th>
                        <th>{t("peoplePage.col.reach")}</th>
                        {admin ? <th>{t("peoplePage.col.agents")}</th> : null}
                        <th>{t("peoplePage.col.about")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((p) => (
                        <PersonRow
                          key={p.id}
                          person={p}
                          agents={admin ? (agentsOf.get(p.id) ?? []) : null}
                          selected={p.id === selected?.id}
                          onSelect={() => select(p.id)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </PageGrid>
        );
      }}
    </Loaded>
  );
}

function PersonRow({
  person: p,
  agents,
  selected,
  onSelect,
}: {
  person: Contact;
  /** Null: not shown (the client admin's view only). */
  agents: string[] | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const channels = reachable(p);
  return (
    <tr
      data-testid={`people-row-${p.id}`}
      aria-selected={selected}
      className={cx("cursor-pointer", selected && "bg-slate-tint")}
      onClick={onSelect}
    >
      <td>
        <span className="flex items-center gap-3">
          <PersonBadge name={p.name} plain size="sm" />
          <span className="min-w-0">
            <button
              type="button"
              className="block text-left font-medium text-ink hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                onSelect();
              }}
              data-testid={`people-open-${p.id}`}
            >
              {p.name}
            </button>
            <span className="block text-sm text-ink-muted">
              {p.organization?.name ?? p.email ?? p.phone ?? ""}
            </span>
          </span>
        </span>
      </td>
      <td>
        <span className="flex flex-col items-start gap-1">
          {p.relationship ? <Tag>{t(RELATIONSHIP_KEY[p.relationship])}</Tag> : null}
          {p.title ? <span className="text-sm text-ink-muted">{p.title}</span> : null}
        </span>
      </td>
      <td className="text-sm text-ink">
        {p.optedOut ? (
          <span className="text-ink-muted">{t("peoplePage.cannot.optedOut")}</span>
        ) : channels.length > 0 ? (
          channelList(channels, i18n)
        ) : (
          <span className="text-ink-muted">{t("peoplePage.reachNone")}</span>
        )}
      </td>
      {agents ? (
        <td>
          <span className="flex flex-wrap gap-1">
            {agents.map((name) => (
              <span key={name} title={name} className="inline-flex">
                <AgentBadge name={name} size="sm" />
                <span className="sr-only">{name}</span>
              </span>
            ))}
          </span>
        </td>
      ) : null}
      <td className="max-w-64 text-sm text-ink-muted">
        <span className="line-clamp-3">{p.notes ?? ""}</span>
      </td>
    </tr>
  );
}

/** One person beside the table: who they are, what agents should know, how agents may reach them. */
function PersonDetail({
  person: p,
  organizations,
  agents,
  admin,
  onChanged,
}: {
  person: Contact;
  organizations: Organization[];
  agents: string[];
  admin: boolean;
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [editing, setEditing] = useState(false);
  return (
    <Card testId={`people-detail-${p.id}`}>
      <div className="flex items-start gap-3 px-6 py-5">
        <PersonBadge name={p.name} plain size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="type-subheading text-ink">{p.name}</h2>
          <p className="text-sm text-ink-muted">
            {[p.title, p.organization?.name].filter(Boolean).join(" · ") ||
              t("directory.person.noOrganization")}
          </p>
        </div>
        {admin ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="people-detail-edit"
            aria-expanded={editing}
            onClick={() => setEditing((e) => !e)}
          >
            {editing ? t("common.cancel") : t("directory.edit")}
          </Button>
        ) : null}
      </div>
      {p.relationship || p.languageUsed ? (
        <div className="flex flex-wrap gap-2 px-6 pb-4">
          {p.relationship ? <Tag>{t(RELATIONSHIP_KEY[p.relationship])}</Tag> : null}
          {p.languageUsed ? <Tag>{languageUsedText(p.languageUsed, i18n)}</Tag> : null}
        </div>
      ) : null}
      {editing ? (
        <div className="border-t border-line px-6 py-4">
          <PersonForm
            person={p}
            organizations={organizations}
            onSubmit={async (body) => {
              await api.call(apiRoutes.portalUpdateContact, { params: { id: p.id }, body });
              setEditing(false);
              onChanged();
            }}
          />
        </div>
      ) : null}
      <DetailBlock title={t("peoplePage.know")}>
        <p className="text-sm whitespace-pre-line text-ink" data-testid="people-detail-notes">
          {p.notes?.trim() ? p.notes : t("peoplePage.knowNone")}
        </p>
      </DetailBlock>
      <DetailBlock title={t("peoplePage.howReach")}>
        <ReachLevels person={p} admin={admin} onChanged={onChanged} />
      </DetailBlock>
      {admin ? (
        <DetailBlock title={t("peoplePage.col.agents")}>
          {agents.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("peoplePage.noAgents")}</p>
          ) : (
            <ul className="flex flex-wrap gap-x-3 gap-y-1.5">
              {agents.map((name) => (
                <li key={name} className="flex items-center gap-1.5 text-sm text-ink">
                  <AgentBadge name={name} size="sm" />
                  {name}
                </li>
              ))}
            </ul>
          )}
        </DetailBlock>
      ) : null}
      {admin ? (
        <DetailBlock title={t("peoplePage.recent")}>
          <RecentMessages contactId={p.id} />
        </DetailBlock>
      ) : null}
    </Card>
  );
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line px-6 py-4">
      <h3 className="eyebrow text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

/** Where each channel goes for this person, or null when they have no address for it. */
function addressOf(p: Contact, ch: ReachChannel): string | null {
  switch (ch) {
    case "email":
      return p.email ?? null;
    case "sms":
    case "voice":
      return p.phone;
    case "whatsapp":
      return p.whatsapp;
  }
}

function canReach(p: Contact, ch: ReachChannel): boolean {
  switch (ch) {
    case "email":
      return p.canEmail ?? false;
    case "sms":
      return p.canMessage.sms;
    case "whatsapp":
      return p.canMessage.whatsapp;
    case "voice":
      return p.canCall ?? false;
  }
}

/**
 * Per channel: the address and how agents may use it (on their own, with your sign, or off). The
 * client admin may make a channel stricter; only we loosen it (the API refuses otherwise).
 */
function ReachLevels({
  person: p,
  admin,
  onChanged,
}: {
  person: Contact;
  admin: boolean;
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<ReachChannel, Level>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const channels = CHANNELS.filter((ch) => addressOf(p, ch));
  const saved = (ch: ReachChannel): Level => p.autonomy?.[ch] ?? "unset";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const autonomy = Object.fromEntries(
        CHANNELS.flatMap((ch) => {
          const level = draft[ch] ?? saved(ch);
          return level === "unset" ? [] : [[ch, level]];
        }),
      );
      await api.call(apiRoutes.portalContactAutonomy, {
        params: { id: p.id },
        body: { autonomy },
      });
      setEditing(false);
      setDraft({});
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (channels.length === 0) {
    return <p className="text-sm text-ink-muted">{t("peoplePage.reachNone")}</p>;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="people-reach">
      <ul className="flex flex-col gap-2.5">
        {channels.map((ch) => {
          const level = saved(ch);
          const why = p.optedOut
            ? t("peoplePage.cannot.optedOut")
            : !canReach(p, ch)
              ? t("peoplePage.cannot.noConsent")
              : null;
          const options = (["unset", "auto", "approval", "off"] as const).filter(
            (l) =>
              l === level || (l !== "unset" && l !== "auto" && STRICTNESS[l] > STRICTNESS[level]),
          );
          return (
            <li
              key={ch}
              className="flex flex-wrap items-center justify-between gap-2"
              data-testid={`people-reach-${ch}`}
            >
              <span className="min-w-0 text-sm">
                <span className="block text-ink-muted">{t(CHANNEL_KEY[ch])}</span>
                <span className="block break-words text-ink">{addressOf(p, ch)}</span>
              </span>
              {editing && !why ? (
                <Select
                  aria-label={t(CHANNEL_KEY[ch])}
                  data-testid={`people-reach-${ch}-level`}
                  className="h-8 w-40 text-sm"
                  value={draft[ch] ?? level}
                  disabled={options.length < 2}
                  onChange={(e) => setDraft((d) => ({ ...d, [ch]: e.target.value as Level }))}
                >
                  {options.map((l) => (
                    <option key={l} value={l}>
                      {t(LEVEL_KEY[l])}
                    </option>
                  ))}
                </Select>
              ) : why ? (
                <StatusChip state="idle" testId={`people-reach-${ch}-state`}>
                  {why}
                </StatusChip>
              ) : (
                <StatusChip
                  state={level === "approval" ? "person" : level === "off" ? "idle" : "done"}
                  testId={`people-reach-${ch}-state`}
                >
                  {t(LEVEL_KEY[level])}
                </StatusChip>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-ink-muted">{t("peoplePage.levelNote")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      {admin ? (
        editing ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              data-testid="people-reach-save"
              onClick={() => void save()}
            >
              {t("common.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDraft({});
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <div>
            <Button size="sm" data-testid="people-reach-tighten" onClick={() => setEditing(true)}>
              {t("peoplePage.tighten")}
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

/** The person's last few messages and calls, newest first (their words as written). */
function RecentMessages({ contactId }: { contactId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const messages = useApi(apiRoutes.portalContactMessages, { params: { id: contactId } });
  return (
    <Loaded state={messages}>
      {(data) =>
        data.items.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("peoplePage.recentNone")}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="people-recent">
            {data.items.slice(0, 3).map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="block text-ink-muted">
                    {t(m.direction === "in" ? "peoplePage.fromThem" : "peoplePage.toThem", {
                      channel: t(CHANNEL_KEY[m.channel]),
                    })}
                  </span>
                  <span className="line-clamp-2 block break-words text-ink">{m.text}</span>
                </span>
                <span className="shrink-0 reference text-ink-muted">
                  {shortTime(m.at, undefined, i18n)}
                </span>
              </li>
            ))}
          </ul>
        )
      }
    </Loaded>
  );
}
