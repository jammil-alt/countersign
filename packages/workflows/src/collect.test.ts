// Collect reports (owner, 2026-11-24): a step that waits for several reports, each from its own
// owner, checks each in code, follows up, and escalates a late one.
import { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { FakeStepRunner } from "./fake-runner";
import { executeProcess, Harness, RUN } from "./fakes.test-helper";
import type { CollectCheckRequest, CollectPort, SkillStepRequest } from "./ports";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

const report = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id === "bank" ? "Bank statement" : "Card statement",
  owner: id === "bank" ? "seat:controller" : "0192f7a0-0000-7000-8000-00000000d001",
  required: true,
  frequency: "monthly",
  formats: ["pdf", "spreadsheet"],
  due: "3 days",
  hours: "clock",
  followUp: { after: "1 day", every: "2 days", max: 1 },
  ...over,
});

const collect = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  kind: "collect",
  name: "Collect the month's reports",
  items: [report("bank"), report("card")],
  ifMissing: "stop",
  ...over,
});

const reconcile = {
  id: "rec",
  kind: "skill",
  name: "Reconcile",
  skill: "custom:reconcile",
  input: { documents: "{{steps.c1.output.documents}}" },
};

/** The forms step's answers, by the node that asked (`c1:<item>:r<n>:ask`). */
type FormAnswer =
  | { outcome: "submitted"; documents: string[] }
  | { outcome: "no_answer" | "not_sent" | "declined"; reason?: string };

function harness(answers: Record<string, FormAnswer>, mode: "live" | "test" = "live") {
  const h = new Harness({ ...RUN, mode });
  const asks: SkillStepRequest[] = [];
  h.handlers.ask = (req) => {
    asks.push(req as SkillStepRequest);
    const a = answers[req.nodeId] ?? { outcome: "no_answer" };
    return {
      kind: "done",
      output: {
        outcome: a.outcome,
        formRequestId: null,
        answers: null,
        extra: null,
        documents: a.outcome === "submitted" ? a.documents : [],
        contact: null,
        channel: "email",
        submittedAt: null,
        reason: "reason" in a ? (a.reason ?? null) : null,
        sources: [],
      },
    };
  };
  return { h, asks };
}

/** Checks pass unless the document id says "bad". */
function checks() {
  const calls: CollectCheckRequest[] = [];
  const port: CollectPort = {
    check: async (req) => {
      calls.push(req);
      const bad = req.documentIds.some((d) => d.includes("bad"));
      return bad
        ? {
            ok: false,
            problems: ["bank.csv has 1 row; we need at least 2."],
            documents: [],
            rows: [],
          }
        : {
            ok: true,
            problems: [],
            documents: req.documentIds,
            rows: req.documentIds.map((d) => ({ doc: d, amount: "1.00" })),
            // "doc-mailed…" came by email, its sender unproven; anything else through the link.
            senderProven: req.documentIds.some((d) => d.startsWith("doc-mailed")) ? false : null,
          };
    },
  };
  return { port, calls };
}

/** Answers every escalation card with `answer`. */
function answerEscalations(h: Harness, answer: string) {
  const create = h.inbox.createForPerson;
  h.inbox.createForPerson = async (item) => {
    const made = await create(item);
    const entry = h.items.get(made.id);
    if (entry) entry.resolution = { approved: null, answer, by: "u1" };
    return made;
  };
}

