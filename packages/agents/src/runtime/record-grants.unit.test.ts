// Step model §10f (stream N): the gate on our own records. A record type's standard action runs
// only within the pinned agent version's grant (its own grants and the data sets that are on); a
// Find also needs read on every record type it follows; a refusal is logged and never reaches the
// records. One client's call reaches only that client's records.

import { type AgentData, RecordType } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry/tools";
import {
  type RecordsPort,
  type RecordValues,
  type RecordWriteMeta,
  recordToolsFor,
} from "../tools/records";
import { callTool } from "./call-tool";
import type { RuntimeDeps, StepContext } from "./context";
import { recordGrantRefusal } from "./record-grants";

const A = "0190f5e8-8a3c-7d6e-8f00-00000000aaaa";
const B = "0190f5e8-8a3c-7d6e-8f00-00000000bbbb";
const V1 = "0190f5e8-8a3c-7d6e-8f00-000000000001";
const V2 = "0190f5e8-8a3c-7d6e-8f00-000000000002";
const VB = "0190f5e8-8a3c-7d6e-8f00-0000000000b1";
const J1 = "0190f5e8-8a3c-7d6e-8f00-000000000011";
const J2 = "0190f5e8-8a3c-7d6e-8f00-000000000012";
const J3 = "0190f5e8-8a3c-7d6e-8f00-000000000013";

const VENDOR = RecordType.parse({
  id: "vendor",
  name: "Vendor",
  plural: "Vendors",
  area: "shared",
  about: "A business the client buys from.",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "region", type: "text", required: false },
  ],
  operations: { update: true },
});
const JOB_MARGIN = RecordType.parse({
  id: "job_margin",
  name: "Margin by job",
  plural: "Margins by job",
  area: "bookkeeping",
  about: "A job's margin.",
  fields: [
    { name: "job", type: "text", required: true },
    { name: "margin", type: "money", required: true },
    { name: "vendorId", type: "record", record: "vendor", required: false },
  ],
  links: [{ name: "vendor", to: "vendor", field: "vendorId" }],
  operations: { create: true, update: true },
  writable: ["job", "margin", "vendorId"],
});

/** Each client's records, by type; the port answers for the client it is asked about only. */
function memoryRecords() {
  const db: Record<string, Record<string, RecordValues[]>> = {
    [A]: {
      vendor: [
        { id: V1, name: "Acme", region: "West" },
        { id: V2, name: "Bolt", region: "East" },
      ],
      job_margin: [
        { id: J1, job: "Kitchen", margin: "1200.00", vendorId: V1 },
        { id: J2, job: "Deck", margin: "300.50", vendorId: V1 },
        { id: J3, job: "Roof", margin: "800.00", vendorId: V2 },
      ],
    },
    [B]: { vendor: [{ id: VB, name: "B's vendor", region: "West" }], job_margin: [] },
  };
  const calls: string[] = [];
  const writes: { tenantId: string; values: RecordValues; meta: RecordWriteMeta }[] = [];
  const of = (t: string, type: string) => db[t]?.[type] ?? [];
  const port: RecordsPort = {
    async list(t, type) {
      calls.push(`list ${t} ${type}`);
      return { records: of(t, type), truncated: false };
    },
    async get(t, type, ids) {
      calls.push(`get ${t} ${type}`);
      return of(t, type).filter((r) => ids.includes(r.id as string));
    },
    async create(t, _type, values, meta) {
      writes.push({ tenantId: t, values, meta });
      return { id: "new", ...values };
    },
    async update(t, type, id, values, meta) {
      const found = of(t, type).find((r) => r.id === id);
      if (!found) throw new Error(`there is no ${type} ${id}`);
      writes.push({ tenantId: t, values, meta });
      return { ...found, ...values };
    },
  };
  return { port, calls, writes };
}

