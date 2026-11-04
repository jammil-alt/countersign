// `/contacts` (client admin; plan §1.22): the people your services may reach, and how each agreed
// to it. `/people` (plan §1.25): who each of your services reaches for its roles, and when. Plain
// English for now; the languages stream moves it to t().
import { ContactsPanel } from "../../contacts/ContactsPanel";
import { PortalPeopleList } from "../../people/PeoplePanel";
import { useSession } from "../../session/session";
import { PageHeader, Placeholder } from "../../ui/primitives";

export function PortalContactsScreen() {
  const session = useSession();
  const client = session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0];
  if (client?.role !== "client_admin") {
    return <Placeholder title="Contacts">Your admin keeps the contacts list.</Placeholder>;
  }
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Contacts"
        subtitle="The people we may email, text, message on WhatsApp or call for you. We only reach those who agreed, and never in quiet hours."
      />
      <ContactsPanel surface={{ kind: "portal" }} />
    </div>
  );
}

export function PortalPeopleScreen() {
  const session = useSession();
  const client = session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0];
  if (client?.role !== "client_admin") {
    return <Placeholder title="People">Your admin chooses who your services reach.</Placeholder>;
  }
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="People"
        subtitle="Who each of your services reaches, and when. We only reach people who agreed, on the channels they agreed to."
      />
      <PortalPeopleList />
    </div>
  );
}
