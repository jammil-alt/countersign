// The directory (plan §1.27): one per client, of the people and organizations its agents work with,
// on the portal's /directory and the back office's client page. The client admin and the operator
// edit it; client users read it. People are the client's contacts (their consent and reach-out
// settings stay on Contacts); here they gain an organization, a title and a relationship.
// Organizations link to their vendor record. Imports (a CSV, Zoho CRM, Podio) are previewed row by
// row and change nothing until applied; agents' suggestions wait for acceptance. Words in the
// reader's language (plan §1.18); names, notes and what tools or agents wrote stay as written.
import {
  CONTACT_RELATIONSHIPS,
  type Contact,
  type ContactCreateInput,
  type ContactInviteBody,
  type ContactPatchInput,
  type DirectoryImportKind,
  type DirectoryListQuery,
  type DirectorySuggestion,
  type ImportApplyBody,
  type ImportPreview,
  type ImportResult,
  type LanguageUsed,
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  ORGANIZATION_KINDS,
  type Organization,
  type OrganizationCreateInput,
  type OrganizationImportRow,
  type OrganizationKind,
  type OrganizationPatchInput,
  type PersonImportRow,
  type Relationship,
} from "@countersign/core";
import { type FormEvent, type ReactNode, useState } from "react";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import type { PlainKey } from "../i18n/catalog";
import { errorText } from "../i18n/errors";
import { type I18n, useI18n } from "../i18n/i18n";
import { AccessBadge, InviteContactAction } from "../people/People";
import { Field, Select, TextArea, TextInput } from "../ui/forms";
import {
  Badge,
  Button,
  Card,
  Count,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../ui/primitives";

export type DirectorySurface = { kind: "ops"; clientId: string } | { kind: "portal" };

export const RELATIONSHIP_KEY: Record<Relationship, PlainKey> = {
  employee: "directory.relationship.employee",
  contractor: "directory.relationship.contractor",
  customer: "directory.relationship.customer",
  vendor: "directory.relationship.vendor",
  partner: "directory.relationship.partner",
  other: "directory.relationship.other",
};

export const KIND_KEY: Record<OrganizationKind, PlainKey> = {
  vendor: "directory.kind.vendor",
  customer: "directory.kind.customer",
  partner: "directory.kind.partner",
  own: "directory.kind.own",
  other: "directory.kind.other",
};

const SOURCE_KEY: Record<string, PlainKey> = {
  csv: "directory.source.csv",
  agent: "directory.source.agent",
  zoho_crm: "directory.source.zoho_crm",
  podio: "directory.source.podio",
};

/** A changed field's name in the reader's language. */
const FIELD_KEY: Record<string, PlainKey> = {
  name: "directory.field.name",
  email: "directory.field.email",
  phone: "directory.field.phone",
  whatsapp: "directory.field.whatsapp",
  title: "directory.field.title",
  relationship: "directory.field.relationship",
  organization: "directory.field.organization",
  organizationId: "directory.field.organization",
  roles: "directory.field.roles",
  language: "directory.field.language",
  notes: "directory.field.notes",
  kinds: "directory.field.kinds",
  website: "directory.field.website",
  address: "directory.field.address",
};

export type DirectoryTab = "people" | "organizations" | "import" | "suggestions";
type Tab = DirectoryTab;

function problem(error: unknown, i18n: I18n): string {
  return isApiError(error) ? errorText(error, i18n) : i18n.t("directory.notSaved");
}

/** A field's value as text: lists joined, relationships in words. */
export function directoryValue(value: unknown, i18n: I18n): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return Object.values(value as object).join(", ");
  if (typeof value === "string" && value in RELATIONSHIP_KEY) {
    return i18n.t(RELATIONSHIP_KEY[value as Relationship]);
  }
  return String(value);
}

/** A language by its name in the reader's language: "Spanish", "Spanisch". */
export function languageName(code: string, i18n: I18n): string {
  try {
    return new Intl.DisplayNames([i18n.intl], { type: "language" }).of(code) ?? code;
  } catch {
    return LOCALE_NAMES[code as Locale] ?? code;
  }
}

/** "Uses: Spanish (from Acme Corp)": the language agents write in, and where it comes from. */
export function languageUsedText(used: LanguageUsed, i18n: I18n): string {
  const language = languageName(used.language, i18n);
  switch (used.from) {
    case "person":
      return i18n.t("directory.language.uses", { language });
    case "organization":
      return i18n.t("directory.language.fromOrganization", {
        language,
        organization: used.organization ?? "—",
      });
    case "client":
      return i18n.t("directory.language.fromClient", { language });
    default:
      return i18n.t("directory.language.fromDefault", { language });
  }
}

