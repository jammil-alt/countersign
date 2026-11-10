// R5 (docs/plan.md §1.86, §9): taking a done write back, with no database. The write and its undo
// go through the external-action path (executeAction) over an in-memory store; the testkit's
// update is a restore, and a small connector here has a create reversed by its update (through a
// handler's `undoInput`) and a send that can't be taken back.

import {
  type ConnectionRef,
  ConnectorRegistry,
  createTestkitConnector,
  defineConnector,
  defineWriteTool,
  TESTKIT_UPDATE_TOOL,
  TestkitBackend,
} from "@countersign/connectors";
import type { JsonObject } from "@countersign/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { executeAction, restoreInput, type UndoInputHook, undoAction, undoKey } from "./actions";
import type { RuntimeDeps } from "./context";
import type { ExternalActionRecord, ExternalActionStore, ProposeUndoInput } from "./ports";

const T = "t1";
const PERSON = "u-rejecter";

// ── A connector with a reversed create and a final send ──────────────────────────────────────────

interface Flag {
  id: string;
  name: string;
  active: boolean;
}

function flagsConnector() {
  const flags = new Map<string, Flag>();
  const sent: string[] = [];
  let next = 1;
  const FlagShape = z.object({ id: z.string(), name: z.string(), active: z.boolean() });
  const connector = defineConnector({
    id: "flags",
    name: "Flags",
    description: "Flags for tests",
    icon: "flag",
    auth: "none",
    testOnly: true,
    entities: ["Flag"],
    tools: [
      defineWriteTool({
        id: "flags.flag.create",
        description: "Add a flag",
        verb: "create",
        undo: { kind: "reverse", tool: "flags.flag.update" },
        input: z.object({ name: z.string() }),
        output: z.object({ id: z.string() }),
        beforeSchema: FlagShape,
        async before(input) {
          return [...flags.values()].find((f) => f.name === input.name) ?? null;
        },
        async run(input) {
          const id = `f${next++}`;
          flags.set(id, { id, name: input.name, active: true });
          return { id };
        },
      }),
      defineWriteTool({
        id: "flags.flag.update",
        description: "Change a flag",
        verb: "update",
        undo: { kind: "restore" },
        input: z.object({ id: z.string(), active: z.boolean() }),
        output: z.object({ id: z.string() }),
        beforeSchema: FlagShape,
        async before(input) {
          return flags.get(input.id) ?? null;
        },
        async run(input) {
          const f = flags.get(input.id);
          if (!f) throw new Error("no flag");
          flags.set(f.id, { ...f, active: input.active });
          return { id: f.id };
        },
      }),
      defineWriteTool({
        id: "flags.note.send",
        description: "Send a note",
        verb: "create",
        undo: { kind: "none" },
        input: z.object({ text: z.string() }),
        output: z.object({ sent: z.boolean() }),
        beforeSchema: z.object({}),
        async before() {
          return null;
        },
        async run(input) {
          sent.push(input.text);
          return { sent: true };
        },
      }),
    ],
  });
  // R5: the create says how it is taken back: its update makes the new flag inactive.
  const hook: UndoInputHook = ({ output }) => ({
    id: (output as { id: string }).id,
    active: false,
  });
  Object.assign(connector.tools["flags.flag.create"] as object, { undoInput: hook });
  return { connector, flags, sent };
}

// ── An in-memory external-action store ───────────────────────────────────────────────────────────

