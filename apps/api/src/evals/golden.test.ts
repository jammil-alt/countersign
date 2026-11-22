// docs/plan.md §1.212: the golden datasets, replayed. Every case of every workflow's dataset runs
// as a test run of its template's live version on a client of its own, and must make exactly its
// writes. A pull request that changes a skill, a tool or a template runs this (CI tests every
// package a change reaches, and apps/api depends on them all), so a change that makes a workflow
// worse fails here before it reaches a client.

import { writeFileSync } from "node:fs";
import { evalScorecard } from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  createEvalHarness,
  type GoldenResult,
  loadDatasets,
  runGoldenCase,
} from "./golden.test-helper";

const h = await createEvalHarness();
afterAll(() => h?.close());

const PROBE = process.env.EVAL_PROBE;

describe.skipIf(!h)("the golden datasets", () => {
  for (const { dataset } of loadDatasets()) {
    it(`${dataset.template}/${dataset.workflow}: every case makes exactly its writes`, async () => {
      if (!h) return;
      const results: GoldenResult[] = [];
      for (const c of dataset.cases) results.push(await runGoldenCase(h, dataset, c));
      if (PROBE) {
        writeFileSync(`${PROBE}/${dataset.template}.json`, JSON.stringify(results, null, 1));
      }
      const failing = results
        .filter((r) => r.status !== "pass")
        .map((r) => ({ case: r.caseId, error: r.error, score: r.score, steps: r.steps }));
      expect(failing, JSON.stringify(failing, null, 1).slice(0, 20_000)).toEqual([]);
      const card = evalScorecard(results);
      expect(card.exactRate).toBe(1);
    }, 600_000);
  }
});
