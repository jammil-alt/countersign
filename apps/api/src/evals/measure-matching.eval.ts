// Measures the Match engine's settings with the real model (docs/step-model-plan.md §13 item 10);
// the logic is in ./measure-matching.ts. By hand only: it calls the model (a few dollars a run) and
// never runs in `pnpm test`. It needs LLM_MODE=live and ANTHROPIC_API_KEY, which the "Model runs"
// workflow (.github/workflows/model-runs.yml) sets; the cases are made up (docs/plan.md §1.35).
//
//   LLM_MODE=live ANTHROPIC_API_KEY=… MATCH_MEASURE_REPORT=out.md \
//     pnpm --filter @countersign/api exec vitest run --config vitest.eval.config.ts \
//     src/evals/measure-matching.eval.ts

import { writeFileSync } from "node:fs";
import { conferModel } from "@countersign/agents";
import {
  Decimal,
  PROFILE_CHOICE_TOOL,
  type ProfileChooser,
  profileChoiceMessages,
} from "@countersign/core";
import {
  anthropicTransport,
  createLlmClient,
  DEFAULT_MODELS,
  type LlmClient,
  type ModelId,
} from "@countersign/llm";
import { describe, expect, it } from "vitest";
import {
  crmSet,
  type Deciders,
  materialsSet,
  type Result,
  renderReport,
  runSetting,
  type Spend,
  settingsGrid,
} from "./measure-matching";

const key = process.env.ANTHROPIC_API_KEY;
const live = process.env.LLM_MODE === "live" && !!key;
const model = (process.env.MATCH_MEASURE_MODEL || DEFAULT_MODELS.reasoning) as ModelId;
const reportPath = process.env.MATCH_MEASURE_REPORT;

interface Answer {
  value: unknown;
  input: number;
  output: number;
  cost: string | null;
}

/**
 * A model asked once per question: a question is the same for every threshold and floor, so each is
 * asked once and every setting that reaches it is charged what it cost.
 */
function memoChooser(
  llm: LlmClient,
  id: ModelId,
  cache: Map<string, Promise<Answer>>,
  spend: Spend,
): ProfileChooser {
  return async (q) => {
    const k = JSON.stringify([id, q.purpose, q.profile.id, q.item, q.candidates.map((c) => c.id)]);
    let at = cache.get(k);
    if (!at) {
      const m = profileChoiceMessages(q);
      at = llm
        .callTool({
          model: id,
          maxTokens: 1024,
          system: m.system,
          messages: [{ role: "user", content: m.user }],
          tool: {
            name: PROFILE_CHOICE_TOOL.name,
            description: PROFILE_CHOICE_TOOL.description,
            schema: PROFILE_CHOICE_TOOL.schema,
          },
          label: `measure-matching:${q.purpose}`,
        })
        .then((r) => ({
          value: r.value,
          input: r.record.usage.inputTokens,
          output: r.record.usage.outputTokens,
          cost: r.record.costUsd,
        }));
      cache.set(k, at);
    }
    const a = await at;
    spend.input += a.input;
    spend.output += a.output;
    if (a.cost) spend.cost = spend.cost.plus(new Decimal(a.cost));
    return a.value;
  };
}

describe.skipIf(!live)("Match settings against the goldens, with the real model", () => {
  it("measures every setting", async () => {
    const llm = createLlmClient({ transport: anthropicTransport({ apiKey: key as string }) });
    const second = conferModel({ id: model, maxTokens: 1024 }, {}).id as ModelId;
    const cache = new Map<string, Promise<Answer>>();
    const make = (spend: Spend): Deciders => ({
      choose: memoChooser(llm, model, cache, spend),
      second: memoChooser(llm, second, cache, spend),
    });
    const results: Result[] = [];
    for (const set of [materialsSet(), crmSet()]) {
      // One shortlist size at a time keeps the cache's questions together.
      for (const setting of settingsGrid()) {
        results.push(await runSetting(set, setting, make));
      }
    }
    const report = renderReport({ model, secondModel: second, results });
    console.info(report);
    if (reportPath) writeFileSync(reportPath, `${report}\n`);
    if (reportPath) writeFileSync(`${reportPath}.json`, `${JSON.stringify(results, null, 2)}\n`);
    expect(results.length).toBeGreaterThan(0);
  });
});
