// An agent's own view: registered views by template first, then by pack; none means the default
// (the client's pack reports, then the activity report).
import { describe, expect, it } from "vitest";
import type { PackReport } from "../packs/registry";
import { type AgentView, defaultReports, viewsFor } from "./views";

const Nothing = () => null;
const byTemplate: AgentView = { key: { template: "bill-clerk" }, Component: Nothing };
const byPack: AgentView = { key: { pack: "materials" }, Component: Nothing };
const other: AgentView = { key: { template: "pia" }, Component: Nothing };

describe("an agent's own view", () => {
  it("takes the views of its template before those of its client's packs", () => {
    const registry = [byPack, byTemplate, other];
    expect(viewsFor({ template: "bill-clerk", packs: ["materials"] }, registry)).toEqual([
      byTemplate,
    ]);
    expect(viewsFor({ template: "records-clerk", packs: ["materials"] }, registry)).toEqual([
      byPack,
    ]);
    expect(viewsFor({ template: null, packs: [] }, registry)).toEqual([]);
    // An answer from before the route named the template still finds the pack's view.
    expect(viewsFor({ packs: ["materials"] }, registry)).toEqual([byPack]);
  });

  it("has none registered yet, so every agent shows the default", () => {
    expect(viewsFor({ template: "bill-clerk", packs: ["materials"] })).toEqual([]);
    const prices: PackReport = {
      pack: "materials",
      slug: "prices",
      title: "Price watch",
      description: "Prices by vendor",
      Component: Nothing,
    };
    expect(defaultReports({ packs: [] })).toEqual([]);
    expect(defaultReports({ packs: ["materials"] }).includes(prices)).toBe(false);
  });
});
