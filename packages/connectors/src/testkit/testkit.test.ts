import { ConnectorManifest, DEFAULT_PERMISSIONS, validateWorkflow } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConnectionRef, ToolContext } from "../connector";
import { ConnectorDefinitionError, defineConnector, defineReadTool } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite, runReadTool, ToolCallError } from "../invoke";
import { memoryLogger } from "../logger";
import { ConnectorRegistry, UnknownToolError } from "../registry";
import {
  createTestkitConnector,
  StaleRecordError,
  TESTKIT_QUERY_TOOL,
  TESTKIT_SAMPLE_RECORDS,
  TESTKIT_UPDATE_TOOL,
  TestkitBackend,
} from "./index";

const tenantA = "0190f0c8-0000-7000-8000-000000000001";
const tenantB = "0190f0c8-0000-7000-8000-000000000002";

function connection(over: Partial<ConnectionRef> = {}): ConnectionRef {
  return {
    id: "conn-a",
    tenantId: tenantA,
    connector: "testkit",
    status: "connected",
    externalAccountId: null,
    config: {},
    permissions: DEFAULT_PERMISSIONS,
    ...over,
  };
}

function ctx(over: Partial<ConnectionRef> = {}) {
  const logger = memoryLogger();
  const c = connection(over);
  const context: ToolContext = {
    tenantId: c.tenantId,
    connection: c,
    credentials: memoryCredentials(),
    logger,
    now: () => new Date("2026-11-03T12:00:00Z"),
  };
  return { context, logger };
}

function setup() {
  const backend = new TestkitBackend()
    .seed("conn-a", [
      { id: "r1", name: "Plywood order", amount: "120.0000" },
      { id: "r2", name: "Hinges", amount: "14.5000" },
    ])
    .seed("conn-b", [{ id: "r1", name: "Other client's record", amount: "1.0000" }]);
  return { backend, connector: createTestkitConnector(backend) };
}

async function failure(p: Promise<unknown>): Promise<ToolCallError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ToolCallError);
  return e as ToolCallError;
}

describe("testkit manifest", () => {
  it("is a valid connector manifest with one read and one external update", () => {
    const { connector } = setup();
    const m = ConnectorManifest.parse(connector.manifest);
    expect(m.tools.map((t) => [t.id, t.sideEffect, t.verb, t.connector])).toEqual([
      [TESTKIT_QUERY_TOOL, "none", "read", undefined],
      [TESTKIT_UPDATE_TOOL, "external", "update", "testkit"],
    ]);
    expect(m.tools[0]?.input).toMatchObject({ type: "object" });
  });

  it("plugs into workflow validation as an action", () => {
    const { connector } = setup();
    const tools = Object.fromEntries(connector.manifest.tools.map((t) => [t.id, t]));
    const workflow = {
      schemaVersion: 3,
      trigger: { id: "t", on: { type: "manual", input: { type: "object" } } },
      steps: [
        {
          id: "s1",
          name: "Rename",
          kind: "action",
          tool: TESTKIT_UPDATE_TOOL,
          input: { id: "r1", name: "Renamed" },
        },
      ],
    };
    const r = validateWorkflow(workflow, { tools });
    expect(r.errors).toEqual([]);
  });
});

describe("read tool", () => {
  it("queries only this connection's records and renders its summary", async () => {
    const { connector } = setup();
    const r = await runReadTool(
      connector,
      TESTKIT_QUERY_TOOL,
      { nameContains: "ply" },
      ctx().context,
    );
    expect(r.output).toEqual({
      records: [{ id: "r1", name: "Plywood order", amount: "120.0000", syncToken: "0" }],
    });
    expect(r.summary).toBe("Found 1 records");
    const other = await runReadTool(
      connector,
      TESTKIT_QUERY_TOOL,
      {},
      ctx({ id: "conn-b", tenantId: tenantB }).context,
    );
    expect(other.output).toMatchObject({ records: [{ name: "Other client's record" }] });
  });

  it("validates input", async () => {
    const { connector } = setup();
    const e = await failure(
      runReadTool(connector, TESTKIT_QUERY_TOOL, { ids: "r1" }, ctx().context),
    );
    expect(e.code).toBe("invalid_input");
    expect(e.issues?.length).toBeGreaterThan(0);
  });

  it("refuses when the connection's read is off, or the connection isn't this client's", async () => {
    const { connector } = setup();
    expect(
      (
        await failure(
          runReadTool(
            connector,
            TESTKIT_QUERY_TOOL,
            {},
            ctx({ permissions: { read: "off" } }).context,
          ),
        )
      ).code,
    ).toBe("permission_off");
    const { context } = ctx();
    const crossed = { ...context, tenantId: tenantB };
    expect((await failure(runReadTool(connector, TESTKIT_QUERY_TOOL, {}, crossed))).code).toBe(
      "wrong_connection",
    );
    expect(
      (
        await failure(
          runReadTool(connector, TESTKIT_QUERY_TOOL, {}, ctx({ connector: "qbo" }).context),
        )
      ).code,
    ).toBe("wrong_connection");
  });

  it("is not callable as a write", async () => {
    const { connector } = setup();
    const e = await failure(
      executeWrite(connector, TESTKIT_QUERY_TOOL, {}, { ...ctx().context, idempotencyKey: "k" }),
    );
    expect(e.code).toBe("not_a_write");
  });
});

