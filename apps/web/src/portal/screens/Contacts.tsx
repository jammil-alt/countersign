// `/contacts` (client admin; plan §1.22): the people your services may reach, and how each agreed
// to it. `/people` (plan §1.25): who each of your services reaches for its roles, and when. Words
// in the reader's language (docs/plan.md §1.18); names, numbers and messages stay as written.
import { ContactsPanel } from "../../contacts/ContactsPanel";
import { DirectoryPanel } from "../../directory/DirectoryPanel";
import { useI18n } from "../../i18n/i18n";
import { PortalPeopleList } from "../../people/PeoplePanel";
import { useSession } from "../../session/session";
import { PageHeader, Placeholder } from "../../ui/primitives";

export function PortalContactsScreen() {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  if (client?.role !== "client_admin") {
    return <Placeholder title={t("contacts.title")}>{t("contacts.adminOnly")}</Placeholder>;
  }
  return (
    <div className="max-w-5xl">
      <PageHeader title={t("contacts.title")} subtitle={t("contacts.subtitle")} />
      <ContactsPanel surface={{ kind: "portal" }} />
    </div>
  );
}

export function PortalPeopleScreen() {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  if (client?.role !== "client_admin") {
    return <Placeholder title={t("reach.title")}>{t("reach.adminOnly")}</Placeholder>;
  }
  return (
    <div className="max-w-5xl">
      <PageHeader title={t("reach.title")} subtitle={t("reach.subtitle")} />
      <PortalPeopleList />
    </div>
  );
}

/** `/directory` (plan §1.27): the client admin edits it; client users look people up. */
export function PortalDirectoryScreen() {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  const admin = client?.role === "client_admin";
  return (
    <div className="max-w-6xl">
      <PageHeader
        title={t("directory.title")}
        subtitle={admin ? t("directory.subtitle") : t("directory.readOnly")}
      />
      <DirectoryPanel surface={{ kind: "portal" }} canEdit={admin} />
    </div>
  );
}