function memoryActions(options: { keepsAfter: boolean }) {
  const rows = new Map<string, ExternalActionRecord>();
  let n = 0;
  const put = (a: ExternalActionRecord) => {
    rows.set(a.id, a);
    return { ...a };
  };
  const store: ExternalActionStore = {
    keepsAfter: options.keepsAfter,
    async propose() {
      throw new Error("not used");
    },
    async get(_t, id) {
      const a = rows.get(id);
      return a ? { ...a } : null;
    },
    async byKey(_t, key) {
      const a = [...rows.values()].find((r) => r.idempotencyKey === key);
      return a ? { ...a } : null;
    },
    async claim(_t, id) {
      const a = rows.get(id);
      if (!a) throw new Error("missing");
      if (a.status !== "approved") return { action: { ...a }, claimed: false };
      return { action: put({ ...a, status: "executing" }), claimed: true };
    },
    async complete(_t, id, result) {
      const a = rows.get(id);
      if (!a) throw new Error("missing");
      return put({
        ...a,
        status: "done",
        result: result.output,
        before: result.before,
        ...(options.keepsAfter ? { after: result.after ?? null } : {}),
      });
    },
    async fail(_t, id, error) {
      const a = rows.get(id);
      if (!a) throw new Error("missing");
      return put({ ...a, status: "failed", error });
    },
    async proposeUndo(_t, input: ProposeUndoInput) {
      const existing = [...rows.values()].find((r) => r.idempotencyKey === input.idempotencyKey);
      if (existing) return { action: { ...existing }, created: false };
      n += 1;
      const action = put({
        id: `undo${n}`,
        tenantId: T,
        connectionId: input.original.connectionId,
        tool: input.tool,
        runId: null,
        stepRunId: null,
        agentVersionId: null,
        input: input.input,
        idempotencyKey: input.idempotencyKey,
        status: "approved",
        inboxItemId: null,
        approvedBy: input.approvedBy,
        result: null,
        error: null,
        before: input.before,
      });
      return { action, created: true };
    },
  };
  /** A write the run went ahead with: approved by nobody (a deadline's `proceed`). */
  const seed = (
    a: Pick<ExternalActionRecord, "id" | "tool" | "input"> & Partial<ExternalActionRecord>,
  ) =>
    put({
      tenantId: T,
      connectionId: "c1",
      runId: "r1",
      stepRunId: "s1",
      agentVersionId: "v1",
      idempotencyKey: `r1:write:${a.id}`,
      status: "approved",
      inboxItemId: "i1",
      approvedBy: null,
      result: null,
      error: null,
      before: null,
      ...a,
    });
  return { store, rows, seed };
}

const conn = (connector: string, permissions = {}): ConnectionRef => ({
  id: "c1",
  tenantId: T,
  connector,
  status: "connected",
  externalAccountId: null,
  config: {},
  permissions: { read: "auto", create: "auto", update: "auto", delete: "off", ...permissions },
});

function depsFor(
  registry: ConnectorRegistry,
  connection: ConnectionRef,
  actions: ExternalActionStore,
  mode: "live" | "test" = "live",
): RuntimeDeps {
  return {
    tools: new ToolRegistry({ platform: PLATFORM_TOOLS, connectors: registry }),
    catalog: new SkillCatalog([]),
    transport: undefined as never,
    ports: {
      store: {
        connection: async () => connection,
        run: async () => ({ mode, agentId: "a1" }),
        grant: async () => null,
      },
      actions,
    },
  } as unknown as RuntimeDeps;
}

// ── Restore: the testkit's update ────────────────────────────────────────────────────────────────