describe("collecting reports", () => {
  it("asks each owner, checks what comes in, and hands the documents on", async () => {
    const { h, asks } = harness({
      "c1:0:r1:ask": { outcome: "submitted", documents: ["doc-bank"] },
      "c1:1:r1:ask": { outcome: "submitted", documents: ["doc-card"] },
    });
    const { port, calls } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect(), reconcile]),
      {},
    );
    expect(result.status).toBe("succeeded");
    // One "Request info" link per owner: a seat goes as its role, a contact as its id.
    expect(asks.map((a) => a.nodeId).sort()).toEqual(["c1:0:r1:ask", "c1:1:r1:ask"]);
    const bank = asks.find((a) => a.nodeId === "c1:0:r1:ask");
    expect(bank?.step.skill).toBe("forms.request");
    expect(bank?.input).toMatchObject({
      to: { role: "controller" },
      purpose: expect.stringMatching(/^Please send us the Bank statement for /),
      ask: {
        required: [{ id: "report", type: "files", required: true, accept: ["pdf", "spreadsheet"] }],
        maxExtra: 0,
      },
      due: expect.stringMatching(/^\d+ minutes$/),
    });
    expect(asks.find((a) => a.nodeId === "c1:1:r1:ask")?.input).toMatchObject({
      to: { contactId: "0192f7a0-0000-7000-8000-00000000d001" },
    });
    expect(calls.map((c) => c.documentIds).sort()).toEqual([["doc-bank"], ["doc-card"]]);
    expect(h.row("c1")).toMatchObject({
      nodeType: "collect",
      status: "succeeded",
      output: {
        complete: true,
        documents: expect.arrayContaining(["doc-bank", "doc-card"]),
        received: 2,
        missing: 0,
      },
      summary: "Collect the month's reports: All 2 reports in and checked",
    });
    // The next step reads what came in.
    expect(h.agentCalls.find((c) => c.step.id === "rec")?.input).toEqual({
      documents: ["doc-bank", "doc-card"],
    });
  });

  it("hands on each report's checked rows by its id, so nothing reads the files again", async () => {
    const { h } = harness({
      "c1:0:r1:ask": { outcome: "submitted", documents: ["doc-bank"] },
      "c1:1:r1:ask": { outcome: "submitted", documents: ["doc-card"] },
    });
    const { port } = checks();
    const match = {
      id: "match",
      kind: "skill",
      name: "Match",
      skill: "custom:match",
      input: {
        bank: "{{steps.c1.output.reports.bank.rows}}",
        card: "{{steps.c1.output.reports.card.rows}}",
      },
    };
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect(), match]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls.find((c) => c.step.id === "match")?.input).toEqual({
      bank: [{ doc: "doc-bank", amount: "1.00" }],
      card: [{ doc: "doc-card", amount: "1.00" }],
    });
    expect(h.row("c1")?.output).toMatchObject({
      reports: {
        bank: { status: "received", documents: ["doc-bank"], rowCount: 1 },
        card: { status: "received", documents: ["doc-card"], rowCount: 1 },
      },
    });
    expect(h.row("c1")?.output).toMatchObject({
      reports: { bank: { senderProven: null }, card: { senderProven: null } },
    });
    // The rows are kept once, under `reports`, not in the list of reports too.
    const output = h.row("c1")?.output as { items: object[] } | undefined;
    expect(output?.items[0]).not.toHaveProperty("rows");
  });

  it("asks again with the reasons when a file fails its checks", async () => {
    const { h, asks } = harness({
      "c1:0:r1:ask": { outcome: "submitted", documents: ["doc-bad"] },
      "c1:0:r2:ask": { outcome: "submitted", documents: ["doc-good"] },
    });
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect({ items: [report("bank")] })]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(asks.find((a) => a.nodeId === "c1:0:r2:ask")?.input).toMatchObject({
      purpose: expect.stringContaining(
        "didn't pass our checks: bank.csv has 1 row; we need at least 2. Please send it again.",
      ),
    });
    expect(h.row("c1")?.output).toMatchObject({
      items: [{ id: "bank", status: "received", documents: ["doc-good"], sends: 2 }],
    });
  });

  it("follows up when nobody sent it, then stops the run when it never came", async () => {
    const { h, asks } = harness({});
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect({ items: [report("bank")] }), reconcile]),
      {},
    );
    // The first link and one follow-up (max 1), then `ifMissing: stop`.
    expect(asks.map((a) => a.nodeId)).toEqual(["c1:0:r1:ask", "c1:0:r2:ask"]);
    expect(asks[1]?.input).toMatchObject({ purpose: expect.stringMatching(/^A reminder:/) });
    expect(result).toMatchObject({ status: "failed", reason: "reports missing: Bank statement" });
    expect(h.row("c1")).toMatchObject({ status: "failed", output: { complete: false } });
    expect(h.row("rec")).toBeUndefined();
  });

  it("goes on without a missing report under ifMissing: proceed", async () => {
    const { h } = harness({ "c1:1:r1:ask": { outcome: "submitted", documents: ["doc-card"] } });
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect({ ifMissing: "proceed" }), reconcile]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("c1")?.output).toMatchObject({
      complete: false,
      documents: ["doc-card"],
      summary: "1 of 2 reports in; missing: Bank statement",
    });
  });

  it("doesn't hold the step up for a report that isn't required", async () => {
    const { h } = harness({ "c1:0:r1:ask": { outcome: "submitted", documents: ["doc-bank"] } });
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect({ items: [report("bank"), report("card", { required: false })] })]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("c1")?.output).toMatchObject({ complete: true, received: 1, missing: 1 });
  });

  it("a report never sent (turned down, or not reachable) ends that report, not the loop", async () => {
    const { h, asks } = harness({
      "c1:0:r1:ask": { outcome: "declined" },
      "c1:1:r1:ask": { outcome: "not_sent", reason: "no consent for email" },
    });
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect({ ifMissing: "proceed" })]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(asks).toHaveLength(2);
    expect(h.row("c1")?.output).toMatchObject({
      items: [
        { id: "bank", status: "declined" },
        { id: "card", status: "not_sent", problems: ["no consent for email"] },
      ],
    });
  });
});

