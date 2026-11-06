// v0.12 W2-E: the router's new trigger kinds (docs/plan.md §1.48): holidays, webhooks, messages,
// handoffs, and starting by hand through `moreTriggers`.

import { type AgentBundle, AgentBundle as BundleSchema } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { dueSchedules, type RoutableAgent, requestRun, routeEvent } from "./router";

const CLIENT_A = "0192f7a0-0000-7000-8000-00000000c00a";
const CLIENT_B = "0192f7a0-0000-7000-8000-00000000c00b";
const HOOK = "0192f7a0-0000-7000-8000-0000000000ab";
const CONN = "0192f7a0-0000-7000-8000-0000000000ac";
const CONTACT = "0192f7a0-0000-7000-8000-0000000000ad";
const USER = "0192f7a0-0000-7000-8000-0000000000ae";

let n = 0;
const uuid = () => `0192f7a0-0000-7000-8000-${String(++n).padStart(12, "0")}`;

function multi(slug: string, triggers: { id: string; on: unknown }[]): AgentBundle {
  const [first, ...more] = triggers;
  return BundleSchema.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "B", role: "r", mission: "m" },
      kind: "functional",
      model: { id: "claude-opus-5-5" },
      instructions: "",
      skills: [],
    },
    workflows: [
      {
        slug,
        name: slug,
        workflow: {
          schemaVersion: 3,
          trigger: first,
          ...(more.length ? { moreTriggers: more } : {}),
          steps: [],
        },
      },
    ],
  });
}

