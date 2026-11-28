// Step model §7 (stream D): the Match engine's port, as the deployment registers it. Every match
// profile a pack's manifest declares has its one matcher, and nothing else is matched to.

import { describe, expect, it } from "vitest";
import { DEPLOYMENT_PACKS, matchPort } from "./packs";
import { matchItems } from "./runs/match";

describe("the Match port", () => {
  it("reaches every profile the packs declare, and only those", () => {
    for (const pack of DEPLOYMENT_PACKS) {
      const declared = pack.manifest.matchProfiles.map((p) => p.id).sort();
      const matched = (pack.matchers ?? []).map((m) => m.profile.id).sort();
      expect(matched, pack.manifest.id).toEqual(declared);
      for (const m of pack.matchers ?? []) {
        expect(pack.manifest.matchProfiles.find((p) => p.id === m.profile.id)).toEqual(m.profile);
      }
    }
    expect(
      matchPort()
        .profiles()
        .map((p) => [p.id, p.area, p.record]),
    ).toEqual([
      ["vendors", "shared", "vendor"],
      ["vendor-items", "purchasing", "vendor_item"],
      ["master-items", "purchasing", "catalog_item"],
      ["crm-records", "sales", "crm_record"],
    ]);
  });

  it("names every retired tool among the pack's own", () => {
    const retired = DEPLOYMENT_PACKS.flatMap((p) => Object.keys(p.manifest.retiredTools ?? {}));
    expect(retired).toHaveLength(15);
    for (const pack of DEPLOYMENT_PACKS) {
      for (const id of Object.keys(pack.manifest.retiredTools ?? {})) {
        expect(pack.handlers[id], id).toBeDefined();
      }
    }
  });
});

// Staging, 2026-11-28: a SKU match's vendor sat beside the invoice's lines and reached none.
describe("what a Match step matches", () => {
  it("is each item of its list, with what the step gives beside the list", () => {
    expect(
      matchItems({
        vendorId: "v1",
        items: [{ sku: "NF-BB34" }, { sku: "NF-RO44", vendorId: "v2" }, "loose"],
      }),
    ).toEqual([
      { vendorId: "v1", sku: "NF-BB34" },
      // The item's own field wins.
      { vendorId: "v2", sku: "NF-RO44" },
      { vendorId: "v1", value: "loose" },
    ]);
  });

  it("is the input itself, as one item, without a list", () => {
    expect(matchItems({ name: "Northfork Lumber Co." })).toEqual([
      { name: "Northfork Lumber Co." },
    ]);
    expect(matchItems("x")).toEqual([{ value: "x" }]);
  });
});