describe("a report emailed to the step", () => {
  it("says the sender wasn't proven, for whoever reviews the run", async () => {
    const { h } = harness({
      "c1:0:r1:ask": { outcome: "submitted", documents: ["doc-mailed-bank"] },
    });
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect({ items: [report("bank")] })]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("c1")?.output).toMatchObject({
      complete: true,
      reports: { bank: { status: "received", senderProven: false } },
    });
  });
});

describe("the step's email address", () => {
  it("names the step's address in every link, asked once", async () => {
    const { h, asks } = harness({
      "c1:0:r2:ask": { outcome: "submitted", documents: ["doc-bank"] },
    });
    const { port } = checks();
    const asked: unknown[] = [];
    const withAddress: CollectPort = {
      ...port,
      address: async (req) => {
        asked.push(req);
        return `remy.acme-x+${req.stepId.toLowerCase()}@in.mezonas.test`;
      },
    };
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: withAddress }),
      proc([collect({ items: [report("bank")] })]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(asked).toEqual([{ tenantId: RUN.tenantId, agentId: RUN.agentId, stepId: "c1" }]);
    expect(asks.map((a) => (a.input as { purpose: string }).purpose)).toEqual([
      expect.stringContaining("You can also email it to remy.acme-x+c1@in.mezonas.test."),
      expect.stringContaining("You can also email it to remy.acme-x+c1@in.mezonas.test."),
    ]);
  });
});

describe("escalating a late report", () => {
  const escalate = {
    to: "client_admin",
    after: "5 days",
    hours: "clock",
    deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
  };
  const noFollowUps = report("bank", { followUp: { after: "1 day", every: "1 day", max: 0 } });

  it("asks the escalation when the follow-ups run out; go on without it", async () => {
    const { h } = harness({});
    answerEscalations(h, "go_on");
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect({ items: [noFollowUps], escalate }), reconcile]),
      {},
    );
    expect(result.status).toBe("succeeded");
    const card = [...h.items.values()].find((v) => v.item?.nodeId === "c1:0:r2:esc")?.item;
    expect(card).toMatchObject({
      title: "The Bank statement is late",
      step: { assignee: "client_admin", mode: "ask" },
      payload: { report: "Bank statement", sent: 1 },
    });
    expect(card?.step.choices?.map((c) => c.value)).toEqual(["keep_asking", "go_on", "stop"]);
    expect(h.row("c1")?.output).toMatchObject({
      complete: false,
      items: [{ status: "skipped", escalations: 1 }],
    });
    expect(h.row("rec")).toBeDefined();
  });

  it("keeps asking when told to, and takes the report that then comes", async () => {
    const { h, asks } = harness({
      "c1:0:r2:ask": { outcome: "submitted", documents: ["doc-late"] },
    });
    answerEscalations(h, "keep_asking");
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect({ items: [noFollowUps], escalate })]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(asks.map((a) => a.nodeId)).toEqual(["c1:0:r1:ask", "c1:0:r2:ask"]);
    expect(h.row("c1")?.output).toMatchObject({
      complete: true,
      items: [{ status: "received", documents: ["doc-late"], sends: 2, escalations: 1 }],
    });
  });

  it("offers keep asking only once, then stops the run when told to", async () => {
    const { h } = harness({});
    const answers = ["keep_asking", "stop"];
    const create = h.inbox.createForPerson;
    h.inbox.createForPerson = async (item) => {
      const made = await create(item);
      const entry = h.items.get(made.id);
      if (entry) entry.resolution = { approved: null, answer: answers.shift(), by: "u1" };
      return made;
    };
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect({ items: [noFollowUps], escalate })]),
      {},
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: "stopped: the Bank statement is late",
    });
    const second = [...h.items.values()].find((v) => v.item?.nodeId === "c1:0:r3:esc")?.item;
    expect(second?.step.choices?.map((c) => c.value)).toEqual(["go_on", "stop"]);
  });

  it("takes the deadline's ifNoAnswer when nobody answers the escalation", async () => {
    const { h } = harness({});
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context({ collect: port }),
      proc([
        collect({
          items: [noFollowUps],
          escalate: { ...escalate, deadline: { ...escalate.deadline, ifNoAnswer: "proceed" } },
        }),
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("c1")?.output).toMatchObject({ items: [{ status: "skipped" }] });
  });
});