describe("write tool", () => {
  it("captures the before state without writing", async () => {
    const { connector, backend } = setup();
    const r = await captureBefore(
      connector,
      TESTKIT_UPDATE_TOOL,
      { id: "r1", amount: "130.0000" },
      ctx().context,
    );
    expect(r.before).toEqual({
      id: "r1",
      name: "Plywood order",
      amount: "120.0000",
      syncToken: "0",
    });
    expect(backend.writes).toEqual([]);
  });

  it("executes once per idempotency key with its before state", async () => {
    const { connector, backend } = setup();
    const { context, logger } = ctx();
    const w = { ...context, idempotencyKey: "run-1:s1:0" };
    const first = await executeWrite(
      connector,
      TESTKIT_UPDATE_TOOL,
      { id: "r1", amount: "130.0000", syncToken: "0" },
      w,
    );
    expect(first.before).toMatchObject({ amount: "120.0000", syncToken: "0" });
    expect(first.output).toEqual({
      record: { id: "r1", name: "Plywood order", amount: "130.0000", syncToken: "1" },
    });
    expect(first.summary).toBe("Updated record r1");
    expect(logger.entries).toContainEqual({
      level: "info",
      message: "updating record",
      fields: {
        connector: "testkit",
        connectionId: "conn-a",
        tool: TESTKIT_UPDATE_TOOL,
        recordId: "r1",
      },
    });

    const retry = await executeWrite(
      connector,
      TESTKIT_UPDATE_TOOL,
      { id: "r1", amount: "130.0000" },
      w,
    );
    expect(retry.output).toEqual(first.output);
    expect(backend.writes).toHaveLength(1);
  });

  it("fails cleanly on a stale sync token", async () => {
    const { connector, backend } = setup();
    backend.update("conn-a", "someone-else", { id: "r2", name: "Hinges (brass)" });
    await expect(
      executeWrite(
        connector,
        TESTKIT_UPDATE_TOOL,
        { id: "r2", amount: "15.0000", syncToken: "0" },
        { ...ctx().context, idempotencyKey: "k2" },
      ),
    ).rejects.toBeInstanceOf(StaleRecordError);
    expect(backend.get("conn-a", "r2")?.amount).toBe("14.5000");
  });

  it("refuses when update is off on the connection (a client tightened it)", async () => {
    const { connector, backend } = setup();
    const e = await failure(
      executeWrite(
        connector,
        TESTKIT_UPDATE_TOOL,
        { id: "r1", name: "x" },
        {
          ...ctx({ permissions: { ...DEFAULT_PERMISSIONS, update: "off" } }).context,
          idempotencyKey: "k",
        },
      ),
    );
    expect(e.code).toBe("permission_off");
    expect(backend.writes).toEqual([]);
  });

  it("validates input (money as decimal strings, at least one change)", async () => {
    const { connector } = setup();
    const w = { ...ctx().context, idempotencyKey: "k" };
    expect(
      (await failure(executeWrite(connector, TESTKIT_UPDATE_TOOL, { id: "r1", amount: 12.5 }, w)))
        .code,
    ).toBe("invalid_input");
    expect(
      (await failure(executeWrite(connector, TESTKIT_UPDATE_TOOL, { id: "r1" }, w))).code,
    ).toBe("invalid_input");
  });
});

describe("sync", () => {
  it("yields raw records with their versions", async () => {
    const { connector } = setup();
    const out = [];
    for await (const r of connector.sync?.(ctx().context, {}) ?? []) out.push(r);
    expect(out.map((r) => [r.entityType, r.externalId, r.externalVersion])).toEqual([
      ["Record", "r1", "0"],
      ["Record", "r2", "0"],
    ]);
  });
});

