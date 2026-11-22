// docs/plan.md §1.212: the golden datasets, replayed: the CI gate. Every case of every workflow's
// dataset runs as a test run of its template's live version on a client of its own, and must make
// exactly its writes. CI tests every package a change reaches, and apps/api depends on every
// package, pack and skill, so a pull request that changes a skill, a tool or a template runs the
// datasets of every workflow (and so of every workflow that uses what changed); a change that makes
// one worse fails here before it reaches a client. Below: every part of each workflow is used by
// some case, a deliberately broken skill fails its dataset, and the scorecard is what we ship.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type EvalDataset, type EvalScorecard, evalScorecard } from "@countersign/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEvalHarness,
  type GoldenResult,
  liveBundle,
  loadDatasets,
  runGoldenCase,
  stepParts,
} from "./golden.test-helper";

const h = await createEvalHarness();
afterAll(() => h?.close());

const PROBE = process.env.EVAL_PROBE;
const SCORECARD = resolve(import.meta.dirname, "golden-scorecard.json");
const WRITE_SCORECARD = process.env.WRITE_EVAL_SCORECARD === "1";

const datasets = loadDatasets().map((d) => d.dataset);
const results = new Map<string, GoldenResult[]>();
const key = (d: EvalDataset) => `${d.template}/${d.workflow}`;

async function runAll(d: EvalDataset): Promise<GoldenResult[]> {
  if (!h) return [];
  const out: GoldenResult[] = [];
  for (const c of d.cases) out.push(await runGoldenCase(h, d, c));
  return out;
}

describe.skipIf(!h)("the golden datasets", () => {
  beforeAll(async () => {
    for (const d of datasets) results.set(key(d), await runAll(d));
  }, 600_000);

  for (const d of datasets) {
    it(`${key(d)}: every case makes exactly its writes`, () => {
      const r = results.get(key(d)) ?? [];
      if (PROBE) writeFileSync(`${PROBE}/${d.template}.json`, JSON.stringify(r, null, 1));
      const failing = r
        .filter((x) => x.status !== "pass")
        .map((x) => ({ case: x.caseId, error: x.error, score: x.score, steps: x.steps }));
      expect(failing, JSON.stringify(failing, null, 1).slice(0, 20_000)).toEqual([]);
      expect(r.length).toBeGreaterThanOrEqual(30);
    });

    it(`${key(d)}: every skill and tool of the workflow is used by some case`, async () => {
      if (!h) return;
      const parts = stepParts(await liveBundle(h, d.template), d.workflow);
      const used = new Set<string>();
      for (const x of results.get(key(d)) ?? []) {
        for (const s of x.steps) {
          const part = parts.get(s.id.split(":").at(-1) ?? s.id);
          if (part && s.status === "succeeded") used.add(`${part.kind}:${part.id}`);
        }
      }
      const all = new Set([...parts.values()].map((p) => `${p.kind}:${p.id}`));
      expect([...all].filter((p) => !used.has(p)).sort()).toEqual([]);
    });
  }

  it("ships the scorecard it measures (WRITE_EVAL_SCORECARD=1 writes it)", () => {
    const card: Record<string, Omit<EvalScorecard, "msMedian" | "msP90">> = {};
    for (const d of datasets) {
      // Run time on replay says nothing about a live run: the scorecard ships without it.
      const { msMedian: _m, msP90: _p, ...rest } = evalScorecard(results.get(key(d)) ?? []);
      card[key(d)] = rest;
    }
    if (WRITE_SCORECARD) writeFileSync(SCORECARD, `${JSON.stringify(card, null, 2)}\n`);
    expect(JSON.parse(readFileSync(SCORECARD, "utf8"))).toEqual(card);
  });
});

/** Swaps a tool's run for the length of `fn`, then puts it back. */
async function withBroken(
  toolId: string,
  wrap: (output: Record<string, unknown>) => Record<string, unknown>,
  fn: () => Promise<void>,
) {
  const t = h?.platform.tools.get(toolId);
  if (!t || t.kind !== "internal") throw new Error(`no internal tool ${toolId}`);
  const tool = t.tool as { run: (input: unknown, ctx: unknown) => Promise<unknown> };
  const run = tool.run;
  tool.run = async (input, ctx) =>
    wrap((await run.call(tool, input, ctx)) as Record<string, unknown>);
  try {
    await fn();
  } finally {
    tool.run = run;
  }
}

const dataset = (template: string) => {
  const d = datasets.find((x) => x.template === template);
  if (!d) throw new Error(`no dataset for ${template}`);
  return d;
};

describe.skipIf(!h)("a deliberately broken skill fails its dataset", () => {
  it("Check matches that lets every model answer through: the vetoes and unsure lines fail", async () => {
    const d = dataset("vendor-contracts");
    let r: GoldenResult[] = [];
    await withBroken(
      "materials.matches.check",
      (out) => ({
        ...out,
        anyNeedsReview: false,
        needsReview: 0,
        lines: ((out.lines as Record<string, unknown>[]) ?? []).map((l) => ({
          ...l,
          needsReview: false,
        })),
      }),
      async () => {
        r = await runAll(d);
      },
    );
    const failed = r.filter((x) => x.status !== "pass").map((x) => x.caseId);
    expect(failed).toEqual(
      expect.arrayContaining(["model-unsure", "model-low-confidence", "model-vetoed"]),
    );
    expect(evalScorecard(r).exactRate).toBeLessThan(1);
  }, 600_000);

  it("A Bookkeeper threshold that lets every proposal through: the unsure ones fail", async () => {
    const d = dataset("bookkeeper");
    let r: GoldenResult[] = [];
    await withBroken(
      "bookkeeping.booking.propose",
      (out) => ({ ...out, status: "proposed" }),
      async () => {
        r = await runAll(d);
      },
    );
    const failed = r.filter((x) => x.status !== "pass").map((x) => x.caseId);
    expect(failed).toEqual(
      expect.arrayContaining(["model-unsure", "model-just-under", "injected-payee"]),
    );
  }, 600_000);
});
