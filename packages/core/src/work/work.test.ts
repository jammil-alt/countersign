import { describe, expect, it } from "vitest";
import { defaultBusinessHours } from "../process/hours";
import { buildPipelineStage } from "./build-stage";
import { readHold } from "./hold";
import { isLate, passesFilter, standingOf } from "./standing";
import { issueTargets } from "./targets";
import { type WorkOrderInput, workOrder } from "./work-order";

describe("issue targets", () => {
  // Tuesday 2026-11-17, 10:00 in Chicago (16:00 UTC); the default week is Monday to Friday.
  const hours = defaultBusinessHours("America/Chicago");
  const at = new Date("2026-11-17T16:00:00Z");

  it("critical: reply within a clock hour, fix by the end of the client's day", () => {
    const t = issueTargets("critical", at, hours);
    expect(t.replyBy.toISOString()).toBe("2026-11-17T17:00:00.000Z");
    // Midnight in Chicago is 06:00 UTC.
    expect(t.fixBy.toISOString()).toBe("2026-11-18T05:59:59.999Z");
  });

  it("high: 4 business hours and 2 business days", () => {
    const t = issueTargets("high", at, hours);
    expect(t.replyBy.toISOString()).toBe("2026-11-17T20:00:00.000Z");
    expect(t.fixBy.toISOString()).toBe("2026-11-19T16:00:00.000Z");
  });

  it("normal: a business day for both; low: 1 and 2", () => {
    const n = issueTargets("normal", at, hours);
    expect(n.replyBy.toISOString()).toBe("2026-11-18T16:00:00.000Z");
    expect(n.fixBy.toISOString()).toBe("2026-11-18T16:00:00.000Z");
    const l = issueTargets("low", at, hours);
    expect(l.replyBy.toISOString()).toBe("2026-11-18T16:00:00.000Z");
    expect(l.fixBy.toISOString()).toBe("2026-11-19T16:00:00.000Z");
  });

  it("skips the weekend for business days", () => {
    const friday = new Date("2026-11-20T16:00:00Z");
    expect(issueTargets("normal", friday, hours).fixBy.toISOString()).toBe(
      "2026-11-23T16:00:00.000Z",
    );
  });
});

describe("standing and filters", () => {
  it("reads where an item stands", () => {
    expect(standingOf({ doneish: true, waitingOn: "operator", stuck: true })).toBe("done");
    expect(standingOf({ doneish: false, waitingOn: "reggie", stuck: false, held: true })).toBe(
      "stalled",
    );
    expect(standingOf({ doneish: false, waitingOn: "reggie", stuck: false })).toBe("agent");
    expect(standingOf({ doneish: false, waitingOn: "client", stuck: false })).toBe("client");
    expect(standingOf({ doneish: false, waitingOn: "operator", stuck: false })).toBe("you");
  });

  it("is late only when open and past the date", () => {
    expect(isLate("2026-11-16", "you", "2026-11-17")).toBe(true);
    expect(isLate("2026-11-16T10:00:00Z", "done", "2026-11-17")).toBe(false);
    expect(isLate("2026-11-17", "you", "2026-11-17")).toBe(false);
    expect(isLate(null, "you", "2026-11-17")).toBe(false);
    expect(
      passesFilter("critical", { standing: "you", due: null, urgency: "high" }, "2026-11-17"),
    ).toBe(true);
  });
});