function setUp(
  data: AgentData | undefined,
  opts: {
    tenantId?: string;
    readOnly?: boolean;
    mode?: "act" | "suggest_only";
    stage?: string | null;
    run?: "live" | "test";
  } = {},
) {
  const records = memoryRecords();
  const logged: { status: string; output: unknown }[] = [];
  const deps = {
    tools: new ToolRegistry({ platform: recordToolsFor([VENDOR, JOB_MARGIN]) }),
    ports: {
      log: {
        startToolCall: async () => "tc",
        finishToolCall: async (
          _t: string,
          _id: string,
          done: { status: string; output: unknown },
        ) => {
          logged.push(done);
        },
      },
      store: { agentStage: async () => (opts.stage === undefined ? "live" : opts.stage) },
      platform: {},
      records: records.port,
    },
  } as unknown as RuntimeDeps;
  const step = {
    tenantId: opts.tenantId ?? A,
    runId: "r1",
    stepRunId: "s1",
    stepId: "margin",
    mode: opts.run ?? "live",
    readOnly: opts.readOnly,
    agent: {
      agentId: "a1",
      agentVersionId: "v1",
      bindings: {},
      bundle: {
        definition: { permissions: { mode: opts.mode ?? "act" }, ...(data ? { data } : {}) },
      },
    },
    externalIndex: { next: 0 },
  } as unknown as StepContext;
  const call = (toolId: string, input: unknown) => callTool(deps, step, { toolId, input });
  return { call, logged, ...records };
}

const MARGIN_SET: AgentData = {
  grants: [],
  sets: [
    {
      id: "margin-and-roi",
      name: "Margin and ROI",
      on: true,
      grants: [
        { recordType: "job_margin", read: true, create: true, update: true },
        { recordType: "vendor", read: true, create: false, update: false },
      ],
    },
  ],
};

