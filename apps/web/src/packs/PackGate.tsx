// A pack's report page in the back office, for a client that doesn't have the pack on. The client
// page links a pack's reports only once it is on, but an address can still be opened by hand or
// from an old link (QA on staging: Materials, Bookkeeping and Marketing pages for clients without
// them answered "report not found"). The page says the area is off and where to switch it on
// (the client page's Areas tab, §1.162).
import type { ReactNode } from "react";
import { apiRoutes } from "../api/routes";
import { useApi } from "../api/useApi";
import { EmptyState } from "../ui/primitives";

export function PackGate({
  clientId,
  pack,
  children,
}: {
  clientId: string;
  /** The pack's id (`materials`, `bookkeeping`, `marketing`). */
  pack: string;
  children: ReactNode;
}) {
  const packs = useApi(apiRoutes.opsClientPacks, { params: { id: clientId } });
  const found = packs.data?.packs.find((p) => p.id === pack);
  // Until the list answers (or if it can't), the page shows as before: its own loading and errors.
  if (!found || found.enabled) return <>{children}</>;
  return (
    <EmptyState
      testId={`pack-off-${pack}`}
      title={`${found.area ?? found.name} is off for this client`}
      line="Switch it on in the client's Areas tab to see these reports."
      action={{
        label: "Open Areas",
        to: `/ops/clients/${clientId}/areas`,
        testId: `pack-off-${pack}-open`,
      }}
    />
  );
}
