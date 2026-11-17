import { describe, expect, it } from "vitest";
import {
  DEAL_WANT_WORDS,
  type DealStanding,
  dealIsLate,
  dealPasses,
  dealStanding,
  dealStatusText,
  dealWants,
  isDealStage,
  isRenewal,
  SALES_PIPELINES,
  type SalesFigureInput,
  salesFigures,
  skippedStages,
  stagesBefore,
  weightedMrr,
  wholeMoney,
} from "./deals";

const TODAY = "2026-11-17";

describe("Sales stages", () => {
  it("are the prototype's, with their likelihood", () => {
    expect(SALES_PIPELINES.new.stages.map((s) => [s.name, s.p])).toEqual([
      ["Lead", "0.1"],
      ["Qualified", "0.25"],
      ["Diagnostic", "0.4"],
      ["Proposal and contract", "0.6"],
      ["Set up the account", "0.9"],
      ["First agent live", "1"],
    ]);
    expect(SALES_PIPELINES.grow.stages.map((s) => s.name)).toEqual([
      "Spotted",
      "Pitch",
      "Offered",
      "Agreed",
      "Live and billed",
    ]);
    expect(isDealStage("new", "lead")).toBe(true);
    expect(isDealStage("new", "pitch")).toBe(false);
    expect(isDealStage("expansion", "billed")).toBe(true);
  });

  it("weights a month's value by its stage, in decimals", () => {
    expect(weightedMrr("new", "lead", "2400")).toBe("240.0000");
    expect(weightedMrr("new", "qualified", "1800.10")).toBe("450.0250");
    expect(weightedMrr("expansion", "agreed", "900")).toBe("810.0000");
  });
});

describe("where a deal stands", () => {
  it("is done once closed, stalled when stuck or held, else whoever has it", () => {
    const base = {
      outcome: "open" as const,
      waitingOn: "operator" as const,
      stuck: false,
      held: false,
    };
    expect(dealStanding(base)).toBe("you");
    expect(dealStanding({ ...base, waitingOn: "reggie" })).toBe("agent");
    expect(dealStanding({ ...base, waitingOn: "client" })).toBe("client");
    expect(dealStanding({ ...base, stuck: true })).toBe("stalled");
    expect(dealStanding({ ...base, held: true })).toBe("stalled");
    expect(dealStanding({ ...base, outcome: "lost", held: true })).toBe("done");
  });

  it("says it in words", () => {
    const at = { outcome: "open" as const, wonAt: null, closedAt: null };
    expect(
      dealStatusText({
        ...at,
        standing: "stalled",
        statusLine: "",
        held: { reason: "Held: critical issue" },
      }),
    ).toBe("Held: critical issue");
    expect(dealStatusText({ ...at, standing: "you", statusLine: "Pricing", held: null })).toBe(
      "Pricing",
    );
    expect(
      dealStatusText({
        standing: "done",
        statusLine: "",
        held: null,
        outcome: "won",
        wonAt: "2026-11-03T10:00:00.000Z",
        closedAt: null,
      }),
    ).toBe("Won Nov 3");
  });

  it("is late when an open deal's next step was due before today", () => {
    expect(dealIsLate({ nextDueOn: "2026-11-15", standing: "stalled" }, TODAY)).toBe(true);
    expect(dealIsLate({ nextDueOn: "2026-11-17", standing: "you" }, TODAY)).toBe(false);
    expect(dealIsLate({ nextDueOn: "2026-11-15", standing: "done" }, TODAY)).toBe(false);
    expect(dealIsLate({ nextDueOn: null, standing: "you" }, TODAY)).toBe(false);
    expect(dealPasses("late", { nextDueOn: "2026-11-15", standing: "client" }, TODAY)).toBe(true);
    expect(dealPasses("stuck", { nextDueOn: null, standing: "stalled" }, TODAY)).toBe(true);
  });

  it("reads a renewal as a renewal", () => {
    expect(isRenewal({ kind: "expansion", title: "Renewal, 12 months" })).toBe(true);
    expect(isRenewal({ kind: "new", title: "Renewal, 12 months" })).toBe(false);
    expect(isRenewal({ kind: "expansion", title: "Bookkeeper" })).toBe(false);
  });
});

describe("the Sales figures", () => {
  const deal = (
    over: Partial<SalesFigureInput> & { standing: DealStanding },
  ): SalesFigureInput => ({
    kind: "new",
    stage: "lead",
    mrr: "1000",
    agreedMrr: null,
    agentCount: 1,
    outcome: "open",
    nextDueOn: null,
    wonAt: null,
    ...over,
  });

  it("add up as the prototype's KPIs", () => {
    const f = salesFigures(
      [
        deal({ standing: "you", mrr: "2400", agentCount: 2, nextDueOn: "2026-11-17" }),
        deal({ standing: "stalled", stage: "diagnostic", mrr: "2000", nextDueOn: "2026-11-15" }),
        deal({
          standing: "client",
          kind: "expansion",
          stage: "offered",
          mrr: "2800",
          agentCount: 0,
        }),
        deal({
          standing: "done",
          stage: "live",
          mrr: "2200",
          outcome: "won",
          agreedMrr: "2100",
          wonAt: "2026-11-03T10:00:00.000Z",
        }),
        deal({ standing: "done", outcome: "won", wonAt: "2026-10-03T10:00:00.000Z" }),
      ],
      TODAY,
    );
    expect(f).toEqual({
      potential: "7200.0000",
      weighted: "2720.0000",
      open: 3,
      openNew: 2,
      openExpansion: 1,
      agentsInPlay: 3,
      needYou: 1,
      lateOrStuck: 1,
      late: 1,
      wonThisMonth: "2100.0000",
      wonCount: 1,
    });
  });

  it("shows money in whole dollars", () => {
    expect(wholeMoney("2400.0000")).toBe("$2,400");
    expect(wholeMoney("1234567.5")).toBe("$1,234,568");
    expect(wholeMoney("12", "EUR")).toBe("12 EUR");
  });
});

describe("stages as a record, not a gate (§1.149)", () => {
  it("names the stages a forward move skips, none going back or one step on", () => {
    expect(skippedStages("new", "lead", "setup")).toEqual(["qualified", "diagnostic", "proposal"]);
    expect(skippedStages("new", "lead", "qualified")).toEqual([]);
    expect(skippedStages("new", "setup", "lead")).toEqual([]);
    expect(skippedStages("expansion", "spotted", "agreed")).toEqual(["pitch", "offered"]);
    expect(stagesBefore("new", "setup")).toEqual(["lead", "qualified", "diagnostic", "proposal"]);
    expect(stagesBefore("new", "lead")).toEqual([]);
  });

  it("wants the price and the signed copy from Set up the account, the price from Agreed", () => {
    const none = { agreedMrr: null, hasSignedCopy: false };
    expect(dealWants({ ...none, kind: "new", stage: "proposal" })).toEqual([]);
    expect(dealWants({ ...none, kind: "new", stage: "setup" })).toEqual(["price", "signed_copy"]);
    expect(
      dealWants({ kind: "new", stage: "live", agreedMrr: "10.0000", hasSignedCopy: true }),
    ).toEqual([]);
    expect(dealWants({ ...none, kind: "expansion", stage: "offered" })).toEqual([]);
    expect(dealWants({ ...none, kind: "expansion", stage: "agreed" })).toEqual(["price"]);
    expect(dealWants({ ...none, kind: "new", stage: "lead", nothingChosen: true })).toEqual([
      "start",
    ]);
    expect(DEAL_WANT_WORDS.start("Acme")).toBe("What are we starting with for Acme?");
  });
});
