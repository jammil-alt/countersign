// Wave 5 review (docs/plan.md §1.86 "Forks (wave 5)"): how a failed write is recorded, which
// decides whether a step with `onError: continue` may go on past it (`actionWrote`). Only a
// failure known to have written nothing is `notWritten`: the handler never reached, or the
// provider's no (`NotWrittenError`). An answer that doesn't parse, or a write made but not
// recorded, is unconfirmed (the operator checks it); any other error after sending may have
// written. No database: an in-memory external-action store.

import {
  type ConnectionRef,
  ConnectorRegistry,
  defineConnector,
  defineWriteTool,
  NotWrittenError,
} from "@countersign/connectors";
import { actionWrote } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { executeAction } from "./actions";
import type { RuntimeDeps } from "./context";
import type { ExternalActionRecord, ExternalActionStore } from "./ports";

const T = "t1";

type Mode = "ok" | "refused" | "dropped" | "garbled" | "before";

function probeConnector(state: { mode: Mode; sent: number }) {
  return defineConnector({
    id: "probe",
    name: "Probe",
    description: "A write that fails as each test says",
    icon: "flag",
    auth: "none",
    testOnly: true,
    entities: ["Thing"],
    tools: [
      defineWriteTool({
        id: "probe.thing.update",
        description: "Change a thing",
        verb: "update",
        undo: { kind: "none" },
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string() }),
        beforeSchema: z.object({}),
        async before() {
          if (state.mode === "before") throw new Error("the thing couldn't be read");
          return null;
        },
        async run(input) {
          if (state.mode === "refused") throw new NotWrittenError("the thing is closed");
          state.sent += 1;
          if (state.mode === "dropped") throw new Error("socket hang up");
          if (state.mode === "garbled") return { nope: true } as never;
          return { id: input.id };
        },
      }),
    ],
  });
}

function memoryActions(failComplete: boolean) {
  const rows = new Map<string, ExternalActionRecord>();
  const reviews: string[] = [];
  const put = (a: ExternalActionRecord) => {
    rows.set(a.id, a);
    return { ...a };
  };
  const store = {
    keepsAfter: false,
    async get(_t: string, id: string) {
      const a = rows.get(id);
      return a ? { ...a } : null;
    },
    async claim(_t: string, id: string) {
      const a = rows.get(id);
      if (!a) throw new Error("missing");
      if (a.status !== "approved") return { action: { ...a }, claimed: false };
      return { action: put({ ...a, status: "executing" }), claimed: true };
    },
    async complete(_t: string, id: string, result: { output: unknown; before: unknown }) {
      if (failComplete) throw new Error("the database went away");
      const a = rows.get(id);
      if (!a) throw new Error("missing");
      return put({ ...a, status: "done", result: result.output, before: result.before });
    },
    async fail(
      _t: string,
      id: string,
      error: Record<string, unknown>,
      opts?: { inbox?: { title: string } },
    ) {
      const a = rows.get(id);
      if (!a) throw new Error("missing");
      if (opts?.inbox) reviews.push(opts.inbox.title);
      return put({ ...a, status: "failed", error: error as never });
    },
  } as unknown as ExternalActionStore;
  put({
    id: "a1",
    tenantId: T,
    connectionId: "c1",
    tool: "probe.thing.update",
    runId: "r1",
    stepRunId: "s1",
    agentVersionId: "v1",
    input: { id: "x1" },
    idempotencyKey: "r1:save:0",
    status: "approved",
    inboxItemId: null,
    approvedBy: "u1",
    result: null,
    error: null,
    before: null,
  } as ExternalActionRecord);
  return { store, rows, reviews };
}

const CONN: ConnectionRef = {
  id: "c1",
  tenantId: T,
  connector: "probe",
  status: "connected",
  externalAccountId: null,
  config: {},
  permissions: { read: "auto", create: "auto", update: "auto", delete: "off" },
};

async function attempt(mode: Mode, failComplete = false) {
  const state = { mode, sent: 0 };
  const mem = memoryActions(failComplete);
  const deps = {
    tools: new ToolRegistry({
      platform: PLATFORM_TOOLS,
      connectors: new ConnectorRegistry([probeConnector(state)]),
    }),
    catalog: new SkillCatalog([]),
    transport: undefined as never,
    ports: {
      store: {
        connection: async () => CONN,
        run: async () => ({ mode: "live", agentId: "a1" }),
        grant: async () => null,
      },
      actions: mem.store,
    },
  } as unknown as RuntimeDeps;
  const out = await executeAction(deps, { tenantId: T, actionId: "a1" });
  const action = mem.rows.get("a1");
  if (!action) throw new Error("no action");
  return { out, action, state, reviews: mem.reviews, wrote: actionWrote(action) };
}

describe("a failed write says whether it wrote", () => {
  it("a write that worked is done", async () => {
    const r = await attempt("ok");
    expect([r.out.status, r.action.status, r.wrote]).toEqual(["done", "done", true]);
  });

  it("the provider's no (NotWrittenError) wrote nothing", async () => {
    const r = await attempt("refused");
    expect(r.action.status).toBe("failed");
    expect(r.action.error).toMatchObject({ notWritten: true });
    expect(r.wrote).toBe(false);
    expect(r.reviews).toEqual([]);
  });

  it("a failure before the handler (its before read) wrote nothing", async () => {
    const r = await attempt("before");
    expect(r.state.sent).toBe(0);
    expect(r.action.error).toMatchObject({ notWritten: true });
    expect(r.wrote).toBe(false);
  });

  it("an error after sending may have written: never marked notWritten", async () => {
    const r = await attempt("dropped");
    expect(r.state.sent).toBe(1);
    expect(r.action.status).toBe("failed");
    expect(r.action.error).not.toHaveProperty("notWritten");
    expect(r.wrote).toBe(true);
  });

  it("an answer that doesn't parse is unconfirmed, with a review for the operator", async () => {
    const r = await attempt("garbled");
    expect(r.action.status).toBe("failed");
    expect(r.action.error).toMatchObject({ unconfirmed: true });
    expect(r.reviews).toEqual(["The change through probe.thing.update may have been made"]);
    expect(r.out.status === "failed" && r.out.error).toMatch(/check before trying again/);
    expect(r.wrote).toBe(true);
  });

  it("a write made but not recorded is unconfirmed, never failed as if nothing happened", async () => {
    const r = await attempt("ok", true);
    expect(r.state.sent).toBe(1);
    expect(r.action.status).toBe("failed");
    expect(r.action.error).toMatchObject({ unconfirmed: true });
    expect(r.reviews).toEqual(["The change through probe.thing.update was made but not recorded"]);
    expect(r.wrote).toBe(true);
  });
});
