// `/contacts` (client admin; plan §1.22): the people your services may text or message on WhatsApp,
// and how each agreed to it. Plain English for now; the languages stream moves it to t().
import { ContactsPanel } from "../../contacts/ContactsPanel";
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
        subtitle="The people we may text or message on WhatsApp for you. We only message those who agreed, and never in quiet hours."
      />
      <ContactsPanel surface={{ kind: "portal" }} />
    </div>
  );
}
