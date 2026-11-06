import { describe, expect, it } from "vitest";
import type { AgentBundle } from "../schemas/agent";
import type { Step } from "../schemas/workflow";
import { bundle, edit } from "../testing/fixtures";
import {
  bundleFeatures,
  bundleSimilarity,
  closestBundles,
  jaccard,
  SIMILARITY_WEIGHTS,
  sequenceScore,
} from "./similarity";

const steps = (b: AgentBundle) => b.workflows[0]?.workflow.steps as Step[];

describe("bundleSimilarity", () => {
  it("reads skills, tools, trigger kinds and the step-kind sequence", () => {
    expect(bundleFeatures(bundle())).toEqual({
      skills: ["docs.extract", "test.itemize", "test.summarize"],
      tools: ["qbo.attachable.upload"],
      triggers: ["event"],
      steps: ["skill", "fork", "person", "notify", "for_each", "skill", "action"],
    });
  });

  it("is 1 for the same bundle and the weights sum to 1", () => {
    expect(bundleSimilarity(bundle(), bundle())).toEqual({
      score: 1,
      skills: 1,
      tools: 1,
      triggers: 1,
      steps: 1,
    });
    const w = SIMILARITY_WEIGHTS;
    expect(w.skills + w.tools + w.triggers + w.steps).toBeCloseTo(1, 10);
  });

  it("weights each part 0.4, 0.3, 0.1 and 0.2", () => {
    const a = bundle();
    // One skill of three dropped, a different trigger kind, the last step gone.
    const b = edit(a, (d) => {
      d.definition.skills = d.definition.skills.filter((s) => s.skill !== "test.summarize");
      const list = steps(d);
      const loop = list[2] as Extract<Step, { kind: "for_each" }>;
      loop.steps = [];
      (d.workflows[0] as AgentBundle["workflows"][number]).workflow.trigger.on = {
        type: "schedule",
        cron: "0 9 * * 1",
      };
    });
    const s = bundleSimilarity(a, b);
    expect(s.skills).toBeCloseTo(2 / 3, 4);
    expect(s.tools).toBe(1);
    expect(s.triggers).toBe(0);
    expect(s.steps).toBeCloseTo((2 * 6) / 13, 4);
    expect(s.score).toBeCloseTo(0.4 * (2 / 3) + 0.3 + 0 + 0.2 * (12 / 13), 4);
  });

  it("is symmetric and deterministic", () => {
    const a = bundle();
    const b = edit(a, (d) => {
      steps(d).reverse();
      d.definition.extraTools = ["qbo.bill.query"];
    });
    const first = bundleSimilarity(a, b);
    for (let i = 0; i < 5; i++) {
      expect(bundleSimilarity(a, b)).toEqual(first);
      expect(bundleSimilarity(b, a)).toEqual(first);
    }
  });

  it("treats two empty parts as agreeing", () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a"], [])).toBe(0);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 10);
    expect(sequenceScore([], [])).toBe(1);
    expect(sequenceScore(["skill"], [])).toBe(0);
  });

  it("ranks candidates best first, ties by key", () => {
    const a = bundle();
    const far = edit(a, (d) => {
      d.definition.skills = [];
      d.definition.extraTools = [];
      (d.workflows[0] as AgentBundle["workflows"][number]).workflow.steps = [];
    });
    const ranked = closestBundles(
      a,
      [
        { key: "z-same", bundle: a },
        { key: "far", bundle: far },
        { key: "a-same", bundle: a },
      ],
      { limit: 2 },
    );
    expect(ranked.map((r) => r.key)).toEqual(["a-same", "z-same"]);
    expect(closestBundles(a, [{ key: "far", bundle: far }], { min: 0.5 })).toEqual([]);
  });
});
