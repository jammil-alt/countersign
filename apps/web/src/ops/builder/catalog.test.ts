// The server's checks in the browser: a bundle is validated as the server's publish validates it
// (core's whole-bundle `validateBundle`, with the catalog's tools, skills and events), and a merged
// bundle is checked whole.
import { AgentBundle, type AgentBundleInput, type BuilderCatalog } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { validateMerged } from "../merge/MergeScreen";
import { toolConnector, toolFeed, typingContext, validateProcessesLikeServer } from "./catalog";

const CATALOG: BuilderCatalog = {
  skills: [],
  tools: [
    {
      id: "testkit.record.update",
      description: "Updates a record",
      input: { type: "object", properties: { id: { type: "string" } } },
      output: { type: "object" },
      sideEffect: "external",
      verb: "update",
      source: "testkit",
      connector: "testkit",
    },
  ],
  connectors: [{ id: "testkit", name: "Testkit", icon: null }],
  automations: [],
};
const ctx = typingContext({ catalog: CATALOG, events: [] });

const END = { id: "end", kind: "end", name: "End", outputs: ["out"], status: "succeeded" };
const OUT = { id: "out", name: "Nothing to do", kind: "nothing", fields: [] };

function bundle(
  more: AgentBundleInput["workflows"] = [],
  skills: { skill: string }[] = [],
): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Clerk", role: "Bills", mission: "Keep bills right" },
      kind: "functional",
      model: { id: "claude-opus-5-5" },
      instructions: "Work.",
      skills,
      extraTools: ["testkit.record.update"],
      permissions: { mode: "act" },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 5,
          triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
          outputs: [OUT],
          steps: [END],
        },
      },
      ...more,
    ],
  });
}

describe("validateProcessesLikeServer", () => {
  it("passes a finished bundle, and refuses an agent skill the catalog can't resolve", () => {
    expect(validateProcessesLikeServer(bundle(), ctx, { clientAgent: true }).valid).toBe(true);
    const missing = validateProcessesLikeServer(bundle([], [{ skill: "docs.nope" }]), ctx, {
      clientAgent: true,
    });
    expect(missing.valid).toBe(false);
    expect(missing.errors.map((e) => e.code)).toContain("unknown_skill");
  });
});

describe("validateMerged", () => {
  it("checks the merged bundle whole, as the server does: ids across workflows", () => {
    const second = {
      slug: "other",
      name: "Other",
      workflow: {
        schemaVersion: 5 as const,
        // The same trigger id as the first workflow's: refused across the bundle.
        triggers: [{ id: "t1", on: { type: "manual" as const, input: { type: "object" } } }],
        outputs: [{ ...OUT, id: "out2" }],
        steps: [{ ...END, id: "end2", outputs: ["out2"] }],
      },
    };
    const merged = bundle([second] as unknown as AgentBundleInput["workflows"]);
    expect(validateMerged(merged, ctx, true).errors.map((e) => e.code)).toContain("duplicate_id");
    expect(validateMerged(bundle(), ctx, false).valid).toBe(true);
  });
});

// docs/plan.md §1.221: a pack's import of bank transactions reads what the bank feed saved. It has
// no connection of its own, but its step carries the feed's mark (Plaid's).
describe("toolFeed", () => {
  const tool = {
    id: "bookkeeping.transactions.import",
    description: "Reads new bank and card transactions",
    input: { type: "object" },
    output: { type: "object" },
    sideEffect: "internal" as const,
    verb: "create" as const,
    source: "bookkeeping",
  };
  const data = (feed?: string) => ({
    catalog: {
      ...CATALOG,
      tools: [...CATALOG.tools, feed ? { ...tool, feed } : tool],
      connectors: [...CATALOG.connectors, { id: "bankfeed", name: "Bank feed", icon: null }],
    },
    events: [],
  });

  it("names the connector a tool's feed is, and gives it no connector of its own", () => {
    expect(toolFeed(tool.id, data("bankfeed"))).toBe("bankfeed");
    expect(toolConnector(tool.id, data("bankfeed"))).toBeNull();
  });

  it("is null for a tool with no feed, a feed the catalog doesn't know, and an unknown tool", () => {
    expect(toolFeed(tool.id, data())).toBeNull();
    expect(toolFeed(tool.id, data("plaid_elsewhere"))).toBeNull();
    expect(toolFeed("testkit.record.update", data("bankfeed"))).toBeNull();
    expect(toolFeed("nope", data("bankfeed"))).toBeNull();
  });
});
