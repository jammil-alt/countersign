// Pack screens in the portal (ARCHITECTURE §15): the portal mounts a pack's reports from the
// registry (./registry.ts). The back office's pack screens are in ./opsScreens.tsx, so the portal's
// first load (scripts/web-size.mjs) never carries the back office's client frame.
import { lazy, Suspense } from "react";
import { useParams } from "react-router-dom";
import { BankTransactionsView } from "./bookkeeping/BankTransactions";
import { ReconciliationsView } from "./bookkeeping/Reconciliations";
import { CatalogView, PriceWatchView } from "./materials/Reports";
// P-9
import { RequestsView, RequestView } from "./materials/Requests";
// §1.88
import { MasterItemView, VendorCatalogView } from "./materials/VendorCatalog";

// ── Portal ───────────────────────────────────────────────────────────────────────────────────────

export const PortalPriceWatchScreen = () => <PriceWatchView />;
// §1.88: the catalog, or one master item's page (its vendors side by side) when the route names it.
export function PortalCatalogScreen() {
  const { id } = useParams();
  return id ? <MasterItemView /> : <CatalogView />;
}
// §1.88: the vendor catalog, read only; `…/vendor-catalog/:id` opens that vendor.
export const PortalVendorCatalogScreen = () => <VendorCatalogView />;
// P-9: the list, or one request's page when the route names it.
export function PortalRequestsScreen() {
  const { id } = useParams();
  return id ? <RequestView /> : <RequestsView />;
}

// B-6 (docs/plan.md §1.79): the Bookkeeping area's Bank transactions.
export const PortalBankTransactionsScreen = () => <BankTransactionsView />;
// R-1 (docs/plan.md §1.80): Reconciliations.
export const PortalReconciliationsScreen = () => <ReconciliationsView />;

// §1.232: the Close pack's month-end close, loaded when opened (never in the first load).
const CloseReport = lazy(() =>
  import("./close/Close").then((m) => ({ default: m.PortalCloseScreen })),
);
export const PortalCloseScreen = () => (
  <Suspense fallback={null}>
    <CloseReport />
  </Suspense>
);