describe("the work order", () => {
  const today = "2026-11-17";
  // The prototype's Build items (docs/design/pipelines.html, WORK).
  const items: WorkOrderInput[] = [
    {
      kind: "enhancement",
      id: "e-dark",
      decision: "later",
      asks: 3,
      decideBy: null,
      manualRank: null,
    },
    {
      kind: "enhancement",
      id: "e-two",
      decision: null,
      asks: 1,
      decideBy: "2026-11-18",
      manualRank: null,
    },
    {
      kind: "enhancement",
      id: "e-pdf",
      decision: null,
      asks: 4,
      decideBy: "2026-11-19",
      manualRank: null,
    },
    {
      kind: "enhancement",
      id: "e-fuel",
      decision: "do",
      asks: 1,
      decideBy: "2026-11-20",
      manualRank: null,
    },
    { kind: "enhancement", id: "e-no", decision: "no", asks: 9, decideBy: null, manualRank: null },
    { kind: "build", id: "b-alder-book", promisedOn: null, openItems: 2, manualRank: null },
    { kind: "build", id: "b-pine", promisedOn: "2026-12-12", openItems: 4, manualRank: null },
    { kind: "build", id: "b-hart", promisedOn: "2026-12-01", openItems: 1, manualRank: null },
    { kind: "build", id: "b-coast", promisedOn: "2026-11-24", openItems: 3, manualRank: null },
    { kind: "build", id: "b-north", promisedOn: "2026-11-28", openItems: 1, manualRank: null },
    {
      kind: "issue",
      id: "i-1047",
      urgency: "low",
      createdAt: "2026-11-16T09:00:00Z",
      fixBy: "2026-11-20",
      manualRank: null,
    },
    {
      kind: "issue",
      id: "i-1039",
      urgency: "normal",
      createdAt: "2026-11-12T09:00:00Z",
      fixBy: "2026-11-18",
      manualRank: null,
    },
    {
      kind: "issue",
      id: "i-1044",
      urgency: "normal",
      createdAt: "2026-11-15T09:00:00Z",
      fixBy: "2026-11-19",
      manualRank: null,
    },
    {
      kind: "issue",
      id: "i-1045",
      urgency: "normal",
      createdAt: "2026-11-14T09:00:00Z",
      fixBy: "2026-11-16",
      manualRank: null,
    },
    {
      kind: "issue",
      id: "i-1042",
      urgency: "high",
      createdAt: "2026-11-17T08:12:00Z",
      fixBy: "2026-11-18",
      manualRank: null,
    },
    {
      kind: "issue",
      id: "i-1051",
      urgency: "critical",
      createdAt: "2026-11-17T06:12:00Z",
      fixBy: "2026-11-17",
      manualRank: null,
    },
  ];

  it("puts critical first, then high, a build at risk, the other issues, builds, enhancements", () => {
    const order = workOrder(items, today);
    expect(order.map((o) => o.id)).toEqual([
      "i-1051",
      "i-1042",
      "b-coast",
      "i-1045",
      "i-1039",
      "i-1044",
      "i-1047",
      "b-north",
      "b-hart",
      "b-pine",
      "b-alder-book",
      "e-pdf",
      "e-two",
      "e-fuel",
      "e-dark",
    ]);
    expect(order.map((o) => o.rank)).toEqual(order.map((_, n) => n + 1));
    const why = (id: string) => order.find((o) => o.id === id);
    expect(why("i-1051")?.why).toBe("Critical: ahead of everything.");
    expect(why("i-1042")?.why).toBe("High issues go before builds.");
    expect(why("b-coast")).toMatchObject({ moved: true });
    expect(why("b-coast")?.why).toMatch(
      /^Moved up: after the normal issues it would land Nov \d+, past the promised Nov 24\.$/,
    );
    expect(why("i-1045")?.why).toBe("Late: a normal issue.");
    expect(why("i-1047")?.why).toBe("Low: no promised date is at risk after it.");
    expect(why("b-hart")?.why).toBe("On track.");
    expect(why("b-alder-book")?.why).toBe("No date yet: after dated builds.");
    expect(why("e-pdf")?.why).toBe("Enhancements after builds, most-asked first: 4 clients.");
    expect(why("e-dark")?.why).toBe("Decided later.");
    expect(order.some((o) => o.id === "e-no")).toBe(false);
  });

  it("keeps a build on track behind the issues when its date allows", () => {
    const order = workOrder(
      items.map((i) => (i.id === "b-coast" ? { ...i, promisedOn: "2027-01-30" } : i)),
      today,
    );
    expect(order.find((o) => o.id === "b-coast")).toMatchObject({ moved: false, why: "On track." });
    expect(order.findIndex((o) => o.id === "b-coast")).toBeGreaterThan(
      order.findIndex((o) => o.id === "i-1047"),
    );
  });

  it("places the operator's moves at their position", () => {
    const order = workOrder(
      items.map((i) => (i.id === "e-two" ? { ...i, manualRank: 1 } : i)),
      today,
    );
    expect(order[0]).toMatchObject({ id: "e-two", manual: true, why: "Moved by you.", rank: 1 });
    expect(order[1]?.id).toBe("i-1051");
  });
});

describe("builds in the pipeline", () => {
  const base = {
    status: "open" as const,
    path: "template" as const,
    phase: "intake" as const,
    agentStage: null,
    requirements: null,
    missingConnections: 0,
  };
  it("derives the stage", () => {
    expect(buildPipelineStage({ ...base, status: "live" })).toBe("live");
    expect(buildPipelineStage({ ...base, requirements: { answered: 7, total: 12 } })).toBe(
      "requirements",
    );
    expect(buildPipelineStage({ ...base, path: "new" })).toBe("building");
    expect(buildPipelineStage({ ...base, missingConnections: 1 })).toBe("connect");
    expect(buildPipelineStage({ ...base, agentStage: "trial" })).toBe("trial");
    expect(buildPipelineStage({ ...base, agentStage: "signoff" })).toBe("signoff");
    expect(buildPipelineStage({ ...base, agentStage: "bench" })).toBe("bench");
    expect(buildPipelineStage({ ...base, agentStage: "live" })).toBe("live");
  });
});

describe("the hold", () => {
  it("reads a stored hold, and a malformed one as held", () => {
    expect(readHold(null)).toBeNull();
    const h = { issueId: "i", by: "reggie", userId: null, at: "2026-11-17T06:12:00Z", reason: "x" };
    expect(readHold(h)).toEqual(h);
    expect(readHold({ nonsense: true })).not.toBeNull();
  });
});
