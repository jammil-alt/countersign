// The slot for pack reports in the portal (ARCHITECTURE §15: `/reports/<pack>/<report>`, e.g.
// Materials' Price watch at /reports/materials/prices). A pack's screens live under
// `src/packs/<id>/` and register here; the Reports screen lists each one whose pack the client has
// enabled (the activity report names them) and mounts it at its path.
import type { ComponentType } from "react";
import type { PlainKey } from "../i18n/catalog";
import { PortalCatalogScreen, PortalPriceWatchScreen, PortalRequestsScreen } from "./screens";

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
  // P-9: purchase requests, then one request's page at /reports/materials/requests/:id.
  {
    pack: "materials",
    slug: "requests",
    titleKey: "materials.requests.title",
    descriptionKey: "materials.requests.description",
    Component: PortalRequestsScreen,
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