/** The routes for one surface, so the rest of the panel doesn't care which it is on. */
function useDirectoryApi(surface: DirectorySurface, query: DirectoryListQuery) {
  const api = useApiClient();
  const ops = surface.kind === "ops" ? surface.clientId : null;
  const opsList = useApi(
    apiRoutes.opsDirectory,
    // A search and filters of one client's directory: its rows stay while the next answer loads.
    ops ? { params: { id: ops }, query, keep: true } : null,
  );
  const portalList = useApi(apiRoutes.portalDirectory, ops ? null : { query, keep: true });
  const p = (extra: Record<string, string> = {}) => ({ id: ops ?? "", ...extra });
  return {
    list: ops ? opsList : portalList,
    ops,
    createPerson: (body: ContactCreateInput) =>
      ops
        ? api.call(apiRoutes.opsCreateContact, { params: p(), body })
        : api.call(apiRoutes.portalCreateContact, { body }),
    updatePerson: (id: string, body: ContactPatchInput) =>
      ops
        ? api.call(apiRoutes.opsUpdateContact, { params: { id: ops, contactId: id }, body })
        : api.call(apiRoutes.portalUpdateContact, { params: { id }, body }),
    createOrg: (body: OrganizationCreateInput) =>
      ops
        ? api.call(apiRoutes.opsOrganizationCreate, { params: p(), body })
        : api.call(apiRoutes.portalOrganizationCreate, { body }),
    updateOrg: (id: string, body: OrganizationPatchInput) =>
      ops
        ? api.call(apiRoutes.opsOrganizationUpdate, {
            params: { id: ops, organizationId: id },
            body,
          })
        : api.call(apiRoutes.portalOrganizationUpdate, { params: { id }, body }),
    linkVendor: (id: string, link: boolean) =>
      ops
        ? api.call(
            link ? apiRoutes.opsOrganizationLinkVendor : apiRoutes.opsOrganizationUnlinkVendor,
            {
              params: { id: ops, organizationId: id },
            },
          )
        : api.call(
            link
              ? apiRoutes.portalOrganizationLinkVendor
              : apiRoutes.portalOrganizationUnlinkVendor,
            { params: { id } },
          ),
    previewCsv: (kind: DirectoryImportKind, csv: string) =>
      ops
        ? api.call(apiRoutes.opsDirectoryImportCsv, { params: p(), body: { kind, csv } })
        : api.call(apiRoutes.portalDirectoryImportCsv, { body: { kind, csv } }),
    previewTool: (body: {
      connectionId: string;
      kind: DirectoryImportKind;
      query?: string;
      appId?: number;
    }) =>
      ops
        ? api.call(apiRoutes.opsDirectoryImportConnector, { params: p(), body })
        : api.call(apiRoutes.portalDirectoryImportConnector, { body }),
    invite: (id: string, body: ContactInviteBody) =>
      ops
        ? api.call(apiRoutes.opsContactInvite, { params: { id: ops, contactId: id }, body })
        : api.call(apiRoutes.portalContactInvite, { params: { id }, body }),
    apply: (body: ImportApplyBody) =>
      ops
        ? api.call(apiRoutes.opsDirectoryImportApply, { params: p(), body })
        : api.call(apiRoutes.portalDirectoryImportApply, { body }),
    resolve: (id: string, decision: "approve" | "reject") =>
      ops
        ? api.call(apiRoutes.opsDirectorySuggestionResolve, {
            params: { id: ops, suggestionId: id },
            body: { decision },
          })
        : api.call(apiRoutes.portalDirectorySuggestionResolve, {
            params: { id },
            body: { decision },
          }),
  };
}

type DirectoryApi = ReturnType<typeof useDirectoryApi>;

