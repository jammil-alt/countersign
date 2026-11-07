// `/upload` (UI-3a, drafted in the prototype's style; ARCHITECTURE §6.3, §6.5): how invoices
// arrive. Drop files or choose them, see the latest documents and open each one; the private
// forwarding address and who may forward to it sit in the rail (the client admin edits the list).
// The same parts are on the page of each agent that reads documents.
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { useSession } from "../../session/session";
import { Page, PageGrid } from "../../ui/page";
import { buttonClass, PageHeader } from "../../ui/primitives";
import { PORTAL_PATHS } from "../paths";
import { DropZone, Forwarding, RecentDocuments } from "./Upload";

export function PortalUploadScreen() {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  const isAdmin = client?.role === "client_admin";
  const documents = useApi(apiRoutes.portalDocuments, { query: { limit: 20 } });

  return (
    <Page testId="portal-upload-page">
      <PageHeader
        title={t("uploadPage.title")}
        subtitle={t("uploadPage.subtitle")}
        actions={
          <Link to={PORTAL_PATHS.records} className={buttonClass("secondary")}>
            {t("uploadPage.records")}
          </Link>
        }
      />
      <PageGrid rail={<Forwarding isAdmin={isAdmin} />}>
        <DropZone onUploaded={documents.reload} />
        <RecentDocuments state={documents} />
      </PageGrid>
    </Page>
  );
}