function agent(over: Partial<RoutableAgent> & { liveBundle: AgentBundle }): RoutableAgent {
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

describe("schedule triggers with skipHolidays", () => {
  it("skip July 4 (observed) in the client's zone, and the client's own days off", async () => {
    const on = { type: "schedule", cron: "0 9 * * *", skipHolidays: true };
    const a = agent({ liveBundle: multi("daily", [{ id: "t", on }]) });
    const plain = agent({
      liveBundle: multi("daily", [{ id: "t", on: { type: "schedule", cron: "0 9 * * *" } }]),
    });
    const at = (iso: string) => ({ from: new Date(Date.parse(iso) - 60_000), to: new Date(iso) });
    const timezones = { [CLIENT_A]: "America/New_York" };
    // 9:00 in New York on Friday July 3, 2026: July 4 is a Saturday, observed on the Friday.
    const july3 = await dueSchedules({
      agents: [a, plain],
      timezones,
      ...at("2026-07-03T13:00:00Z"),
    });
    expect(july3.runs.map((r) => r.agentId)).toEqual([plain.id]);
    const july6 = await dueSchedules({ agents: [a], timezones, ...at("2026-07-06T13:00:00Z") });
    expect(july6.runs).toHaveLength(1);
    const own = await dueSchedules({
      agents: [a],
      timezones,
      holidays: { [CLIENT_A]: ["2026-07-06"] },
      ...at("2026-07-06T13:00:00Z"),
    });
    expect(own.runs).toHaveLength(0);
  });
});

describe("webhook triggers", () => {
  it("start for their hook only, filtered, deduplicated, with their rate limit", async () => {
    const a = agent({
      liveBundle: multi("leads", [
        {
          id: "hook",
          on: {
            type: "webhook",
            hookId: HOOK,
            filter: {
              match: "all",
              rules: [{ field: "{{trigger.data.kind}}", op: "=", value: "lead" }],
            },
            dedupeKey: "{{trigger.data.id}}",
            rateLimit: { max: 60, per: "hour" },
          },
        },
      ]),
    });
    const delivery = (data: unknown, hookId = HOOK) => ({
      id: uuid(),
      tenantId: CLIENT_A,
      type: "webhook.received",
      payload: { hookId, connectionId: CONN, data },
    });
    const one = await routeEvent(delivery({ kind: "lead", id: "L1" }), [a]);
    const again = await routeEvent(delivery({ kind: "lead", id: "L1" }), [a]);
    expect(one.runs).toHaveLength(1);
    expect(again.runs[0]?.runId).toBe(one.runs[0]?.runId);
    expect(one.runs[0]).toMatchObject({
      trigger: { type: "webhook", hookId: HOOK, dedupeKey: "L1" },
      limit: { triggerId: "hook", max: 60, windowSeconds: 3600, hookId: HOOK, connectionId: CONN },
    });
    expect((await routeEvent(delivery({ kind: "spam", id: "L2" }), [a])).runs).toEqual([]);
    expect((await routeEvent(delivery({ kind: "lead" }, uuid()), [a])).runs).toEqual([]);
  });
});

describe("message triggers", () => {
  const on = {
    type: "message",
    channels: ["email", "command"],
    from: { tags: ["cardholder"], clientRoles: ["client_admin"] },
  };

  it("start only for their agent, their channels and senders their People filter takes", async () => {
    const remy = agent({ liveBundle: multi("charges", [{ id: "msg", on }]) });
    const other = agent({ liveBundle: multi("charges", [{ id: "msg", on }]) });
    const inbound = (agentId: string, channel = "email") => ({
      id: uuid(),
      tenantId: CLIENT_A,
      type: "inbound.message",
      payload: {
        agentId,
        channel,
        contactId: CONTACT,
        userId: null,
        rawRecordId: uuid(),
        documents: [],
        receivedAt: "2026-11-06T15:00:00.000Z",
      },
    });
    const cardholder = {
      sender: async () => ({
        kind: "contact" as const,
        contactId: CONTACT,
        relationship: null,
        tags: ["cardholder"],
      }),
    };
    const stranger = { sender: async () => ({ kind: "stranger" as const }) };
    const ok = await routeEvent(inbound(remy.id), [remy, other], cardholder);
    expect(ok.runs.map((r) => r.agentId)).toEqual([remy.id]);
    expect(ok.runs[0]?.payload).toMatchObject({ channel: "email", contactId: CONTACT });
    expect((await routeEvent(inbound(remy.id), [remy], stranger)).runs).toEqual([]);
    expect((await routeEvent(inbound(remy.id), [remy])).runs).toEqual([]);
    expect((await routeEvent(inbound(remy.id, "sms"), [remy], cardholder)).runs).toEqual([]);
  });

  it("start from a person's /command, never from an operator's /skill", async () => {
    const remy = agent({ liveBundle: multi("charges", [{ id: "msg", on }]) });
    const posted = (skill?: string) => ({
      id: uuid(),
      tenantId: CLIENT_A,
      type: "thread.message_posted",
      payload: {
        threadId: uuid(),
        subjectType: "lead",
        subjectId: uuid(),
        messageId: uuid(),
        senderType: "user",
        senderId: USER,
        audience: "client",
        command: { name: "remy", agentId: remy.id, ...(skill ? { skill } : {}) },
      },
    });
    const admin = {
      sender: async () => ({ kind: "user" as const, userId: USER, role: "client_admin" as const }),
    };
    const user = {
      sender: async () => ({ kind: "user" as const, userId: USER, role: "client_user" as const }),
    };
    const cmd = await routeEvent(posted(), [remy], admin);
    expect(cmd.runs[0]).toMatchObject({
      agentId: remy.id,
      trigger: { type: "message", channel: "command" },
      payload: { channel: "command", userId: USER },
    });
    expect((await routeEvent(posted(), [remy], user)).runs).toEqual([]);
    expect((await routeEvent(posted("docs.extract"), [remy], admin)).runs).toEqual([]);
  });
});

describe("handoff triggers", () => {
  it("start another agent of the same client with the sources, never the same one, 3 deep", async () => {
    const handoff = { type: "handoff", from: { agent: "intake" } };
    const intake = agent({
      liveBundle: multi("intake", [{ id: "m", on: { type: "manual", input: {} } }]),
    });
    const filer = agent({ liveBundle: multi("file", [{ id: "h", on: handoff }]) });
    const elsewhere = agent({
      tenantId: CLIENT_B,
      liveBundle: multi("file", [{ id: "h", on: handoff }]),
    });
    const succeeded = (agentId: string, depth: number) => ({
      id: uuid(),
      tenantId: CLIENT_A,
      type: "run.succeeded",
      payload: {
        runId: uuid(),
        agentId,
        agentSlug: "intake",
        agentVersionId: uuid(),
        workflowSlug: "intake",
        output: { billId: "b1" },
        sources: [CONTACT],
        depth,
      },
    });
    const r = await routeEvent(succeeded(intake.id, 1), [intake, filer, elsewhere]);
    expect(r.runs.map((x) => x.agentId)).toEqual([filer.id]);
    expect(r.runs[0]?.payload).toMatchObject({
      sources: [CONTACT],
      depth: 1,
      output: { billId: "b1" },
    });
    // The filer's own run (even if its slug matched) never starts the filer.
    expect((await routeEvent(succeeded(filer.id, 1), [filer])).runs).toEqual([]);
    expect((await routeEvent(succeeded(intake.id, 3), [filer])).runs).toHaveLength(1);
    expect((await routeEvent(succeeded(intake.id, 4), [filer])).runs).toEqual([]);
  });
});

describe("moreTriggers", () => {
  it("let a workflow start by hand through a manual trigger beside its event", () => {
    const a = agent({
      liveBundle: multi("both", [
        { id: "ev", on: { type: "event", event: "document.received" } },
        { id: "hand", on: { type: "manual", input: {} } },
      ]),
    });
    expect(requestRun({ agent: a, workflowSlug: "both", payload: {} }).trigger).toEqual({
      triggerId: "hand",
      type: "manual",
    });
  });
});