export function DirectoryPanel({
  surface,
  canEdit,
  only,
}: {
  surface: DirectorySurface;
  canEdit: boolean;
  /** The tabs to offer (the portal's People page lists people itself); every tab when left out. */
  only?: readonly Tab[];
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>(only?.[0] ?? "people");
  const [q, setQ] = useState("");
  const [relationship, setRelationship] = useState<Relationship | "">("");
  const [kind, setKind] = useState<OrganizationKind | "">("");
  const query: DirectoryListQuery = {
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(relationship && tab === "people" ? { relationship } : {}),
    ...(kind ? { kind } : {}),
  };
  const d = useDirectoryApi(surface, query);
  const { data, error, loading, reload } = d.list;
  const allTabs: { id: Tab; label: string; count?: number }[] = [
    { id: "people", label: t("directory.tab.people") },
    { id: "organizations", label: t("directory.tab.organizations") },
    ...(canEdit
      ? [
          { id: "import" as const, label: t("directory.tab.import") },
          {
            id: "suggestions" as const,
            label: t("directory.tab.suggestions"),
            count: data?.pendingSuggestions ?? 0,
          },
        ]
      : []),
  ];
  const tabs = only ? allTabs.filter((x) => only.includes(x.id)) : allTabs;

  return (
    <section data-testid="directory-panel">
      {/* One tab (the portal's organizations filter) needs no tab row. */}
      <nav
        className={cx("mb-5 flex gap-5 border-b border-line", tabs.length < 2 && "hidden")}
        aria-label={t("common.sections")}
      >
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => setTab(x.id)}
            data-testid={`directory-tab-${x.id}`}
            aria-current={tab === x.id ? "page" : undefined}
            className={cx(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 py-3 text-sm leading-none font-medium",
              tab === x.id
                ? "border-slate text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {x.label}
            {x.count !== undefined ? <Count n={x.count} tone="warning" /> : null}
          </button>
        ))}
      </nav>

      {tab === "people" || tab === "organizations" ? (
        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_200px_200px]">
          <Field label={t("directory.search")}>
            <TextInput
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("directory.searchPlaceholder")}
              data-testid="directory-search"
            />
          </Field>
          {tab === "people" ? (
            <Field label={t("directory.filter.relationship")}>
              <Select
                value={relationship}
                onChange={(e) => setRelationship(e.target.value as Relationship | "")}
                data-testid="directory-filter-relationship"
              >
                <option value="">{t("directory.filter.any")}</option>
                {CONTACT_RELATIONSHIPS.map((r) => (
                  <option key={r} value={r}>
                    {t(RELATIONSHIP_KEY[r])}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <span />
          )}
          <Field label={t("directory.filter.kind")}>
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as OrganizationKind | "")}
              data-testid="directory-filter-kind"
            >
              <option value="">{t("directory.filter.any")}</option>
              {ORGANIZATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(KIND_KEY[k])}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}

      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && tab === "people" ? (
        <People api={d} people={data.people} canEdit={canEdit} onChanged={reload} />
      ) : null}
      {data && tab === "organizations" ? (
        <Organizations
          api={d}
          organizations={data.organizations}
          canEdit={canEdit}
          onChanged={reload}
        />
      ) : null}
      {tab === "import" && canEdit ? <Import api={d} onApplied={reload} /> : null}
      {tab === "suggestions" && canEdit ? (
        <Suggestions surface={surface} api={d} onResolved={reload} />
      ) : null}
    </section>
  );
}

// ── People ──────────────────────────────────────────────────────────────────────────────────────

