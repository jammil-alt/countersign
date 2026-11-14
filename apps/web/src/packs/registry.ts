// The slot for pack reports in the portal (ARCHITECTURE §15: `/reports/<pack>/<report>`, e.g.
// Materials' Price watch at /reports/materials/prices). A pack's screens live under
// `src/packs/<id>/` and register here; the Reports screen lists each one whose pack the client has
// enabled (the activity report names them) and mounts it at its path.
import type { ComponentType } from "react";
import type { PlainKey } from "../i18n/catalog";
import { PortalSearchScreen } from "./marketing/portal/Search";
import { PortalWebsiteScreen } from "./marketing/portal/Website";
import { PortalWeeklyReportScreen } from "./marketing/portal/WeeklyReport";
import {
  PortalBankTransactionsScreen,
  PortalCatalogScreen,
  PortalPriceWatchScreen,
  PortalReconciliationsScreen,
  PortalRequestsScreen,
  PortalVendorCatalogScreen,
} from "./screens";

export interface PackReport {
  /** The pack's id, as `tenant_pack.pack` names it, e.g. "materials". */
  pack: string;
  /** The report's path segment, e.g. "prices". */
  slug: string;
  /** Its title, as a message key: the portal shows it in the reader's language. */
  titleKey: PlainKey;
  /** One plain line for the reports list, as a message key. */
  descriptionKey: PlainKey;
  Component: ComponentType;
}

// DECISION: pack reports are registered in the web app (the screens are code) and shown only for
// packs the client has enabled, which the API names (`packs` on the activity report). Their titles
// and descriptions are message keys, so the portal reads them in the client's language.
export const PACK_REPORTS: readonly PackReport[] = [
  {
    pack: "materials",
    slug: "prices",
    titleKey: "materials.prices.title",
    descriptionKey: "materials.prices.description",
    Component: PortalPriceWatchScreen,
  },
  {
    pack: "materials",
    slug: "catalog",
    titleKey: "materials.catalog.title",
    descriptionKey: "materials.catalog.description",
    Component: PortalCatalogScreen,
  },
  // §1.88: the vendor catalog, read only (a master item's vendors are on its catalog page,
  // /reports/materials/catalog/:id; one vendor's items at /reports/materials/vendor-catalog/:id).
  {
    pack: "materials",
    slug: "vendor-catalog",
    titleKey: "materials.vendors.title",
    descriptionKey: "materials.vendors.description",
    Component: PortalVendorCatalogScreen,
  },
  // P-9: purchase requests, then one request's page at /reports/materials/requests/:id.
  {
    pack: "materials",
    slug: "requests",
    titleKey: "materials.requests.title",
    descriptionKey: "materials.requests.description",
    Component: PortalRequestsScreen,
  },
  // M50 (docs/plan.md §1.78): the Marketing area for a client with it on, read only. The slugs are
  // the reports the API lets the portal read (the pack's portal screens).
  {
    pack: "marketing",
    slug: "overview",
    titleKey: "marketing.website.title",
    descriptionKey: "marketing.website.description",
    Component: PortalWebsiteScreen,
  },
  {
    pack: "marketing",
    slug: "search",
    titleKey: "marketing.search.title",
    descriptionKey: "marketing.search.description",
    Component: PortalSearchScreen,
  },
  {
    pack: "marketing",
    slug: "weekly-report",
    titleKey: "marketing.weekly.title",
    descriptionKey: "marketing.weekly.description",
    Component: PortalWeeklyReportScreen,
  },
  // B-6 (docs/plan.md §1.79): the Bookkeeping area's bank transactions, read only.
  {
    pack: "bookkeeping",
    slug: "transactions",
    titleKey: "bookkeeping.transactions.title",
    descriptionKey: "bookkeeping.transactions.description",
    Component: PortalBankTransactionsScreen,
  },
  // R-1 (docs/plan.md §1.80): reconciliations, read only (a person decides on the card).
  {
    pack: "bookkeeping",
    slug: "reconciliations",
    titleKey: "bookkeeping.recons.title",
    descriptionKey: "bookkeeping.recons.description",
    Component: PortalReconciliationsScreen,
  },
];

/** The registered reports of the packs a client has enabled, in registration order. */
export function packReportsFor(
  packs: readonly string[],
  registry: readonly PackReport[] = PACK_REPORTS,
): PackReport[] {
  return registry.filter((r) => packs.includes(r.pack));
}

export const packReportPath = (r: Pick<PackReport, "pack" | "slug">) =>
  `/reports/${r.pack}/${r.slug}`;
