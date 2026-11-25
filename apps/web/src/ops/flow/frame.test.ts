// What the workflow builder tells the one-screen view (F6): a loop's start and what it gives back,
// where a new step would go in words, a step's words on the chart, and the statuses the builder
// adds: what the client lacks, and a Dev queue request on a step that requires code (§1.125).
import type { StepCodeRequest, ToolSpec } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ApprovalEnv, Process, Step } from "../builder/model";
import {
  agentEnds,
  chartLabel,
  devQueuePath,
  hostPoint,
  loopEnds,
  loopProcess,
  placeWords,
  withCodeRequests,
} from "./frame";
import { buildStatuses } from "./status";

const update: ToolSpec = {
  id: "testkit.record.update",
  description: "Updates a record",
  input: { type: "object" },
  output: { type: "object" },
  sideEffect: "external",
  verb: "update",
  source: "testkit",
  connector: "testkit",
};

const PROCESS = {
  schemaVersion: 4,
  triggers: [
    { id: "t1", on: { type: "schedule", cron: "0 7 * * 1-5" } },
    { id: "t2", on: { type: "manual", input: { type: "object", properties: {} } } },
  ],
  steps: [
    { id: "read", kind: "read", name: "Read the invoice", tool: "docs.read", input: {} },
    {
      id: "each",
      kind: "for_each",
      name: "Each line",
      over: "{{steps.read.output.lines}}",
      concurrency: 1,
      steps: [
        { id: "price", kind: "read", name: "Check the price", tool: "docs.read", input: {} },
        { id: "fix", kind: "write", name: "Fix the line", tool: update.id, input: {} },
      ],
    },
    {
      id: "again",
      kind: "repeat",
      name: "Until it balances",
      maxTimes: 3,
      onLimit: "stop",
      until: {
        rules: {
          match: "all",
          rules: [{ field: "{{steps.sum.output.ok}}", op: "=", value: true }],
        },
      },
      steps: [{ id: "sum", kind: "read", name: "Add it up", tool: "docs.read", input: {} }],
    },
    {
      id: "pick",
      kind: "if",
      name: "Big?",
      paths: [{ id: "big", name: "Big change", when: { match: "all", rules: [] }, steps: [] }],
      otherwise: { id: "else", steps: [] },
    },
    { id: "m1", kind: "missing", name: "Offset the run date", need: "Run date minus one month" },
  ],
} as unknown as Process;

const step = (id: string) => {
  const found = [...PROCESS.steps, ...PROCESS.steps.flatMap((s) => ("steps" in s ? s.steps : []))];
  return found.find((s) => s.id === id) as Step;
};

describe("what the frame starts and ends with", () => {
  it("an agent's workflow starts when any of its triggers fires, and gives nothing back", () => {
    expect(agentEnds(PROCESS)).toEqual({
      start: { title: "Starts when", lines: ["On a schedule", "Started by hand"] },
      givesBack: null,
    });
    expect(agentEnds({ triggers: [] }).start).toBeNull();
  });

  it("a For each starts with its list and gives back its count and what its steps keep", () => {
    const loop = step("each") as Extract<Step, { kind: "for_each" }>;
    const ends = loopEnds(loop, PROCESS, {}, (s) =>
      s.id === "fix"
        ? ["Reads bills in Testkit", "Changes bills in Testkit"]
        : ["Reads documents", "Saves nothing; kept in this run only"],
    );
    expect(ends.start).toEqual({
      title: "Runs once per item",
      lines: ["For each item of Read the invoice · lines"],
    });
    // What it reads stays in the run; what it changes outlasts it.
    expect(ends.givesBack).toEqual({
      title: "Gives back",
      lines: ["How many items it ran for", "Changes bills in Testkit"],
    });
  });

  it("a Repeat starts with its rule and gives back its passes and its last pass by step", () => {
    const loop = step("again") as Extract<Step, { kind: "repeat" }>;
    const ends = loopEnds(loop, PROCESS, {});
    expect(ends.start).toEqual({
      title: "Up to 3 times",
      lines: ["Repeat until Add it up · ok = true"],
    });
    expect(ends.givesBack?.lines).toEqual([
      "How many passes it took",
      "Whether it finished before its limit",
      "The last pass of “Add it up”",
    ]);
  });

  it("opens a loop's own steps, and names a place in them as the whole workflow does", () => {
    const open = loopProcess(PROCESS, "each");
    expect(open?.view.steps.map((s) => s.id)).toEqual(["price", "fix"]);
    expect(open?.view.triggers).toEqual([]);
    expect(loopProcess(PROCESS, "read")).toBeNull();
    expect(hostPoint("each", { container: "root", index: 1 })).toEqual({
      container: "loop:each",
      index: 1,
    });
    // A path inside the loop keeps its own name; so does everything in the whole flow.
    expect(hostPoint("each", { container: "path:x", index: 0 }).container).toBe("path:x");
    expect(hostPoint(null, { container: "root", index: 2 }).container).toBe("root");
  });

  it("says where a new step would go", () => {
    expect(placeWords(PROCESS, { container: "root", index: 1 })).toBe("before “Each line”");
    expect(placeWords(PROCESS, { container: "root", index: 5 })).toBe("at the end");
    expect(placeWords(PROCESS, { container: "path:big", index: 0 })).toBe("to “Big change”");
    expect(placeWords(PROCESS, { container: "otherwise:else", index: 0 })).toBe(
      "to “Otherwise” in Big?",
    );
    expect(placeWords(PROCESS, { container: "loop:each", index: 2 })).toBe("inside “Each line”");
    expect(placeWords(PROCESS, { container: "loop:each", index: 1 })).toBe("before “Fix the line”");
  });
});

