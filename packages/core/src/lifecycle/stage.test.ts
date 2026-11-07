import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locale";
import { decideToolCall } from "../permissions/decide";
import {
  DEFAULT_TRIAL_MIN_DAYS,
  DEFAULT_TRIAL_MIN_RUNS,
  effectiveMode,
  goLiveCounts,
  goLiveItem,
  isLiveAgent,
  nextStage,
  readStageState,
  stageMove,
  stagesPassed,
  startTrial,
  trialProgress,
} from "./stage";

const acting = { permissions: { mode: "act" as const } };
const suggesting = { permissions: { mode: "suggest_only" as const } };

describe("effectiveMode", () => {
  it.each([
    ["bench", "suggest_only"],
    ["trial", "suggest_only"],
    ["signoff", "suggest_only"],
    ["live", "act"],
    [null, "suggest_only"],
    [undefined, "suggest_only"],
    ["something else", "suggest_only"],
  ] as const)("an acting agent at %s acts as %s", (stage, mode) => {
    expect(effectiveMode(acting, stage)).toBe(mode);
  });

  it("never loosens a suggesting agent", () => {
    for (const stage of ["bench", "trial", "signoff", "live"] as const) {
      expect(effectiveMode(suggesting, stage)).toBe("suggest_only");
    }
  });

  it("makes the gate ask for a signature in trial and signoff, whatever the step and matrix say", () => {
    const decide = (stage: string) =>
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix: { create: "auto" },
        stepApproval: "not_required",
        agentMode: effectiveMode(acting, stage),
      });
    expect(decide("trial")).toBe("approval");
    expect(decide("signoff")).toBe("approval");
    expect(decide("bench")).toBe("approval");
    expect(decide("live")).toBe("run");
  });

  it("leaves `off` refused at every stage", () => {
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix: { create: "off" },
        stepApproval: "not_required",
        agentMode: effectiveMode(acting, "trial"),
      }),
    ).toBe("refused");
  });
});

describe("stage moves", () => {
  it("names each move", () => {
    expect(stageMove("bench", "trial")).toBe("forward");
    expect(stageMove("trial", "signoff")).toBe("forward");
    expect(stageMove("bench", "live")).toBe("skip");
    expect(stageMove("trial", "live")).toBe("skip");
    expect(stageMove("live", "trial")).toBe("back");
    expect(stageMove("signoff", "signoff")).toBe("same");
  });

  it("lists the stages a skip passes over", () => {
    expect(stagesPassed("bench", "live")).toEqual(["trial", "signoff"]);
    expect(stagesPassed("trial", "live")).toEqual(["signoff"]);
    expect(stagesPassed("trial", "signoff")).toEqual([]);
    expect(stagesPassed("live", "bench")).toEqual([]);
  });

  it("knows the next stage", () => {
    expect(nextStage("bench")).toBe("trial");
    expect(nextStage("signoff")).toBe("live");
    expect(nextStage("live")).toBeNull();
  });
});

describe("trials", () => {
  const start = new Date("2026-11-01T10:00:00Z");

  it("start with 14 days and 25 runs", () => {
    expect(startTrial(start, "u1")).toEqual({
      startedAt: start.toISOString(),
      minDays: DEFAULT_TRIAL_MIN_DAYS,
      minRuns: DEFAULT_TRIAL_MIN_RUNS,
      setBy: "u1",
    });
    expect(DEFAULT_TRIAL_MIN_DAYS).toBe(14);
    expect(DEFAULT_TRIAL_MIN_RUNS).toBe(25);
  });

  it("keep the operator's minimums when they restart", () => {
    const t = startTrial(new Date("2026-12-01T00:00:00Z"), null, { minDays: 3, minRuns: 5 });
    expect(t.minDays).toBe(3);
    expect(t.minRuns).toBe(5);
  });

  it("are ready only when both minimums are met, whichever comes later", () => {
    const trial = startTrial(start, null);
    const day13 = new Date(start.getTime() + 13 * 86_400_000);
    const day14 = new Date(start.getTime() + 14 * 86_400_000);
    expect(trialProgress(trial, 100, day13).ready).toBe(false);
    expect(trialProgress(trial, 24, day14).ready).toBe(false);
    expect(trialProgress(trial, 25, day14).ready).toBe(true);
    const p = trialProgress(trial, 25, day13);
    expect(p.days).toBe(13);
    expect(p.daysMetAt).toBe(day14.toISOString());
  });

  it("can be shortened to nothing by the operator", () => {
    const trial = { ...startTrial(start, null), minDays: 0, minRuns: 0 };
    expect(trialProgress(trial, 0, start).ready).toBe(true);
  });
});

describe("stage state", () => {
  it("reads what doesn't parse as empty, and keeps unknown keys", () => {
    expect(readStageState(null)).toEqual({});
    expect(readStageState({ trial: { startedAt: 3 } })).toEqual({});
    expect(readStageState({ later: 1 })).toEqual({ later: 1 });
  });

  it("words the go-live item in every language, counts only", () => {
    const summary = {
      trialStartedAt: "x",
      runs: 26,
      succeeded: 25,
      failed: 1,
      changesMade: 12,
      signed: 13,
      rejected: 1,
    };
    const en = goLiveItem("Bill clerk", summary);
    expect(en.title).toBe("Bill clerk going live");
    expect(en.text).toBe(
      "In its trial: 26 runs (1 failed), 12 changes made, 13 approved, 1 rejected.",
    );
    for (const locale of LOCALES) {
      const w = goLiveItem("Bill clerk", summary, locale);
      expect(w.title).toContain("Bill clerk");
      expect(w.text).toContain("26");
      expect(w.ask.length).toBeGreaterThan(10);
    }
  });
});

describe("live, one meaning (design pass)", () => {
  it("is switched on and at the live stage; trial, sign-off and the bench are not live", () => {
    expect(isLiveAgent({ runStatus: "active", stage: "live" })).toBe(true);
    expect(isLiveAgent({ runStatus: "active", stage: "trial" })).toBe(false);
    expect(isLiveAgent({ runStatus: "active", stage: "bench" })).toBe(false);
    expect(isLiveAgent({ runStatus: "paused", stage: "live" })).toBe(false);
    expect(isLiveAgent({ runStatus: "active", stage: null })).toBe(false);
  });

  it("counts switched-on agents by stage, no stage as the bench", () => {
    expect(
      goLiveCounts([
        { runStatus: "active", stage: "live" },
        { runStatus: "active", stage: "trial" },
        { runStatus: "active", stage: "trial" },
        { runStatus: "active", stage: null },
        { runStatus: "draft", stage: "bench" },
        { runStatus: "paused", stage: "live" },
      ]),
    ).toEqual({ bench: 1, trial: 2, signoff: 0, live: 1 });
  });
});