describe("a test run", () => {
  it("sends nothing and goes on, whatever ifMissing says", async () => {
    const { h } = harness(
      {
        "c1:0:r1:ask": { outcome: "not_sent", reason: "a test run: nothing was sent" },
        "c1:1:r1:ask": { outcome: "not_sent", reason: "a test run: nothing was sent" },
      },
      "test",
    );
    const { port, calls } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect(), reconcile]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([]);
    expect(h.row("c1")?.output).toMatchObject({ complete: false });
  });
});

describe("replay", () => {
  it("a restarted run asks nobody again", async () => {
    const { h, asks } = harness({
      "c1:0:r1:ask": { outcome: "submitted", documents: ["doc-bank"] },
      "c1:1:r1:ask": { outcome: "submitted", documents: ["doc-card"] },
    });
    const { port, calls } = checks();
    const runner = new FakeStepRunner();
    const workflow = proc([collect()]);
    await executeProcess(runner, h.context({ collect: port }), workflow, {});
    runner.replay();
    const again = await executeProcess(runner, h.context({ collect: port }), workflow, {});
    expect(again.status).toBe("succeeded");
    expect(asks).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});

describe("started by a report (the report trigger)", () => {
  const started = (item: string, documents: string[]) => ({
    report: {
      step: "c1",
      item,
      documents,
      contactId: "0192f7a0-0000-7000-8000-00000000d001",
      proven: true,
      receivedAt: "2026-12-01T09:00:00.000Z",
    },
  });

  it("takes the report that started it and the other one emailed meanwhile: no link goes out", async () => {
    const { h, asks } = harness({});
    const { port, calls } = checks();
    const runner = new FakeStepRunner();
    // The card statement came by email while the run listened.
    runner.deliver(processes.reportEventType("c1", "card"), { documents: ["doc-card"] });
    const result = await executeProcess(
      runner,
      h.context({ collect: port }),
      proc([collect(), reconcile]),
      started("bank", ["doc-bank"]),
    );
    expect(result.status).toBe("succeeded");
    expect(asks).toEqual([]);
    expect(calls.map((c) => c.documentIds).sort()).toEqual([["doc-bank"], ["doc-card"]]);
    expect(h.row("c1")?.output).toMatchObject({ complete: true, received: 2 });
    // Once every report is in, the process goes on.
    expect(h.agentCalls.find((c) => c.step.id === "rec")?.input).toEqual({
      documents: ["doc-bank", "doc-card"],
    });
  });

  it("follows up on a report that didn't come in time, as a reminder", async () => {
    const { h, asks } = harness({
      "c1:1:r1:ask": { outcome: "submitted", documents: ["doc-card"] },
    });
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner({ onWait: "timeout" }),
      h.context({ collect: port }),
      proc([collect()]),
      started("bank", ["doc-bank"]),
    );
    expect(result.status).toBe("succeeded");
    // Only the late report gets a link, and it reads as a follow-up.
    expect(asks.map((a) => a.nodeId)).toEqual(["c1:1:r1:ask"]);
    expect(asks[0]?.input).toMatchObject({ purpose: expect.stringMatching(/^A reminder:/) });
    expect(asks[0]?.step.client?.label).toBe("Followed up on the Card statement");
    expect(h.row("c1")?.output).toMatchObject({ complete: true });
  });

  it("asks again with the reasons when the report that started it fails its checks", async () => {
    const { h, asks } = harness({
      "c1:0:r1:ask": { outcome: "submitted", documents: ["doc-good"] },
    });
    const { port } = checks();
    const runner = new FakeStepRunner({ onWait: "timeout" });
    runner.deliver(processes.reportEventType("c1", "card"), { documents: ["doc-card"] });
    const result = await executeProcess(
      runner,
      h.context({ collect: port }),
      proc([collect()]),
      started("bank", ["doc-bad"]),
    );
    expect(result.status).toBe("succeeded");
    expect(asks.map((a) => a.nodeId)).toEqual(["c1:0:r1:ask"]);
    expect(asks[0]?.input).toMatchObject({
      purpose: expect.stringContaining("didn't pass our checks"),
    });
  });

  it("listens only on the step its trigger names", async () => {
    const { h, asks } = harness({
      "c1:0:r1:ask": { outcome: "submitted", documents: ["doc-bank"] },
      "c1:1:r1:ask": { outcome: "submitted", documents: ["doc-card"] },
    });
    const { port } = checks();
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ collect: port }),
      proc([collect()]),
      { report: { ...started("bank", ["doc-x"]).report, step: "other" } },
    );
    expect(result.status).toBe("succeeded");
    // Not started by its reports: it asks everyone, as a scheduled run does.
    expect(asks).toHaveLength(2);
  });
});
