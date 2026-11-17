// The client page's File tab (`/ops/clients/:clientId/file`; docs/plan.md §1.126): the client's
// file, what we know about them by section. Invite is beside the client's name on every tab (the
// frame). A client made before files existed starts its file here.
import { useParams } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Loading } from "../../../ui/primitives";
import { ClientFrame, useClientPage } from "../../client/ClientFrame";
import { ClientFileView, StartFile } from "./ClientFile";

export function ClientFileScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame
      clientId={clientId}
      intro="What we know about them, from the first call on. Our notes stay ours."
    >
      <ClientFileBody clientId={clientId} />
    </ClientFrame>
  );
}

function ClientFileBody({ clientId }: { clientId: string }) {
  const files = useApi(apiRoutes.opsClientFiles, { query: { client: clientId } });
  const client = useClientPage();
  if (files.loading && !files.data) return <Loading />;
  if (!files.data) {
    return files.error ? <ErrorNotice error={files.error} onRetry={files.reload} /> : null;
  }
  const file = files.data.files[0];
  if (!file) {
    return (
      <StartFile
        name={client.data?.client.name ?? "this client"}
        clientId={clientId}
        onMade={() => files.reload()}
      />
    );
  }
  return <ClientFileView fileId={file.id} />;
}
