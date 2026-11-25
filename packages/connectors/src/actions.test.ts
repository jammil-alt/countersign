// Which of a connector's actions are on (docs/step-model-plan.md §10c): the operator's switch, else the
// manifest's `offByDefault`. An action that is off is refused where a connector's tool is invoked, with
// the connection's own matrix still deciding the rest, and never widens what the matrix allows.
import { DEFAULT_PERMISSIONS } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { actionIsOn, actionsOff } from "./actions";
import { BUILTIN_CONNECTORS, builtInConnectorOf, WEB_CONNECTOR } from "./builtin";
import type { ConnectionRef, ToolContext } from "./connector";
import { memoryCredentials } from "./credentials-accessor";
import { captureBefore, runReadTool, ToolCallError } from "./invoke";
import { memoryLogger } from "./logger";
import {
  createTestkitConnector,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
  TestkitBackend,
} from "./testkit/index";

const tenant = "0190f0c8-0000-7000-8000-000000000001";

function ctxWith(switches: ConnectionRef["actionSwitches"]): ToolContext {
  const connection: ConnectionRef = {
    id: "conn-a",
    tenantId: tenant,
    connector: "testkit",
    status: "connected",
    externalAccountId: null,
    config: {},
    permissions: { ...DEFAULT_PERMISSIONS, update: "auto" },
    ...(switches === undefined ? {} : { actionSwitches: switches }),
  };
  return {
    tenantId: tenant,
    connection,
    credentials: memoryCredentials(),
    logger: memoryLogger(),
    now: () => new Date("2026-11-25T12:00:00Z"),
  };
}

const manifest = (offByDefault?: string[]) => ({
  ...(offByDefault ? { offByDefault } : {}),
  tools: [{ id: "a.read" }, { id: "a.write" }, { id: "a.new" }],
});

describe("actionIsOn", () => {
  it("has every action on when nothing was ever switched", () => {
    for (const none of [undefined, null, {}]) {
      expect(actionIsOn(manifest(), "a.read", none)).toBe(true);
    }
  });

  it("follows the operator's choice, either way", () => {
    expect(actionIsOn(manifest(), "a.write", { "a.write": false })).toBe(false);
    expect(actionIsOn(manifest(["a.new"]), "a.new", { "a.new": true })).toBe(true);
  });

  it("starts a new action off until the operator turns it on", () => {
    const m = manifest(["a.new"]);
    expect(actionIsOn(m, "a.new", null)).toBe(false);
    // Another action's switch doesn't turn it on.
    expect(actionIsOn(m, "a.new", { "a.write": true })).toBe(false);
    expect([...actionsOff(m, { "a.write": false })].sort()).toEqual(["a.new", "a.write"]);
  });
});

describe("a tool whose action is off", () => {
  const backend = new TestkitBackend().seed("conn-a", [
    { id: "r1", name: "Order", amount: "1.0000" },
  ]);
  const connector = createTestkitConnector(backend);

  it("runs when it is on", async () => {
    const r = await runReadTool(connector, TESTKIT_QUERY_TOOL, { query: "Order" }, ctxWith({}));
    expect(r.output).toBeTruthy();
  });

  it("is refused as action_off, a read and a write alike, before any handler runs", async () => {
    const off = { [TESTKIT_QUERY_TOOL]: false, [TESTKIT_UPDATE_TOOL]: false };
    const read = await runReadTool(
      connector,
      TESTKIT_QUERY_TOOL,
      { query: "Order" },
      ctxWith(off),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(read).toBeInstanceOf(ToolCallError);
    expect((read as ToolCallError).code).toBe("action_off");
    const write = await captureBefore(
      connector,
      TESTKIT_UPDATE_TOOL,
      { id: "r1", name: "Changed" },
      ctxWith(off),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect((write as ToolCallError).code).toBe("action_off");
  });

  it("leaves the matrix in charge when it is on: an action never widens a connection", async () => {
    const stillOff = { ...ctxWith({}) };
    stillOff.connection = {
      ...stillOff.connection,
      permissions: { ...DEFAULT_PERMISSIONS, update: "off" },
    };
    const e = await captureBefore(
      connector,
      TESTKIT_UPDATE_TOOL,
      { id: "r1", name: "Changed" },
      stillOff,
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect((e as ToolCallError).code).toBe("permission_off");
  });
});

describe("built-in connectors", () => {
  it("makes Web's two actions one connector, found by either action", () => {
    expect(BUILTIN_CONNECTORS.map((c) => c.id)).toEqual(["web"]);
    expect(builtInConnectorOf("web.search")).toBe(WEB_CONNECTOR);
    expect(builtInConnectorOf("web.fetch")).toBe(WEB_CONNECTOR);
    expect(builtInConnectorOf("qbo.bill.create")).toBeUndefined();
  });
});
