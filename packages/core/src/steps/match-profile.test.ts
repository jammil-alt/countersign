import { describe, expect, it } from "vitest";
import { MatchProfile, matchResultFields, matchSettingsProblems } from "./match-profile";
import { MatchSettings, Workflow } from "./schema";
import { validateWorkflow } from "./validate";

const vendorItems = MatchProfile.parse({
  id: "vendor-items",
  name: "Vendor items",
  area: "purchasing",
  record: "vendor_item",
  source: { kind: "table" },
  input: [
    { name: "vendorId", type: "record", record: "vendor", required: true },
    { name: "sku", type: "text", required: true },
  ],
  keys: [{ id: "sku", name: "SKU", field: "sku" }],
  types: ["exact"],
});

describe("match profiles", () => {
  it("allow exact match only when there is no text to read by meaning", () => {
    expect(() => MatchProfile.parse({ ...vendorItems, types: ["exact", "hybrid"] })).toThrow(
      /exact match only/,
    );
  });

  it("refuse a key that reads no input field", () => {
    expect(() =>
      MatchProfile.parse({ ...vendorItems, keys: [{ id: "upc", name: "UPC", field: "upc" }] }),
    ).toThrow(/every key reads/);
  });

  it("give every profile the same Match result, linking its own kind of record", () => {
    const fields = matchResultFields(vendorItems);
    const items = fields.find((f) => f.name === "items");
    expect(items?.of?.find((f) => f.name === "matched")).toMatchObject({
      type: "record",
      record: "vendor_item",
    });
    expect(fields.map((f) => f.name)).toEqual(["items", "matched", "unsure", "anyUnsure"]);
  });

  it("hold a step's settings to the profile", () => {
    const settings = MatchSettings.parse({
      to: "vendor-items",
      type: "semantic",
      keys: ["sku", "name"],
      confidenceThreshold: 80,
      secondOpinion: { from: 85 },
    });
    expect(matchSettingsProblems(settings, vendorItems)).toEqual([
      "Vendor items can be matched by exact only",
      'Vendor items has no key "name"',
      "the second opinion starts below the confidence threshold",
    ]);
  });

  it("are checked by the validator when it knows them", () => {
    const w = Workflow.parse({
      schemaVersion: 5,
      triggers: [{ id: "t", on: { type: "manual", input: { type: "object", properties: {} } } }],
      outputs: [{ id: "o", name: "Done", kind: "nothing" }],
      steps: [
        {
          id: "m",
          kind: "do",
          name: "Match lines",
          doneBy: "rules",
          uses: { type: "match", match: { to: "vendor-items", type: "hybrid" } },
        },
        {
          id: "n",
          kind: "do",
          name: "Match clients",
          doneBy: "rules",
          uses: { type: "match", match: { to: "clients", type: "exact" } },
        },
        { id: "e", kind: "end", name: "End", outputs: ["o"] },
      ],
    });
    const issues = validateWorkflow(w, {
      profile: (id) => (id === "vendor-items" ? vendorItems : undefined),
    });
    expect(issues.map((i) => [i.at, i.code])).toEqual([
      ["m", "match_settings"],
      ["n", "unknown_profile"],
    ]);
  });

  // Staging, 2026-11-28: a SKU match on an invoice's lines read "nothing gives sku": a Match given
  // a list matches each item, so the profile's fields are the items' (or given beside the list).
  it("asks for the profile's fields one by one, but not beside a list of items", () => {
    const step = (input: Record<string, string>) =>
      Workflow.parse({
        schemaVersion: 5,
        triggers: [{ id: "t", on: { type: "manual", input: { type: "object", properties: {} } } }],
        outputs: [{ id: "o", name: "Done", kind: "nothing" }],
        steps: [
          {
            id: "m",
            kind: "do",
            name: "Match lines",
            doneBy: "rules",
            uses: { type: "match", match: { to: "vendor-items", type: "exact", keys: ["sku"] } },
            input,
          },
          { id: "e", kind: "end", name: "End", outputs: ["o"] },
        ],
      });
    const ctx = {
      profile: (id: string) => (id === "vendor-items" ? vendorItems : undefined),
      requiredInput: () => ["vendorId", "sku"],
    };
    const missing = (input: Record<string, string>) =>
      validateWorkflow(step(input), ctx)
        .filter((i) => i.code === "input_missing")
        .map((i) => i.message);
    expect(missing({ vendorId: "{{trigger.vendorId}}" })).toEqual([
      'Doesn\'t fit: nothing gives "sku", which this step needs.',
    ]);
    expect(missing({ items: "{{trigger.lines}}", vendorId: "{{trigger.vendorId}}" })).toEqual([]);
  });
});
