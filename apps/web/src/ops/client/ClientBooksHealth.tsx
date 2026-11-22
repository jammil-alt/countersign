// Books health (docs/plan.md §1.216) in the back office: the client's report under its Data tab,
// the same page the client's admin reads in the portal. Loaded when opened.
import { useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { BooksHealthReportView } from "../../books-health/BooksHealth";
import { Loaded } from "../../ui/page";
import { SkeletonCard } from "../../ui/skeleton";
import { ClientFrame } from "./ClientFrame";

export function OpsClientBooksHealthScreen() {
  const { clientId = "" } = useParams();
  const state = useApi(apiRoutes.opsClientBooksHealth, { params: { id: clientId } });
  return (
    <ClientFrame clientId={clientId}>
      <Loaded state={state} skeleton={<SkeletonCard lines={8} />}>
        {(view) => <BooksHealthReportView view={view} />}
      </Loaded>
    </ClientFrame>
  );
}
