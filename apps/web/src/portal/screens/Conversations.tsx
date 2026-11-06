// v0.14 capture: `/conversations` (client admin; docs/plan.md §1.55; UI-3a, drafted in the
// prototype's style): the client's WhatsApp conversations and what we keep from each, with the
// keep and download switches per conversation. The panel is shared with the back office.
import { ConversationsPanel } from "../../conversations/ConversationsPanel";
import { useI18n } from "../../i18n/i18n";
import { useSession } from "../../session/session";
import { Page } from "../../ui/page";
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
    <Page testId="portal-conversations-page">
      <PageHeader title={t("conversations.title")} subtitle={t("conversations.subtitle")} />
      <div>
        <ConversationsPanel surface={{ kind: "portal" }} />
      </div>
    </Page>
  );
}