describe("defineConnector and the registry", () => {
  const read = (id: string) =>
    defineReadTool({
      id,
      description: "x",
      input: z.object({}),
      output: z.object({ n: z.number() }),
      async run() {
        return { n: 1 };
      },
    });

  it("refuses tools outside the connector's namespace and looser defaults", () => {
    expect(() =>
      defineConnector({
        id: "acme",
        name: "Acme",
        description: "",
        icon: "x",
        auth: "none",
        entities: [],
        tools: [read("other.thing.query")],
      }),
    ).toThrow(ConnectorDefinitionError);
    expect(() =>
      defineConnector({
        id: "acme",
        name: "Acme",
        description: "",
        icon: "x",
        auth: "none",
        entities: [],
        tools: [],
        defaultPermissions: { ...DEFAULT_PERMISSIONS, create: "auto" },
      }),
    ).toThrow(/create is auto/);
    expect(() =>
      defineConnector({
        id: "acme",
        name: "Acme",
        description: "",
        icon: "x",
        auth: "oauth2",
        entities: [],
        tools: [],
      }),
    ).toThrow(/authorize and handleCallback/);
  });

  it("validates handler output", async () => {
    const acme = defineConnector({
      id: "acme",
      name: "Acme",
      description: "",
      icon: "x",
      auth: "none",
      entities: [],
      tools: [
        defineReadTool({
          id: "acme.thing.query",
          description: "x",
          input: z.object({}),
          output: z.object({ n: z.number() }),
          // A buggy handler: the framework must catch it.
          run: async () => ({ n: "one" }) as unknown as { n: number },
        }),
      ],
    });
    const e = await failure(
      runReadTool(acme, "acme.thing.query", {}, ctx({ connector: "acme" }).context),
    );
    expect(e.code).toBe("invalid_output");
  });

  it("registers by id, indexes tools and refuses duplicates", () => {
    const registry = new ConnectorRegistry([createTestkitConnector()]);
    expect(registry.has("testkit")).toBe(true);
    expect(registry.manifests().map((m) => m.id)).toEqual(["testkit"]);
    expect(registry.toolSpecs().map((t) => t.id)).toEqual([
      TESTKIT_QUERY_TOOL,
      TESTKIT_UPDATE_TOOL,
    ]);
    expect(registry.findTool(TESTKIT_UPDATE_TOOL)?.handler.kind).toBe("write");
    expect(registry.findTool("qbo.bill.query")).toBeUndefined();
    expect(() => registry.requireTool("qbo.bill.query")).toThrow(UnknownToolError);
    expect(() => registry.require("qbo")).toThrow(/unknown connector/);
    expect(() => registry.register(createTestkitConnector())).toThrow(/already registered/);
  });

  it("refuses a connector whose handlers and manifest disagree", () => {
    const c = createTestkitConnector();
    const broken = { ...c, tools: { [TESTKIT_QUERY_TOOL]: c.tools[TESTKIT_QUERY_TOOL] } };
    expect(() => new ConnectorRegistry([broken as typeof c])).toThrow(/has no handler/);
  });
});

describe("connection status", () => {
  it("refuses a disconnected or failing connection", async () => {
    const { connector } = setup();
    for (const status of ["disconnected", "error"] as const) {
      const e = await failure(
        runReadTool(connector, TESTKIT_QUERY_TOOL, {}, ctx({ status }).context),
      );
      expect(e.code).toBe("not_connected");
    }
    // No sign-in step for auth 'none', so a pending connection works.
    const ok = await runReadTool(
      connector,
      TESTKIT_QUERY_TOOL,
      {},
      ctx({ status: "pending" }).context,
    );
    expect(ok.output).toMatchObject({ records: [{ id: "r1" }, { id: "r2" }] });
  });
});

describe("sample records", () => {
  it("start every connection with its own copy, so one connection's writes stay its own", () => {
    const backend = new TestkitBackend({ samples: TESTKIT_SAMPLE_RECORDS });
    expect(backend.query("conn-a", {}).map((r) => r.id)).toEqual(["R-1001", "R-1002", "R-1003"]);
    backend.update("conn-a", "key-1", { id: "R-1001", amount: "70.0000" });
    expect(backend.get("conn-a", "R-1001")).toMatchObject({ amount: "70.0000", syncToken: "1" });
    expect(backend.get("conn-b", "R-1001")).toMatchObject({ amount: "64.0000", syncToken: "0" });
    expect(new TestkitBackend().query("conn-a", {})).toEqual([]);
  });
});