describe("undoAction: restore", () => {
  let backend: TestkitBackend;
  let mem: ReturnType<typeof memoryActions>;
  let deps: RuntimeDeps;

  async function wrote(keepsAfter = true) {
    backend = new TestkitBackend().seed("c1", [{ id: "R1", name: "Oak", amount: "10.0000" }]);
    mem = memoryActions({ keepsAfter });
    deps = depsFor(
      new ConnectorRegistry([createTestkitConnector(backend)]),
      conn("testkit"),
      mem.store,
    );
    mem.seed({
      id: "a1",
      tool: TESTKIT_UPDATE_TOOL,
      input: { id: "R1", amount: "12.0000", syncToken: "0" },
    });
    const out = await executeAction(deps, { tenantId: T, actionId: "a1" });
    expect(out.status).toBe("done");
  }

  beforeEach(() => wrote());

  it("keeps the record as the write left it", () => {
    expect(mem.rows.get("a1")?.after).toMatchObject({
      id: "R1",
      amount: "12.0000",
      syncToken: "1",
    });
  });

  it("puts the before state back as a write of its own, approved by the person who pressed", async () => {
    const out = await undoAction(deps, { tenantId: T, actionId: "a1", by: PERSON });
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(backend.get("c1", "R1")).toMatchObject({ amount: "10.0000", syncToken: "2" });
    expect(out.undo).toMatchObject({
      tool: TESTKIT_UPDATE_TOOL,
      idempotencyKey: undoKey("a1"),
      approvedBy: PERSON,
      runId: null,
      status: "done",
      // Restored against the record as it is now: the latest version, not the one first read.
      input: { id: "R1", amount: "10.0000", syncToken: "1" },
    });
    // Its own before state: what the undo replaced.
    expect(out.undo.before).toMatchObject({ amount: "12.0000", syncToken: "1" });
    // The original is never rewritten.
    expect(mem.rows.get("a1")).toMatchObject({
      status: "done",
      result: { record: { amount: "12.0000" } },
    });
  });

  it("never writes twice: a second press reports the first undo", async () => {
    await undoAction(deps, { tenantId: T, actionId: "a1", by: PERSON });
    const writes = backend.writes.length;
    const again = await undoAction(deps, { tenantId: T, actionId: "a1", by: "someone-else" });
    expect(again.status).toBe("done");
    expect(backend.writes.length).toBe(writes);
    expect([...mem.rows.values()].filter((r) => r.idempotencyKey === undoKey("a1"))).toHaveLength(
      1,
    );
  });

  it("refuses, with a plain reason, when someone changed the record since our write", async () => {
    backend.update("c1", "someone", { id: "R1", name: "Oak, planed" });
    const out = await undoAction(deps, { tenantId: T, actionId: "a1", by: PERSON });
    expect(out).toMatchObject({ status: "refused", code: "changed_since" });
    expect(out.status === "refused" && out.reason).toMatch(/someone else's work/);
    expect(await mem.store.byKey(T, undoKey("a1"))).toBeNull();
    expect(backend.get("c1", "R1")?.amount).toBe("12.0000");
  });

  it("refuses when the record already holds what was there before", async () => {
    backend.update("c1", "someone", { id: "R1", amount: "10.0000" });
    const out = await undoAction(deps, { tenantId: T, actionId: "a1", by: PERSON });
    // Changed since our write first: that is what the person is told.
    expect(out).toMatchObject({ status: "refused", code: "changed_since" });
  });

  it("refuses when the store didn't keep the after state", async () => {
    await wrote(false);
    expect(mem.rows.get("a1")?.after).toBeUndefined();
    const out = await undoAction(deps, { tenantId: T, actionId: "a1", by: PERSON });
    expect(out).toMatchObject({ status: "refused", code: "after_unknown" });
  });

  it("refuses a write that didn't go through", async () => {
    mem.seed({
      id: "a2",
      tool: TESTKIT_UPDATE_TOOL,
      input: { id: "R1", amount: "1.0000" },
      status: "proposed",
    });
    expect(await undoAction(deps, { tenantId: T, actionId: "a2", by: PERSON })).toMatchObject({
      status: "refused",
      code: "not_done",
    });
  });

  it("never writes for a test run", async () => {
    const test = depsFor(
      new ConnectorRegistry([createTestkitConnector(backend)]),
      conn("testkit"),
      mem.store,
      "test",
    );
    const writes = backend.writes.length;
    expect(await undoAction(test, { tenantId: T, actionId: "a1", by: PERSON })).toMatchObject({
      status: "refused",
      code: "test_run",
    });
    expect(backend.writes.length).toBe(writes);
  });

  it("asks the gate again: an update that is off on the connection refuses", async () => {
    const off = depsFor(
      new ConnectorRegistry([createTestkitConnector(backend)]),
      conn("testkit", { update: "off" }),
      mem.store,
    );
    const out = await undoAction(off, { tenantId: T, actionId: "a1", by: PERSON });
    expect(out).toMatchObject({ status: "refused", code: "refused" });
    expect(backend.get("c1", "R1")?.amount).toBe("12.0000");
  });

  it("asks the gate again: the agent's grant without the tool refuses", async () => {
    const narrowed = depsFor(
      new ConnectorRegistry([createTestkitConnector(backend)]),
      conn("testkit"),
      mem.store,
    );
    (narrowed.ports.store as { grant: unknown }).grant = async () => ({ tools: ["other.tool"] });
    const out = await undoAction(narrowed, { tenantId: T, actionId: "a1", by: PERSON });
    expect(out).toMatchObject({ status: "refused", code: "refused" });
    expect(await mem.store.byKey(T, undoKey("a1"))).toBeNull();
  });
});

// ── Reverse and none ─────────────────────────────────────────────────────────────────────────────

describe("undoAction: reverse and none", () => {
  it("reverses a create with the tool it names, from the handler's undo input", async () => {
    const f = flagsConnector();
    const mem = memoryActions({ keepsAfter: true });
    const deps = depsFor(new ConnectorRegistry([f.connector]), conn("flags"), mem.store);
    mem.seed({ id: "a1", tool: "flags.flag.create", input: { name: "Rush" } });
    expect((await executeAction(deps, { tenantId: T, actionId: "a1" })).status).toBe("done");
    const out = await undoAction(deps, { tenantId: T, actionId: "a1", by: PERSON });
    expect(out).toMatchObject({
      status: "done",
      undo: { tool: "flags.flag.update", input: { id: "f1", active: false } },
    });
    // Never deleted: made inactive.
    expect(f.flags.get("f1")).toEqual({ id: "f1", name: "Rush", active: false });
  });

  it("refuses a reverse whose handler doesn't say how", async () => {
    const f = flagsConnector();
    Object.assign(f.connector.tools["flags.flag.create"] as object, { undoInput: undefined });
    const mem = memoryActions({ keepsAfter: true });
    const deps = depsFor(new ConnectorRegistry([f.connector]), conn("flags"), mem.store);
    mem.seed({ id: "a1", tool: "flags.flag.create", input: { name: "Rush" } });
    await executeAction(deps, { tenantId: T, actionId: "a1" });
    expect(await undoAction(deps, { tenantId: T, actionId: "a1", by: PERSON })).toMatchObject({
      status: "refused",
      code: "no_undo_input",
    });
    expect(f.flags.get("f1")?.active).toBe(true);
  });

  it("refuses a write that can't be taken back, and never reads for it", async () => {
    const f = flagsConnector();
    const mem = memoryActions({ keepsAfter: true });
    const deps = depsFor(new ConnectorRegistry([f.connector]), conn("flags"), mem.store);
    mem.seed({ id: "a1", tool: "flags.note.send", input: { text: "hello" } });
    await executeAction(deps, { tenantId: T, actionId: "a1" });
    expect(mem.rows.get("a1")?.after ?? null).toBeNull();
    expect(await undoAction(deps, { tenantId: T, actionId: "a1", by: PERSON })).toMatchObject({
      status: "refused",
      code: "cannot_undo",
    });
    expect(f.sent).toEqual(["hello"]);
  });
});

describe("restoreInput", () => {
  const before = { id: "R1", amount: "10.0000", syncToken: "0" };
  const now = { id: "R1", amount: "12.0000", syncToken: "1" };

  it("puts back what the write set and takes ids and versions from now", () => {
    const input: JsonObject = { id: "R1", amount: "12.0000", syncToken: "0", note: "x" };
    expect(restoreInput(input, before, now)).toEqual({
      id: "R1",
      amount: "10.0000",
      syncToken: "1",
      note: "x",
    });
  });

  it("gives up on a value that is neither what was there nor what we wrote, or no change", () => {
    expect(restoreInput({ id: "R1", amount: "99.0000" }, before, now)).toBeNull();
    expect(restoreInput({ id: "R1" }, before, now)).toBeNull();
    expect(restoreInput({ id: "R1", amount: "12.0000" }, null, now)).toBeNull();
  });
});
