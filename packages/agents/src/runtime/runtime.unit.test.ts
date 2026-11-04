// Pieces of the runtime that need no database: registries, approver resolution, schema checks.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry, ToolRegistryError } from "../registry/tools";
import { inboxCreate, PLATFORM_TOOLS } from "../tools/platform";
import { defineInternalTool } from "../tools/types";
import { resolveApprover } from "./context";
import { checkAgainst, objectSchema } from "./json-schema";
import { toolName } from "./run-agent";

const connectors = () => new ConnectorRegistry([createTestkitConnector()]);

describe("tool registry", () => {
  it("holds platform, connector and pack tools", () => {
    const packTool = defineInternalTool({
      id: "demo.thing.find",
      description: "Find a thing",
      sideEffect: "none",
      source: "demo",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: async () => ({ ok: true }),
    });
    const tools = new ToolRegistry({
      platform: PLATFORM_TOOLS,
      connectors: connectors(),
      packs: [
        {
          manifest: { id: "demo", tools: [packTool.spec] },
          handlers: { [packTool.spec.id]: packTool },
        },
      ],
    });
    expect(Object.keys(tools.specs()).sort()).toEqual([
      "demo.thing.find",
      "docs.extract",
      "docs.find_support",
      "docs.get",
      "inbox.create",
      "knowledge.search",
      "memory.write",
      "testkit.record.query",
      "testkit.record.update",
      "threads.post",
    ]);
    expect(tools.get(TESTKIT_UPDATE_TOOL)?.kind).toBe("connector");
    expect(tools.get("memory.write")?.spec.sideEffect).toBe("internal");
  });

  it("refuses duplicates, pack tools without handlers and pack writes to client tools", () => {
    expect(() => new ToolRegistry({ platform: [...PLATFORM_TOOLS, ...PLATFORM_TOOLS] })).toThrow(
      ToolRegistryError,
    );
    const spec = { ...inboxCreate.spec, id: "demo.x.update", source: "demo" };
    expect(
      () =>
        new ToolRegistry({ packs: [{ manifest: { id: "demo", tools: [spec] }, handlers: {} }] }),
    ).toThrow(/no handler/);
    const external = {
      ...spec,
      sideEffect: "external" as const,
      verb: "update" as const,
      connector: "x",
    };
    expect(
      () =>
        new ToolRegistry({
          packs: [
            {
              manifest: { id: "demo", tools: [external] },
              handlers: { [external.id]: inboxCreate },
            },
          ],
        }),
    ).toThrow(/via connectors/);
  });
});

describe("skill catalog", () => {
  it("refuses built-ins whose tools are not registered", () => {
    const tools = new ToolRegistry({ platform: PLATFORM_TOOLS });
    expect(
      () =>
        new SkillCatalog(
          [
            {
              schemaVersion: 1,
              id: "demo.do",
              name: "Do",
              description: "",
              category: "demo",
              mode: "tool",
              handler: "demo.missing",
              tools: [],
              input: {},
              output: {},
              settings: [],
              requiresConnectors: [],
              requiresPacks: [],
              producesAlerts: false,
            },
          ],
          tools,
        ),
    ).toThrow(/unknown tool demo.missing/);
  });
});

describe("approvers", () => {
  it("takes the step's, then the agent's, then the client's, else the client admin", () => {
    const user = "01a1a29f-2195-7f01-b490-3e9a675c8770";
    expect(resolveApprover([undefined, "operator", "client_admin"])).toEqual({
      assigneeRole: "operator",
      assigneeUserId: null,
    });
    expect(resolveApprover([user, "operator"])).toEqual({
      assigneeRole: null,
      assigneeUserId: user,
    });
    expect(resolveApprover([null, undefined, "nonsense"])).toEqual({
      assigneeRole: "client_admin",
      assigneeUserId: null,
    });
  });
});

describe("schemas", () => {
  it("checks values against JSON Schema and builds object tool schemas", () => {
    const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
    expect(checkAgainst(schema, { n: 2 }).ok).toBe(true);
    expect(checkAgainst(schema, { n: "2" }).ok).toBe(false);
    expect(checkAgainst({}, "anything").ok).toBe(true);
    expect(objectSchema({ type: "string" })).toMatchObject({ type: "object" });
    expect(toolName("testkit.record.query")).toBe("testkit__record__query");
  });
});