function People({
  api,
  people,
  canEdit,
  onChanged,
}: {
  api: DirectoryApi;
  people: Contact[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [editing, setEditing] = useState<string | null>(null);
  const orgs = useApi(
    api.ops ? apiRoutes.opsDirectory : apiRoutes.portalDirectory,
    canEdit
      ? api.ops
        ? { params: { id: api.ops }, query: { type: "organization" } }
        : { query: { type: "organization" } }
      : null,
  );
  const organizations = (orgs.data?.organizations ?? []) as Organization[];
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        {people.length === 0 ? <EmptyState>{t("directory.people.empty")}</EmptyState> : null}
        <ul className="flex flex-col gap-3" data-testid="directory-people">
          {people.map((p) => (
            <li key={p.id}>
              <Card testId={`directory-person-${p.id}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">{p.name}</span>
                    <span className="block text-sm text-ink-muted">
                      {[p.title, p.organization?.name].filter(Boolean).join(" · ") ||
                        t("directory.person.noOrganization")}
                    </span>
                    <span className="block text-sm text-ink-muted">
                      {[p.email, p.phone, p.whatsapp].filter(Boolean).join(" · ")}
                    </span>
                    {p.languageUsed ? (
                      <span
                        className="block text-sm text-ink-muted"
                        data-testid={`directory-person-${p.id}-language`}
                      >
                        {languageUsedText(p.languageUsed, i18n)}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.relationship ? <Badge>{t(RELATIONSHIP_KEY[p.relationship])}</Badge> : null}
                    {p.optedOut ? <Badge>{t("contacts.optedOut")}</Badge> : null}
                    <AccessBadge access={p.access} testId={`directory-person-${p.id}-access`} />
                    {p.source && SOURCE_KEY[p.source] ? (
                      <span className="text-xs text-ink-muted">
                        {t(SOURCE_KEY[p.source] as PlainKey)}
                      </span>
                    ) : null}
                    {canEdit ? (
                      <InviteContactAction
                        person={p}
                        surface={api.ops ? "ops" : "portal"}
                        testId={`directory-person-${p.id}-invite`}
                        onInvite={(body) => api.invite(p.id, body)}
                        onInvited={onChanged}
                      />
                    ) : null}
                    {canEdit ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(editing === p.id ? null : p.id)}
                        data-testid={`directory-person-${p.id}-edit`}
                      >
                        {editing === p.id ? t("common.cancel") : t("directory.edit")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {editing === p.id ? (
                  <PersonForm
                    person={p}
                    organizations={organizations}
                    onSubmit={async (body) => {
                      await api.updatePerson(p.id, body);
                      setEditing(null);
                      onChanged();
                    }}
                  />
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      </div>
      {canEdit ? (
        <div>
          <SectionLabel>{t("directory.person.add")}</SectionLabel>
          <Card>
            <PersonForm
              person={null}
              organizations={organizations}
              onSubmit={async (body) => {
                await api.createPerson(body as ContactCreateInput);
                onChanged();
              }}
            />
          </Card>
        </div>
      ) : null}
    </div>
  );
}

export function PersonForm({
  person,
  organizations,
  onSubmit,
}: {
  person: Contact | null;
  organizations: Organization[];
  onSubmit: (body: ContactPatchInput) => Promise<void>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [name, setName] = useState(person?.name ?? "");
  const [email, setEmail] = useState(person?.email ?? "");
  const [phone, setPhone] = useState(person?.phone ?? "");
  const [title, setTitle] = useState(person?.title ?? "");
  const [relationship, setRelationship] = useState<Relationship | "">(person?.relationship ?? "");
  const [organizationId, setOrganizationId] = useState(person?.organization?.id ?? "");
  const [language, setLanguage] = useState<Locale | "">(
    (LOCALES as readonly string[]).includes(person?.language ?? "")
      ? (person?.language as Locale)
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const prefix = person ? `directory-person-${person.id}-form` : "directory-person-new";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!person && !email.trim() && !phone.trim()) {
      setMessage(t("directory.person.needsAddress"));
      return;
    }
    setBusy(true);
    setMessage(null);
    const body: ContactPatchInput = person
      ? {
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          title: title.trim() || null,
          relationship: relationship || null,
          organizationId: organizationId || null,
          language: language || null,
        }
      : {
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(relationship ? { relationship } : {}),
          ...(organizationId ? { organizationId } : {}),
          ...(language ? { language } : {}),
        };
    try {
      await onSubmit(body);
      if (!person) {
        setName("");
        setEmail("");
        setPhone("");
        setTitle("");
        setRelationship("");
        setOrganizationId("");
        setLanguage("");
        setMessage(t("directory.person.added"));
      }
    } catch (error) {
      setMessage(problem(error, i18n));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3" data-testid={prefix}>
      <Field label={t("directory.field.name")}>
        <TextInput
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid={`${prefix}-name`}
        />
      </Field>
      <Field label={t("directory.field.email")}>
        <TextInput
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid={`${prefix}-email`}
        />
      </Field>
      <Field label={t("directory.field.phone")} hint={t("directory.person.phoneHint")}>
        <TextInput
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          data-testid={`${prefix}-phone`}
        />
      </Field>
      <Field label={t("directory.field.title")}>
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid={`${prefix}-title`}
        />
      </Field>
      <Field label={t("directory.field.relationship")}>
        <Select
          value={relationship}
          onChange={(e) => setRelationship(e.target.value as Relationship | "")}
          data-testid={`${prefix}-relationship`}
        >
          <option value="">{t("directory.person.notSaid")}</option>
          {CONTACT_RELATIONSHIPS.map((r) => (
            <option key={r} value={r}>
              {t(RELATIONSHIP_KEY[r])}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("directory.field.organization")}>
        <Select
          value={organizationId}
          onChange={(e) => setOrganizationId(e.target.value)}
          data-testid={`${prefix}-organization`}
        >
          <option value="">{t("directory.person.noOrganization")}</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("directory.field.language")} hint={t("directory.language.personHint")}>
        <Select
          value={language}
          onChange={(e) => setLanguage(e.target.value as Locale | "")}
          data-testid={`${prefix}-language`}
        >
          <option value="">{t("directory.language.inherit")}</option>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {languageName(l, i18n)}
            </option>
          ))}
        </Select>
      </Field>
      {person && (email.trim() || null) !== person.email ? (
        <p className="text-sm text-ink-muted">{t("directory.person.addressNote")}</p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy} data-testid={`${prefix}-save`}>
          {person ? t("directory.save") : t("directory.person.add")}
        </Button>
        {message ? (
          <span role="status" className="text-sm text-ink-muted">
            {message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

// ── Organizations ───────────────────────────────────────────────────────────────────────────────

function Organizations({
  api,
  organizations,
  canEdit,
  onChanged,
}: {
  api: DirectoryApi;
  organizations: Organization[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [editing, setEditing] = useState<string | null>(null);
  const [problemOf, setProblemOf] = useState<Record<string, string>>({});

  async function link(o: Organization, on: boolean) {
    setProblemOf({ ...problemOf, [o.id]: "" });
    try {
      await api.linkVendor(o.id, on);
      onChanged();
    } catch (error) {
      setProblemOf({ ...problemOf, [o.id]: problem(error, i18n) });
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        {organizations.length === 0 ? (
          <EmptyState>{t("directory.organizations.empty")}</EmptyState>
        ) : null}
        <ul className="flex flex-col gap-3" data-testid="directory-organizations">
          {organizations.map((o) => (
            <li key={o.id}>
              <Card testId={`directory-org-${o.id}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">{o.name}</span>
                    <span className="block text-sm text-ink-muted">
                      {[o.website, o.email, o.phone].filter(Boolean).join(" · ")}
                    </span>
                    <span className="block text-sm text-ink-muted">
                      {t("directory.org.people", { count: o.people })}
                    </span>
                    <span
                      className="block text-sm text-ink-muted"
                      data-testid={`directory-org-${o.id}-language`}
                    >
                      {languageUsedText(o.languageUsed, i18n)}
                    </span>
                    {o.notes ? <p className="mt-1 text-sm text-ink">{o.notes}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {o.kinds.map((k) => (
                      <Badge key={k}>{t(KIND_KEY[k])}</Badge>
                    ))}
                    {canEdit ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(editing === o.id ? null : o.id)}
                        data-testid={`directory-org-${o.id}-edit`}
                      >
                        {editing === o.id ? t("common.cancel") : t("directory.edit")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  {o.vendor ? (
                    <>
                      <Badge tone="positive" testId={`directory-org-${o.id}-vendor`}>
                        {t("directory.org.vendorLinked", { name: o.vendor.name })}
                      </Badge>
                      {canEdit ? (
                        <Button size="sm" variant="link" onClick={() => link(o, false)}>
                          {t("directory.org.unlinkVendor")}
                        </Button>
                      ) : null}
                    </>
                  ) : canEdit && o.kinds.includes("vendor") ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => link(o, true)}
                        data-testid={`directory-org-${o.id}-link`}
                      >
                        {t("directory.org.linkVendor")}
                      </Button>
                      <span className="text-ink-muted">{t("directory.org.linkHint")}</span>
                    </>
                  ) : null}
                  {problemOf[o.id] ? (
                    <span role="alert" className="text-risk">
                      {problemOf[o.id]}
                    </span>
                  ) : null}
                </div>
                {editing === o.id ? (
                  <OrganizationForm
                    organization={o}
                    onSubmit={async (body) => {
                      await api.updateOrg(o.id, body);
                      setEditing(null);
                      onChanged();
                    }}
                  />
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      </div>
      {canEdit ? (
        <div>
          <SectionLabel>{t("directory.org.add")}</SectionLabel>
          <Card>
            <OrganizationForm
              organization={null}
              onSubmit={async (body) => {
                await api.createOrg(body as OrganizationCreateInput);
                onChanged();
              }}
            />
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function OrganizationForm({
  organization,
  onSubmit,
}: {
  organization: Organization | null;
  onSubmit: (body: OrganizationPatchInput) => Promise<void>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [name, setName] = useState(organization?.name ?? "");
  const [kinds, setKinds] = useState<OrganizationKind[]>(organization?.kinds ?? []);
  const [website, setWebsite] = useState(organization?.website ?? "");
  const [email, setEmail] = useState(organization?.email ?? "");
  const [phone, setPhone] = useState(organization?.phone ?? "");
  const [notes, setNotes] = useState(organization?.notes ?? "");
  const [language, setLanguage] = useState<Locale | "">(
    (organization?.language as Locale | null) ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const prefix = organization ? `directory-org-${organization.id}-form` : "directory-org-new";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const body: OrganizationPatchInput = organization
      ? {
          name: name.trim(),
          kinds,
          website: website.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          notes: notes.trim() || null,
          language: language || null,
        }
      : {
          name: name.trim(),
          kinds,
          ...(website.trim() ? { website: website.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(language ? { language } : {}),
        };
    try {
      await onSubmit(body);
      if (!organization) {
        setName("");
        setKinds([]);
        setWebsite("");
        setEmail("");
        setPhone("");
        setNotes("");
        setLanguage("");
        setMessage(t("directory.org.added"));
      }
    } catch (error) {
      setMessage(problem(error, i18n));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3" data-testid={prefix}>
      <Field label={t("directory.field.name")}>
        <TextInput
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid={`${prefix}-name`}
        />
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium text-ink">{t("directory.field.kinds")}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {ORGANIZATION_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={kinds.includes(k)}
                onChange={(e) =>
                  setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))
                }
                data-testid={`${prefix}-kind-${k}`}
              />
              {t(KIND_KEY[k])}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={t("directory.field.website")}>
        <TextInput
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          data-testid={`${prefix}-website`}
        />
      </Field>
      <Field label={t("directory.field.email")}>
        <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label={t("directory.field.phone")}>
        <TextInput value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Field label={t("directory.field.language")} hint={t("directory.language.orgHint")}>
        <Select
          value={language}
          onChange={(e) => setLanguage(e.target.value as Locale | "")}
          data-testid={`${prefix}-language`}
        >
          <option value="">{t("directory.language.yours")}</option>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {languageName(l, i18n)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("directory.field.notes")}>
        <TextArea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy} data-testid={`${prefix}-save`}>
          {organization ? t("directory.save") : t("directory.org.add")}
        </Button>
        {message ? (
          <span role="status" className="text-sm text-ink-muted">
            {message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────────

const ACTION_TONE = { add: "accent", update: "accent", same: "neutral", error: "risk" } as const;
const ACTION_KEY: Record<ImportPreview["rows"][number]["action"], PlainKey> = {
  add: "directory.import.action.add",
  update: "directory.import.action.update",
  same: "directory.import.action.same",
  error: "directory.import.action.error",
};
const RESULT_KEY: Record<ImportResult["results"][number]["status"], PlainKey> = {
  added: "directory.import.result.added",
  updated: "directory.import.result.updated",
  unchanged: "directory.import.result.unchanged",
  skipped: "directory.import.result.skipped",
  failed: "directory.import.result.failed",
};

type Pending =
  | { from: "csv"; csv: string; preview: ImportPreview }
  | { from: "tool"; connectionId: string; preview: ImportPreview };

function Import({ api, onApplied }: { api: DirectoryApi; onApplied: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [kind, setKind] = useState<DirectoryImportKind>("people");
  const [pending, setPending] = useState<Pending | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<ImportResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sources = useApi(
    api.ops ? apiRoutes.opsDirectoryImportSources : apiRoutes.portalDirectoryImportSources,
    api.ops ? { params: { id: api.ops } } : {},
  );
  const [connectionId, setConnectionId] = useState("");
  const [word, setWord] = useState("");
  const [appId, setAppId] = useState("");
  const source = sources.data?.sources.find((s) => s.connectionId === connectionId);

  function show(p: Pending) {
    setPending(p);
    setResult(null);
    setChosen(
      new Set(
        p.preview.rows.filter((r) => r.action === "add" || r.action === "update").map((r) => r.row),
      ),
    );
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage(problem(error, i18n));
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    const csv = await textOf(file);
    await run(async () => show({ from: "csv", csv, preview: await api.previewCsv(kind, csv) }));
  }

  async function readTool() {
    if (!source) return;
    await run(async () =>
      show({
        from: "tool",
        connectionId: source.connectionId,
        preview: await api.previewTool({
          connectionId: source.connectionId,
          kind,
          ...(source.connector === "zoho_crm" ? { query: word.trim() } : {}),
          ...(source.connector === "podio" ? { appId: Number(appId) } : {}),
        }),
      }),
    );
  }

  async function apply() {
    if (!pending) return;
    await run(async () => {
      const picked = pending.preview.rows.filter((r) => chosen.has(r.row) && r.data);
      const body: ImportApplyBody =
        pending.from === "csv"
          ? { source: "csv", kind, csv: pending.csv, rows: [...chosen] }
          : {
              source: "connector",
              kind,
              connectionId: pending.connectionId,
              ...(kind === "people"
                ? { people: picked.map((r) => r.data as PersonImportRow) }
                : { organizations: picked.map((r) => r.data as OrganizationImportRow) }),
            };
      setResult(await api.apply(body));
      setPending(null);
      onApplied();
    });
  }

  return (
    <div className="flex flex-col gap-6" data-testid="directory-import">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <Field label={t("directory.import.kind")}>
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as DirectoryImportKind);
                setPending(null);
              }}
              data-testid="directory-import-kind"
            >
              <option value="people">{t("directory.import.people")}</option>
              <option value="organizations">{t("directory.import.organizations")}</option>
            </Select>
          </Field>
          <p className="mt-3 text-sm text-ink-muted">{t("directory.import.note")}</p>
        </Card>
        <Card>
          <Field label={t("directory.import.csv")} hint={t("directory.import.csvHint")}>
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(e) => readFile(e.target.files?.[0])}
              data-testid="directory-import-file"
              className="text-sm text-ink"
            />
          </Field>
        </Card>
        <Card>
          <SectionLabel>{t("directory.import.fromTool")}</SectionLabel>
          {sources.data && sources.data.sources.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("directory.import.noTools")}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <Field label={t("directory.import.tool")}>
                <Select
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  data-testid="directory-import-tool"
                >
                  <option value="">—</option>
                  {sources.data?.sources.map((s) => (
                    <option key={s.connectionId} value={s.connectionId}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {source?.connector === "zoho_crm" ? (
                <Field label={t("directory.import.word")} hint={t("directory.import.wordHint")}>
                  <TextInput value={word} onChange={(e) => setWord(e.target.value)} />
                </Field>
              ) : null}
              {source?.connector === "podio" ? (
                <Field label={t("directory.import.app")}>
                  <TextInput
                    inputMode="numeric"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value.replace(/\D/g, ""))}
                  />
                </Field>
              ) : null}
              <Button
                disabled={
                  busy ||
                  !source ||
                  (source.connector === "zoho_crm" && word.trim().length < 2) ||
                  (source.connector === "podio" && !appId)
                }
                onClick={readTool}
                data-testid="directory-import-read"
              >
                {t("directory.import.read")}
              </Button>
            </div>
          )}
        </Card>
      </div>

      {message ? (
        <p role="alert" className="text-sm text-risk">
          {message}
        </p>
      ) : null}

      {pending ? (
        <section data-testid="directory-import-preview">
          <SectionLabel
            action={
              <Button
                variant="primary"
                disabled={busy || chosen.size === 0}
                onClick={apply}
                data-testid="directory-import-apply"
              >
                {t("directory.import.apply", { count: chosen.size })}
              </Button>
            }
          >
            {t("directory.import.counts", pending.preview.counts)}
          </SectionLabel>
          {pending.preview.more ? (
            <p className="mb-2 text-sm text-ink-muted">{t("directory.import.more")}</p>
          ) : null}
          <div className="dt dt-ana">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th />
                  <th>{t("directory.import.row")}</th>
                  <th>{t("directory.field.name")}</th>
                  <th>{t("directory.import.what")}</th>
                  <th>{t("directory.import.details")}</th>
                </tr>
              </thead>
              <tbody>
                {pending.preview.rows.map((r) => (
                  <tr key={r.row} data-testid={`directory-import-row-${r.row}`}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t("directory.import.choose", { row: r.row })}
                        disabled={r.action === "error" || r.action === "same"}
                        checked={chosen.has(r.row)}
                        onChange={(e) => {
                          const next = new Set(chosen);
                          if (e.target.checked) next.add(r.row);
                          else next.delete(r.row);
                          setChosen(next);
                        }}
                      />
                    </td>
                    <td className="figures">{r.row}</td>
                    <td className="text-ink">{r.data?.name ?? "—"}</td>
                    <td>
                      <Badge tone={ACTION_TONE[r.action]}>{t(ACTION_KEY[r.action])}</Badge>
                    </td>
                    <td className="text-sm">
                      {r.match ? (
                        <span className="block text-ink-muted">
                          {t("directory.import.matches", { name: r.match.name })}
                        </span>
                      ) : null}
                      {r.changes.length > 0 ? (
                        <span className="block text-ink">
                          {r.changes
                            .map(
                              (c) =>
                                `${directoryFieldName(c.field, i18n)}: ${directoryValue(c.after, i18n)}`,
                            )
                            .join("; ")}
                        </span>
                      ) : null}
                      {r.changesAddress ? (
                        <Badge tone="warning">{t("directory.import.changesAddress")}</Badge>
                      ) : null}
                      {r.problems.length > 0 ? (
                        <span className="block text-risk">{r.problems.join("; ")}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {result ? (
        <section data-testid="directory-import-result">
          <SectionLabel>{t("directory.import.done", result.counts)}</SectionLabel>
          <ul className="flex flex-col gap-1 text-sm">
            {result.results
              .filter((r) => r.status !== "skipped")
              .map((r) => (
                <li key={r.row} className="flex flex-wrap items-center gap-2">
                  <span className="figures text-ink-muted">{r.row}</span>
                  <span className="text-ink">{r.name ?? "—"}</span>
                  <Badge
                    tone={
                      r.status === "failed"
                        ? "risk"
                        : r.status === "unchanged"
                          ? "neutral"
                          : "positive"
                    }
                  >
                    {t(RESULT_KEY[r.status])}
                  </Badge>
                  {r.problem ? <span className="text-risk">{r.problem}</span> : null}
                </li>
              ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** A file's text (FileReader: older browsers and the test DOM lack `File.text()`). */
function textOf(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function directoryFieldName(field: string, i18n: I18n): string {
  const key = FIELD_KEY[field];
  return key ? i18n.t(key) : field;
}

// ── Suggestions ─────────────────────────────────────────────────────────────────────────────────

function suggestionTitle(s: DirectorySuggestion, i18n: I18n): string {
  const { t } = i18n;
  const c = s.change;
  switch (c.action) {
    case "add_person":
      return t("directory.suggestions.add", { name: c.person.name });
    case "add_organization":
      return t("directory.suggestions.add", { name: c.organization.name });
    default:
      return t("directory.suggestions.update", { name: s.target?.name ?? "—" });
  }
}

/** What an addition would add, field by field. */
function additionFields(s: DirectorySuggestion): [string, unknown][] {
  const c = s.change;
  if (c.action === "add_person") return Object.entries(c.person);
  if (c.action === "add_organization") return Object.entries(c.organization);
  return [];
}

function Suggestions({
  surface,
  api,
  onResolved,
}: {
  surface: DirectorySurface;
  api: DirectoryApi;
  onResolved: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const list = useApi(
    surface.kind === "ops"
      ? apiRoutes.opsDirectorySuggestions
      : apiRoutes.portalDirectorySuggestions,
    surface.kind === "ops" ? { params: { id: surface.clientId } } : {},
  );
  const [problemOf, setProblemOf] = useState<Record<string, string>>({});

  async function decide(id: string, decision: "approve" | "reject") {
    setProblemOf({ ...problemOf, [id]: "" });
    try {
      await api.resolve(id, decision);
      list.reload();
      onResolved();
    } catch (error) {
      setProblemOf({ ...problemOf, [id]: problem(error, i18n) });
    }
  }

  if (list.error) return <ErrorNotice error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  if (list.data.items.length === 0) {
    return <EmptyState>{t("directory.suggestions.empty")}</EmptyState>;
  }
  return (
    <ul className="flex flex-col gap-3" data-testid="directory-suggestions">
      {list.data.items.map((s) => (
        <li key={s.id}>
          <Card testId={`directory-suggestion-${s.id}`}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <span className="block text-sm text-ink-muted">
                  {t("directory.suggestions.from", {
                    agent: s.agent?.name ?? t("directory.suggestions.anAgent"),
                  })}
                </span>
                <span className="block font-medium text-ink">{suggestionTitle(s, i18n)}</span>
              </div>
              <Badge tone="warning">{t("common.waitingOnYou")}</Badge>
            </div>
            <Detail label={t("directory.suggestions.why")}>
              <span className="text-ink">{s.reason}</span>
            </Detail>
            <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              {s.diff.map((d) => (
                <div key={d.field} className="contents">
                  <dt className="text-ink-muted">{directoryFieldName(d.field, i18n)}</dt>
                  <dd className="text-ink">
                    {directoryValue(d.before, i18n)} → {directoryValue(d.after, i18n)}
                  </dd>
                </div>
              ))}
              {additionFields(s).map(([field, value]) => (
                <div key={field} className="contents">
                  <dt className="text-ink-muted">{directoryFieldName(field, i18n)}</dt>
                  <dd className="text-ink">{directoryValue(value, i18n)}</dd>
                </div>
              ))}
            </dl>
            {s.changesAddress ? (
              <p
                className="mt-2 text-sm text-ink"
                data-testid={`directory-suggestion-${s.id}-address`}
              >
                <Badge tone="warning">{t("directory.import.changesAddress")}</Badge>{" "}
                {t("directory.suggestions.address")}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => decide(s.id, "approve")}
                data-testid={`directory-suggestion-${s.id}-accept`}
              >
                {t("directory.suggestions.accept")}
              </Button>
              <Button
                onClick={() => decide(s.id, "reject")}
                data-testid={`directory-suggestion-${s.id}-decline`}
              >
                {t("directory.suggestions.decline")}
              </Button>
              {problemOf[s.id] ? (
                <span role="alert" className="text-sm text-risk">
                  {problemOf[s.id]}
                </span>
              ) : null}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="mt-2 text-sm">
      <span className="text-ink-muted">{label}: </span>
      {children}
    </p>
  );
}
