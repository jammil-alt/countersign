import { type AgentBundle, AgentBundle as BundleSchema, eventRunId } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { dueSchedules, type RoutableAgent, requestRun, routeEvent, ticksBetween } from "./router";

const CLIENT_A = "0192f7a0-0000-7000-8000-00000000c00a";
const CLIENT_B = "0192f7a0-0000-7000-8000-00000000c00b";
const EVENT_ID = "0192f7a0-0000-7000-8000-00000000e001";

let n = 0;
const uuid = () => `0192f7a0-0000-7000-8000-${String(++n).padStart(12, "0")}`;

function bundle(workflows: { slug: string; enabled?: boolean; on: unknown }[]): AgentBundle {
  return BundleSchema.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "A", role: "r", mission: "m" },
      kind: "functional",
      model: { id: "claude-opus-5-5" },
      instructions: "",
      skills: [],
    },
    workflows: workflows.map((w) => ({
      slug: w.slug,
      name: w.slug,
      enabled: w.enabled ?? true,
      workflow: { schemaVersion: 3, trigger: { id: `t-${w.slug}`, on: w.on }, steps: [] },
    })),
  });
}

function agent(over: Partial<RoutableAgent> & { liveBundle: AgentBundle | null }): RoutableAgent {
  return {
    id: uuid(),
    tenantId: CLIENT_A,
    kind: "client",
    status: "active",
    runStatus: "active",
    liveVersionId: uuid(),
    ...over,
  };
}

const onDoc = { type: "event", event: "document.received" };
const doc = (tenantId = CLIENT_A, payload: unknown = { filename: "a.pdf", source: "email" }) => ({
  id: EVENT_ID,
  tenantId,
  type: "document.received",
  payload,
});

