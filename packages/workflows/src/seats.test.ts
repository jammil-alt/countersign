// Setup-plan §4.1: a run's seats become the people the run started with, before anything runs.
import type { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, WRITE_TOOL } from "./fakes.test-helper";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const READ_TOOL = { ...WRITE_TOOL, id: "testkit.thing.get", sideEffect: "none" as const };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

const signed = {
  id: "get",
  kind: "read",
  name: "Get the bill",
  tool: READ_TOOL.id,
  checks: { approval: { approvers: [{ who: "seat:bill-approver" }] } },
};
const ask = {
  id: "ask",
  kind: "person",
  name: "Which job?",
  mode: "ask",
  assignee: "seat:job-codes",
  title: "Which job is this for?",
  deadline: { after: "1 day" },
};

const SEATS: processes.Seats = {
  "bill-approver": { userIds: ["luis"], backupUserIds: ["dana"], contactIds: [] },
  "job-codes": { userIds: ["mark"], backupUserIds: [], contactIds: [] },
};

async function run(seats: processes.Seats | undefined) {
  const h = new Harness();
  h.handlers.get = () => ({ kind: "done", output: { total: 9000 } });
  const runner = new FakeStepRunner({ onWait: "block" });
  runner.onWaitStarted = (_name, type) => runner.deliver(type, { approved: true, by: "x" });
  const result = await executeWorkflow(
    runner,
    h.context(seats ? { seats } : {}),
    proc([signed, ask]),
    {},
  );
  const items = [...h.items.values()].map((v) => v.item);
  return { result, items };
}

describe("seats in a run", () => {
  it("asks the seat's people: the approver to sign, the person who answers to answer", async () => {
    const { result, items } = await run(SEATS);
    expect(result.status).toBe("succeeded");
    expect(items.find((i) => i?.nodeId === "get:signoff:a0")?.step).toMatchObject({
      assignee: "luis",
      mode: "approve",
    });
    expect(items.find((i) => i?.nodeId === "ask")?.step).toMatchObject({ assignee: "mark" });
  });

  it("sends an empty seat's items where they went before seats: the client admin", async () => {
    const { result, items } = await run(undefined);
    expect(result.status).toBe("succeeded");
    expect(items.find((i) => i?.nodeId === "get:signoff:a0")?.step).toMatchObject({
      assignee: "client_admin",
    });
    expect(items.find((i) => i?.nodeId === "ask")?.step).toMatchObject({
      assignee: "client_admin",
    });
  });
});
