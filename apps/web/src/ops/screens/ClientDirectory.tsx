// The client page's Directory tab (plan §1.27): the client's people and organizations, which the
// operator edits fully, as the client admin does in the portal: search and filters, edit, the
// vendor link, imports and agents' suggestions.
import { useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { DirectoryPanel } from "../../directory/DirectoryPanel";
import { PageHeader } from "../../ui/primitives";
import { ClientTabs } from "./ClientKnowledge";

export function ClientDirectoryRoute() {
  const { clientId = "" } = useParams();
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  return (
    <div>
      <PageHeader
        title={client.data?.client.name ?? "Client"}
        subtitle="The people and organizations this client's agents work with, shared by all of them."
      />
      <ClientTabs clientId={clientId} />
      <DirectoryPanel surface={{ kind: "ops", clientId }} canEdit />
    </div>
  );
}
