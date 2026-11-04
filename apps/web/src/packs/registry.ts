// The slot for pack reports in the portal (ARCHITECTURE §15: `/reports/<pack>/<report>`, e.g.
// Materials' Price watch at /reports/materials/prices). A pack's screens live under
// `src/packs/<id>/` and register here; the Reports screen lists each one whose pack the client has
// enabled (the activity report names them) and mounts it at its path.
import type { ComponentType } from "react";
import { CatalogView, PriceWatchView } from "./materials/Reports";

export interface PackReport {
  /** The pack's id, as `tenant_pack.pack` names it, e.g. "materials". */
  pack: string;
  /** The report's path segment, e.g. "prices". */
  slug: string;
  title: string;
  /** One plain line for the reports list. */
  description: string;
  Component: ComponentType;
}

// DECISION: pack reports are registered in the web app (the screens are code) and shown only for
// packs the client has enabled, which the API names (`packs` on the activity report).
// DECISION (wave 1 integration): Materials' Price watch and Catalog (M8b) mount through this
// registry under M11's Reports page, so the portal has one `/reports` screen.
export const PACK_REPORTS: readonly PackReport[] = [
  {
    pack: "materials",
    slug: "prices",
    title: "Price watch",
    description: "What you pay for each material, by vendor, and the changes we flagged.",
    Component: PriceWatchView,
  },
  {
    pack: "materials",
    slug: "catalog",
    title: "Catalog",
    description: "The materials you buy, with each vendor's names for them.",
    Component: CatalogView,
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