describe("a step's words on the chart", () => {
  const env = (over: Partial<ApprovalEnv> = {}): ApprovalEnv => ({
    ctx: { tools: { [update.id]: update } },
    agentKind: "client",
    mode: "act",
    matrices: { testkit: { read: "auto", create: "approval", update: "auto", delete: "off" } },
    connectorName: () => "Testkit",
    ...over,
  });
  const labels = { connector: () => "Testkit", writeLabel: () => "Change in Testkit" };

  it("says whether a write waits for approval for this agent, whatever the step asks", () => {
    const fix = step("fix");
    expect(chartLabel(labels, env())(fix)).toEqual({
      title: "Fix the line",
      kind: "Change in Testkit",
      detail: "Testkit · Update a record · needs approval",
    });
    const loosened = {
      ...fix,
      checks: { approval: { required: "not_required" } },
    } as unknown as Step;
    expect(chartLabel(labels, env())(loosened).detail).toBe(
      "Testkit · Update a record · on its own",
    );
    // A template keeps approval on: the step's own "on its own" isn't what will happen.
    expect(chartLabel(labels, env({ agentKind: "template" }))(loosened).detail).toBe(
      "Testkit · Update a record · needs approval",
    );
  });

  it("adds what the step's checks add, and names an untitled step by its kind", () => {
    const checked = {
      ...step("read"),
      name: " ",
      checks: {
        confer: { with: [{ person: "lead" }] },
        notify: [{ to: ["lead"], channel: "inbox", message: "x", urgent: { ackWithin: "1 hour" } }],
      },
    } as unknown as Step;
    const words = chartLabel({}, env())(checked);
    expect(words.title).toBe("Read");
    expect(words.detail).toContain("Checked with a person · Urgent notice");
  });

  it("says whether a model does the step and which, for the chart's details", () => {
    const skill = { id: "s", name: "Read the request", kind: "skill", skill: "read-request" };
    const words = chartLabel(
      { skillKind: () => "ai", stepModel: () => "claude-sonnet-5-5" },
      env(),
    )(skill as unknown as Step);
    expect(words.kind).toBe("Skill · AI");
    expect(words.skillKind).toBe("AI");
    expect(words.model).toBe("claude-sonnet-5-5");
    // A step that runs no model has neither.
    const plain = chartLabel(labels, env())(step("fix"));
    expect(plain.skillKind).toBeUndefined();
    expect(plain.model).toBeUndefined();
  });

  it("carries the connector a step is on, for the mark on its box", () => {
    const on = chartLabel(
      { ...labels, connectorOf: () => ({ id: "testkit", name: "Testkit" }) },
      env(),
    )(step("fix"));
    expect(on.connector).toEqual({ id: "testkit", name: "Testkit" });
    expect(chartLabel(labels, env())(step("fix")).connector).toBeUndefined();
  });
});

describe("the statuses the builder adds", () => {
  const request = (over: Partial<StepCodeRequest["request"]>): StepCodeRequest => ({
    buildId: "b1",
    workflowId: "monthly",
    stepId: "m1",
    request: {
      id: "r1",
      ref: "DQ-012",
      title: "Add date offsets to Reshape data",
      status: "in_progress",
      inReview: false,
      shippedStagingAt: null,
      ...over,
    },
  });
  const base = buildStatuses({ process: PROCESS });
  const item = (requests: StepCodeRequest[], workflow?: string) =>
    withCodeRequests(base, requests, workflow).get("m1")?.items[0];

  it("shows a step's Dev queue request in place of 'missing', with where to open it", () => {
    expect(item([])).toMatchObject({ title: "Nothing in the library does this yet" });
    expect(item([request({})], "monthly")).toMatchObject({
      key: "missing:m1",
      level: "issue",
      title: "Requires code · DQ-012 · In progress",
      detail: "Add date offsets to Reshape data",
      refId: "DQ-012",
    });
    expect(devQueuePath("DQ-012")).toBe("/ops/utilities/feedback?tab=dev-queue&request=DQ-012");
    // Nothing else on the chart changes.
    expect(withCodeRequests(base, [request({})]).get("read")).toBe(base.get("read"));
  });

  it("says In review with a PR, and asks for the swap once shipped", () => {
    expect(item([request({ inReview: true })])?.title).toBe("Requires code · DQ-012 · In review");
    const shipped = item([request({ status: "shipped" })]);
    expect(shipped?.title).toBe("Requires code · DQ-012 · Shipped");
    expect(shipped?.detail).toMatch(/put it in this step/);
    // Another workflow's step of the same id isn't this one; a closed request no longer holds it.
    expect(item([request({})], "other")?.title).toBe("Nothing in the library does this yet");
    expect(item([request({ status: "closed" })])?.title).toBe(
      "Nothing in the library does this yet",
    );
  });
});