describe("routeEvent", () => {
  it("never starts an agent on its own run's failure", async () => {
    const onFailed = { type: "event", event: "run.failed" };
    const watcher = agent({ liveBundle: bundle([{ slug: "on-failure", on: onFailed }]) });
    const worker = agent({ liveBundle: bundle([{ slug: "work", on: onDoc }]) });
    const failed = (agentId: string) => ({
      id: EVENT_ID,
      tenantId: CLIENT_A,
      type: "run.failed",
      payload: { agentId, runId: uuid() },
    });
    // The worker's failure starts the watcher; the watcher's own failure starts nothing.
    expect((await routeEvent(failed(worker.id), [watcher, worker])).runs).toHaveLength(1);
    expect((await routeEvent(failed(watcher.id), [watcher, worker])).runs).toHaveLength(0);
  });

  it("starts only the event's own client's active agents", async () => {
    const mine = agent({ liveBundle: bundle([{ slug: "intake", on: onDoc }]) });
    const other = agent({
      tenantId: CLIENT_B,
      liveBundle: bundle([{ slug: "intake", on: onDoc }]),
    });
    const { runs } = await routeEvent(doc(), [mine, other]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      tenantId: CLIENT_A,
      agentId: mine.id,
      agentVersionId: mine.liveVersionId,
      workflowSlug: "intake",
      mode: "live",
      trigger: {
        triggerId: "t-intake",
        type: "event",
        eventId: EVENT_ID,
        eventType: "document.received",
      },
      payload: { filename: "a.pdf", source: "email" },
    });
  });

  it("ignores templates, paused, disabled and unpublished agents, and switched-off workflows", async () => {
    const b = bundle([{ slug: "intake", on: onDoc }]);
    const agents = [
      agent({ kind: "template", tenantId: null, liveBundle: b }),
      // A template row carrying the client id would still be refused by kind.
      agent({ kind: "template", liveBundle: b }),
      agent({ runStatus: "paused", liveBundle: b }),
      agent({ runStatus: "testing", liveBundle: b }),
      agent({ runStatus: "draft", liveBundle: b }),
      agent({ status: "disabled", liveBundle: b }),
      agent({ liveVersionId: null, liveBundle: null }),
      agent({ liveBundle: bundle([{ slug: "intake", enabled: false, on: onDoc }]) }),
      agent({
        liveBundle: bundle([{ slug: "other", on: { type: "event", event: "alert.raised" } }]),
      }),
      agent({ liveBundle: bundle([{ slug: "m", on: { type: "manual", input: {} } }]) }),
    ];
    expect((await routeEvent(doc(), agents)).runs).toEqual([]);
  });

  it("applies the trigger's filter rules to the payload", async () => {
    const filtered = agent({
      liveBundle: bundle([
        {
          slug: "email-only",
          on: {
            ...onDoc,
            filter: { rules: [{ field: "{{trigger.source}}", op: "=", value: "email" }] },
          },
        },
        {
          slug: "upload-only",
          on: {
            ...onDoc,
            filter: { rules: [{ field: "{{trigger.source}}", op: "=", value: "upload" }] },
          },
        },
      ]),
    });
    const { runs } = await routeEvent(doc(), [filtered]);
    expect(runs.map((r) => r.workflowSlug)).toEqual(["email-only"]);
  });

  it("gives a re-dispatched event the same run ids", async () => {
    const a = agent({
      liveBundle: bundle([
        { slug: "x", on: onDoc },
        { slug: "y", on: onDoc },
      ]),
    });
    const first = await routeEvent(doc(), [a]);
    const again = await routeEvent(doc(), [a]);
    expect(again.runs.map((r) => r.runId)).toEqual(first.runs.map((r) => r.runId));
    expect(new Set(first.runs.map((r) => r.runId)).size).toBe(2);
    expect(first.runs[0]?.runId).toBe(
      await eventRunId({ eventId: EVENT_ID, agentId: a.id, workflowSlug: "x" }),
    );
    const other = await routeEvent({ ...doc(), id: uuid() }, [a]);
    expect(other.runs[0]?.runId).not.toBe(first.runs[0]?.runId);
  });

  it("reports a filter it can't evaluate instead of throwing", async () => {
    const bad = agent({
      liveBundle: bundle([
        {
          slug: "bad",
          on: { ...onDoc, filter: { rules: [{ field: "source", op: "=", value: "x" }] } },
        },
      ]),
    });
    const { runs, problems } = await routeEvent(doc(), [bad]);
    expect(runs).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});

describe("dueSchedules", () => {
  const nine = { type: "schedule", cron: "0 9 * * *" };

  it("fires in the client's timezone", async () => {
    const a = agent({ liveBundle: bundle([{ slug: "daily", on: nine }]) });
    const timezones = { [CLIENT_A]: "America/New_York" };
    // 3 Nov 2026: New York is on EST (UTC-5), so 09:00 there is 14:00 UTC.
    const at13 = await dueSchedules({
      agents: [a],
      timezones,
      from: new Date("2026-11-03T12:59:00Z"),
      to: new Date("2026-11-03T13:00:00Z"),
    });
    expect(at13.runs).toEqual([]);
    const at14 = await dueSchedules({
      agents: [a],
      timezones,
      from: new Date("2026-11-03T13:59:00Z"),
      to: new Date("2026-11-03T14:00:00Z"),
    });
    expect(at14.runs).toHaveLength(1);
    expect(at14.runs[0]).toMatchObject({
      agentId: a.id,
      workflowSlug: "daily",
      trigger: {
        type: "schedule",
        tz: "America/New_York",
        scheduledAt: "2026-11-03T14:00:00.000Z",
      },
      payload: { scheduledAt: "2026-11-03T14:00:00.000Z" },
    });
    // In July (EDT, UTC-4) the same schedule is 13:00 UTC.
    const july = await dueSchedules({
      agents: [a],
      timezones,
      from: new Date("2026-07-01T12:59:00Z"),
      to: new Date("2026-07-01T13:00:00Z"),
    });
    expect(july.runs).toHaveLength(1);
  });

  it("uses the trigger's own tz over the client's, and UTC when neither is set", async () => {
    const own = agent({
      liveBundle: bundle([{ slug: "tokyo", on: { ...nine, tz: "Asia/Tokyo" } }]),
    });
    const utc = agent({ tenantId: CLIENT_B, liveBundle: bundle([{ slug: "utc", on: nine }]) });
    const r = await dueSchedules({
      agents: [own, utc],
      timezones: { [CLIENT_A]: "America/New_York" },
      from: new Date("2026-11-02T23:59:00Z"),
      to: new Date("2026-11-03T10:00:00Z"),
    });
    expect(r.runs.map((x) => [x.workflowSlug, x.trigger])).toEqual([
      [
        "tokyo",
        expect.objectContaining({ tz: "Asia/Tokyo", scheduledAt: "2026-11-03T00:00:00.000Z" }),
      ],
      ["utc", expect.objectContaining({ tz: "UTC", scheduledAt: "2026-11-03T09:00:00.000Z" })],
    ]);
  });

  it("windows are (from, to]: a tick at `from` belongs to the previous window", () => {
    expect(
      ticksBetween(
        "*/5 * * * *",
        "UTC",
        new Date("2026-11-03T10:00:00Z"),
        new Date("2026-11-03T10:10:00Z"),
      ).map((d) => d.toISOString()),
    ).toEqual(["2026-11-03T10:05:00.000Z", "2026-11-03T10:10:00.000Z"]);
    expect(
      ticksBetween(
        "* * * * *",
        "UTC",
        new Date("2026-11-03T10:00:00Z"),
        new Date("2026-11-03T10:00:00Z"),
      ),
    ).toEqual([]);
  });

  it("gives overlapping sweeps the same run id, and keeps only the latest missed tick", async () => {
    const a = agent({
      liveBundle: bundle([{ slug: "hourly", on: { type: "schedule", cron: "0 * * * *" } }]),
    });
    const window = { agents: [a], timezones: {} };
    const one = await dueSchedules({
      ...window,
      from: new Date("2026-11-03T09:59:00Z"),
      to: new Date("2026-11-03T10:00:00Z"),
    });
    const overlap = await dueSchedules({
      ...window,
      from: new Date("2026-11-03T09:30:00Z"),
      to: new Date("2026-11-03T10:00:30Z"),
    });
    expect(overlap.runs[0]?.runId).toBe(one.runs[0]?.runId);
    const gap = await dueSchedules({
      ...window,
      from: new Date("2026-11-03T05:30:00Z"),
      to: new Date("2026-11-03T10:00:30Z"),
    });
    expect(gap.runs.map((r) => r.payload)).toEqual([{ scheduledAt: "2026-11-03T10:00:00.000Z" }]);
    const all = await dueSchedules({
      ...window,
      from: new Date("2026-11-03T05:30:00Z"),
      to: new Date("2026-11-03T10:00:30Z"),
      maxPerTrigger: 10,
    });
    expect(all.runs).toHaveLength(5);
  });

  it("skips non-runnable agents and reports bad crons and zones", async () => {
    const r = await dueSchedules({
      agents: [
        agent({ runStatus: "paused", liveBundle: bundle([{ slug: "p", on: nine }]) }),
        agent({ kind: "template", tenantId: null, liveBundle: bundle([{ slug: "t", on: nine }]) }),
        agent({ liveBundle: bundle([{ slug: "bad", on: { type: "schedule", cron: "nope" } }]) }),
        agent({ liveBundle: bundle([{ slug: "zone", on: { ...nine, tz: "Mars/Olympus" } }]) }),
      ],
      timezones: {},
      from: new Date("2026-11-03T08:00:00Z"),
      to: new Date("2026-11-03T10:00:00Z"),
    });
    expect(r.runs).toEqual([]);
    expect(r.problems.map((p) => p.workflowSlug)).toEqual(["bad", "zone"]);
  });
});

describe("requestRun", () => {
  const manual = bundle([
    { slug: "m", on: { type: "manual", input: {} } },
    { slug: "e", on: onDoc },
  ]);

  it("starts manual runs of a live client agent with a fresh v7 id", () => {
    const a = agent({ liveBundle: manual });
    const r1 = requestRun({ agent: a, workflowSlug: "m", payload: { x: 1 } });
    const r2 = requestRun({ agent: a, workflowSlug: "m", payload: { x: 1 } });
    expect(r1.runId).not.toBe(r2.runId);
    expect(r1.runId[14]).toBe("7");
    expect(r1).toMatchObject({
      mode: "live",
      agentVersionId: a.liveVersionId,
      trigger: { type: "manual" },
    });
  });

  it("refuses templates, paused agents and event workflows for live runs; test runs may use a draft", () => {
    expect(() =>
      requestRun({
        agent: agent({ kind: "template", tenantId: null, liveBundle: manual }),
        workflowSlug: "m",
        payload: {},
      }),
    ).toThrow();
    const paused = agent({ runStatus: "paused", liveBundle: manual });
    expect(() => requestRun({ agent: paused, workflowSlug: "m", payload: {} })).toThrow();
    expect(() =>
      requestRun({ agent: agent({ liveBundle: manual }), workflowSlug: "e", payload: {} }),
    ).toThrow();
    const draft = uuid();
    const test = requestRun({
      agent: paused,
      workflowSlug: "e",
      payload: {},
      mode: "test",
      versionId: draft,
      bundle: manual,
    });
    expect(test).toMatchObject({ mode: "test", agentVersionId: draft, workflowSlug: "e" });
  });
});
