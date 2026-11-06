// The client page's Directory tab (plan §1.27): the client's people and organizations, which the
// operator edits fully, as the client admin does in the portal: search and filters, edit, the
// vendor link, imports and agents' suggestions.
import { useParams } from "react-router-dom";
import { DirectoryPanel } from "../../directory/DirectoryPanel";
import { ClientFrame } from "../client/ClientFrame";

export function ClientDirectoryRoute() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame
      clientId={clientId}
      intro="The people and organizations this client's agents work with, shared by all of them."
    >
      <DirectoryPanel surface={{ kind: "ops", clientId }} canEdit />
    </ClientFrame>
  );
}