describe("the gate on record types", () => {
  it("refuses every standard action without a grant, logs it, and never reaches the records", async () => {
    const t = setUp(undefined);
    for (const [tool, input] of [
      ["records.vendor.find", {}],
      ["records.vendor.get", { id: V1 }],
      ["records.vendor.update", { id: V1, region: "North" }],
      ["records.job_margin.create", { job: "Barn", margin: "10.00" }],
    ] as const) {
      expect(await t.call(tool, input), tool).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/isn't granted/),
      });
    }
    expect(t.logged.map((l) => l.status)).toEqual(["refused", "refused", "refused", "refused"]);
    expect(t.calls).toEqual([]);
    expect(t.writes).toEqual([]);
  });

  it("reads and writes within a data set that is on, and nothing once it is off", async () => {
    const on = setUp(MARGIN_SET);
    expect(await on.call("records.job_margin.find", {})).toMatchObject({
      status: "done",
      output: { count: 3 },
    });
    expect(
      await on.call("records.job_margin.update", { id: J1, margin: "1300.00", sources: [J1] }),
    ).toMatchObject({ status: "done", output: { margin: "1300.00" } });
    // Read only on vendors: no change.
    expect(await on.call("records.vendor.update", { id: V1, region: "North" })).toMatchObject({
      status: "refused",
      reason: "this agent isn't granted to change vendor records (records.vendor.update)",
    });
    const off = setUp({ ...MARGIN_SET, sets: MARGIN_SET.sets.map((s) => ({ ...s, on: false })) });
    expect(await off.call("records.job_margin.find", {})).toMatchObject({ status: "refused" });
  });

  it("needs read on every record type a Find follows", async () => {
    const t = setUp({
      grants: [{ recordType: "job_margin", read: true, create: false, update: false }],
      sets: [],
    });
    expect(await t.call("records.job_margin.find", {})).toMatchObject({ status: "done" });
    expect(await t.call("records.job_margin.find", { follow: ["vendor"] })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/isn't granted to read vendor records/),
    });
    expect(t.calls.filter((c) => c.includes("vendor"))).toEqual([]);
    // A follow the record type doesn't declare is refused too, never guessed.
    expect(
      recordGrantRefusal(
        { bundle: { definition: { data: MARGIN_SET } } } as never,
        {
          id: "records.job_margin.find",
          record: { type: "job_margin", action: "find", links: { vendor: "vendor" } },
        },
        { follow: ["customer"] },
      ),
    ).toBe("records.job_margin.find has no link customer");
  });

  it("finds across areas with typed rules, groups and decimal totals, through a link", async () => {
    const t = setUp(MARGIN_SET);
    const out = await t.call("records.job_margin.find", {
      follow: ["vendor"],
      where: [{ field: "vendor.region", op: "equals", value: "West" }],
      groupBy: "vendor.name",
      totals: [{ field: "margin", as: "margin" }],
    });
    expect(out).toMatchObject({
      status: "done",
      output: {
        count: 2,
        groups: [{ key: "Acme", count: 2, totals: { margin: "1500.5" } }],
        truncated: false,
      },
    });
  });

  it("hands a write its agent version, a key the same write keeps, and its evidence", async () => {
    const t = setUp(MARGIN_SET);
    const input = { job: "Barn", margin: "45.00", vendorId: V2, sources: [J3] };
    await t.call("records.job_margin.create", input);
    await t.call("records.job_margin.create", input);
    expect(t.writes).toHaveLength(2);
    const [first, again] = t.writes;
    expect(first?.values).toEqual({ job: "Barn", margin: "45.00", vendorId: V2 });
    expect(first?.meta).toMatchObject({
      agentVersionId: "v1",
      runId: "r1",
      stepRunId: "s1",
      sources: [J3],
      mode: "live",
    });
    // The port saves once under the key (the record_write log); the same write has the same key.
    expect(first?.meta.key).toMatch(/^rec:r1:margin:records\.job_margin\.create:/);
    expect(again?.meta.key).toBe(first?.meta.key);
  });

  it("writes without a person only for an agent that acts and is live; reads go on", async () => {
    const write = { id: J1, margin: "1.00" };
    for (const [opts, words] of [
      [{ mode: "suggest_only" as const }, /suggests only/],
      [{ stage: "trial" }, /in its trial stage/],
      [{ stage: "signoff" }, /in its signoff stage/],
      [{ stage: null }, /in its bench stage/],
    ] as const) {
      const t = setUp(MARGIN_SET, opts);
      expect(await t.call("records.job_margin.update", write), JSON.stringify(opts)).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(words),
      });
      expect(t.writes).toEqual([]);
      expect(await t.call("records.job_margin.find", {})).toMatchObject({ status: "done" });
    }
    // A test run in its trial checks the write (the port saves nothing in a test run).
    const tried = setUp(MARGIN_SET, { stage: "trial", run: "test" });
    expect(await tried.call("records.job_margin.update", write)).toMatchObject({ status: "done" });
    expect(tried.writes[0]?.meta.mode).toBe("test");
    // Acting and live: no person needed.
    const live = setUp(MARGIN_SET);
    expect(await live.call("records.job_margin.update", write)).toMatchObject({ status: "done" });
  });

  it("lets an asked agent read only, whatever it is granted", async () => {
    const t = setUp(MARGIN_SET, { readOnly: true });
    expect(await t.call("records.job_margin.create", { job: "x", margin: "1.00" })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/only reads/),
    });
    expect(await t.call("records.job_margin.find", {})).toMatchObject({ status: "done" });
  });

  it("reaches only the calling client's records", async () => {
    const t = setUp(MARGIN_SET, { tenantId: B });
    expect(await t.call("records.vendor.get", { id: V1 })).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/there is no vendor/),
    });
    expect(await t.call("records.vendor.find", {})).toMatchObject({
      status: "done",
      output: { count: 1, items: [{ id: VB }] },
    });
    expect(t.calls.every((c) => c.includes(B))).toBe(true);
  });
});
