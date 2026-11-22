// The Close pack's report in the back office (docs/plan.md §1.232): a client's months under its
// Areas tab, the same view the client reads in the portal. Loaded when opened.
import { useParams } from "react-router-dom";
import { ClientFrame } from "../../ops/client/ClientFrame";
import { PackGate } from "../PackGate";
import { CloseReportView } from "./Close";

export function OpsClientCloseScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <PackGate clientId={clientId} pack="close">
        <CloseReportView clientId={clientId} />
      </PackGate>
    </ClientFrame>
  );
}
