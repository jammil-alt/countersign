// Plan entry §1.233: a client's Bills to pay in the back office, inside the client's frame and
// shown only when the client has the AP pack on. Its own chunk, loaded when opened.
import { useParams } from "react-router-dom";
import { ClientFrame } from "../../ops/client/ClientFrame";
import { PackGate } from "../PackGate";
import { BillsToPayView } from "./BillsToPay";

export function OpsClientBillsToPayScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <PackGate clientId={clientId} pack="ap">
        <BillsToPayView clientId={clientId} />
      </PackGate>
    </ClientFrame>
  );
}
