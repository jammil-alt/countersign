// v0.14 capture: `/conversations` (client admin; docs/plan.md §1.55): the client's WhatsApp
// conversations and what we keep from each. Minimal until the owner's redesign.
import { ConversationsPanel } from "../../conversations/ConversationsPanel";
import { useI18n } from "../../i18n/i18n";
import { useSession } from "../../session/session";
import { PageHeader, Placeholder } from "../../ui/primitives";

export function PortalConversationsScreen() {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  if (client?.role !== "client_admin") {
    return (
      <Placeholder title={t("conversations.title")}>{t("conversations.adminOnly")}</Placeholder>
    );
  }
  return (
    <div className="max-w-5xl">
      <PageHeader title={t("conversations.title")} subtitle={t("conversations.subtitle")} />
      <ConversationsPanel surface={{ kind: "portal" }} />
    </div>
  );
}
