// The Builder's test cases against the real model (docs/plan.md §1.108, "Test cases"; owner,
// 2026-11-17: "start on the test cases"). Each case is a moment from a QA run on staging where the
// Builder went wrong: the build as it stood, the operator's words, and what a good answer does. The
// Builder's own prompts run on the real catalog (this deployment's connectors, packs and skills,
// as staging registers them), and a judge model grades what can't be checked by rule.
//
// Not part of `pnpm check`: it calls the model (a few dollars a run) and its answers vary. Run by
// hand with ANTHROPIC_API_KEY set, or the "Builder evals" workflow (.github/workflows/
// builder-evals.yml). It reports scores; it fails only when a case can't run at all.
//
//   ANTHROPIC_API_KEY=… pnpm --filter @countersign/api exec vitest run --config vitest.eval.config.ts
//   BUILDER_EVAL_CASES=reminders-fitgap  BUILDER_EVAL_MODEL=claude-opus-5-5  BUILDER_EVAL_REPORT=out.md

import { writeFileSync } from "node:fs";
import { buildTurn, draftAgent, reviewBrief } from "@countersign/agents";
import {
  anthropicTransport,
  createLlmClient,
  DEFAULT_MODELS,
  type ModelId,
} from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlatform, deploymentConnectors } from "../platform";
import { platformBuilderContext } from "../routes/ops-builder";
import { BUILDER_CASES, type BuilderCase, styleProblems } from "./builder-cases";
import { DRAFT_CASES, renderDraft } from "./draft-cases";

const key = process.env.ANTHROPIC_API_KEY;
const only = (process.env.BUILDER_EVAL_CASES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const builderModel = (process.env.BUILDER_EVAL_MODEL || undefined) as ModelId | undefined;
const reportPath = process.env.BUILDER_EVAL_REPORT;

const Verdicts = z.object({
  points: z.array(
    z.object({
      id: z.string(),
      met: z.boolean(),
      why: z
        .string()
        .max(400)
        .describe("One sentence: what in the answer shows it, or what's missing"),
    }),
  ),
});

interface Result {
  c: BuilderCase;
  score: number;
  of: number;
  points: { id: string; text: string; met: boolean; why: string }[];
  style: string[];
  answer: string;
  costUsd: string | null;
  error?: string;
}

describe.skipIf(!key)("the Builder's test cases", () => {
  const llm = createLlmClient({ transport: anthropicTransport({ apiKey: key as string }) });
  const platform = createPlatform({
    connectors: deploymentConnectors({} as never, false),
  });
  const ctx = platformBuilderContext(platform).context;
  const results: Result[] = [];
  const cases = BUILDER_CASES.filter((c) => only.length === 0 || only.includes(c.id));

  for (const c of cases) {
    it(c.id, { timeout: 15 * 60_000 }, async () => {
      let out: Awaited<ReturnType<typeof buildTurn>>;
      try {
        if (c.runs === "review") {
          const r = await reviewBrief(
            {
              title: c.input.title,
              kind: c.input.kind,
              clientName: c.input.clientName,
              brief: c.input.brief,
              otherWork: c.input.otherWork ?? [],
              issues: [],
              ctx,
            },
            { llm, ...(builderModel ? { model: builderModel } : {}) },
          );
          // Its concerns, read as the conversation would show them.
          out = {
            answer: {
              text: r.concerns.map((x, i) => `${i + 1}. ${x.title} ${x.detail}`).join("\n"),
              chips: [],
              items: [],
              answered: [],
              asked: false,
              decisions: [],
            },
            calls: r.calls,
            costUsd: r.costUsd,
          };
        } else {
          out = await buildTurn(
            { ...c.input, ctx },
            { llm, ...(builderModel ? { model: builderModel } : {}) },
          );
        }
      } catch (error) {
        results.push({
          c,
          score: 0,
          of: c.points.length,
          points: [],
          style: [],
          answer: "",
          costUsd: null,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const answer = c.render(out.answer);
      const judged = await llm.callTool({
        model: DEFAULT_MODELS.builderComplex,
        system:
          "You grade an AI assistant's answer against a checklist. For each point, decide whether the answer meets it, strictly and literally: a point the answer only hints at is not met. Answer with every point.",
        messages: [
          {
            role: "user",
            content: `<situation>\n${c.situation}\n</situation>\n\n<answer>\n${answer}\n</answer>\n\n<checklist>\n${c.points
              .map((p) => `- ${p.id}: ${p.text}`)
              .join("\n")}\n</checklist>`,
          },
        ],
        tool: { name: "submit_grades", description: "The grade of each point", schema: Verdicts },
        maxTokens: 4000,
        label: "eval.judge",
      });
      const byId = new Map(judged.value.points.map((p) => [p.id, p]));
      const points = c.points.map((p) => ({
        id: p.id,
        text: p.text,
        met: byId.get(p.id)?.met ?? false,
        why: byId.get(p.id)?.why ?? "not graded",
      }));
      const style = styleProblems(c, out.answer);
      results.push({
        c,
        score: points.filter((p) => p.met).length,
        of: points.length,
        points,
        style,
        answer,
        costUsd: out.costUsd,
      });
    });
  }

  it("writes the report", () => {
    const lines = [
      `# Builder test cases`,
      "",
      `Model: ${builderModel ?? DEFAULT_MODELS.builder}. Catalog: ${ctx.tools.length} tools, ${ctx.skills.length} skills.`,
      "",
      "| Case | Score | Style problems | Cost |",
      "|---|---|---|---|",
      ...results.map(
        (r) =>
          `| ${r.c.id} | ${r.error ? "error" : `${r.score}/${r.of}`} | ${r.style.length} | ${r.costUsd ?? "?"} |`,
      ),
      "",
    ];
    const total = results.reduce((n, r) => n + r.score, 0);
    const of = results.reduce((n, r) => n + r.of, 0);
    lines.push(`Total: ${total}/${of}.`, "");
    for (const r of results) {
      lines.push(`## ${r.c.id}: ${r.c.title}`, "");
      if (r.error) lines.push(`Error: ${r.error}`, "");
      for (const p of r.points)
        lines.push(`- ${p.met ? "✅" : "❌"} **${p.id}**: ${p.text}. _${p.why}_`);
      for (const s of r.style) lines.push(`- ⚠️ style: ${s}`);
      lines.push(
        "",
        "<details><summary>The answer</summary>",
        "",
        "```",
        r.answer.slice(0, 6000),
        "```",
        "</details>",
        "",
      );
    }
    const text = lines.join("\n");
    if (reportPath) writeFileSync(reportPath, text);
    process.stdout.write(`${text}\n`);
    expect(results.length).toBe(cases.length);
  });
});

// Draft it now (owner, 2026-11-24): a description in, a drafted workflow out, judged point by point.
describe.skipIf(!key)("the Builder's drafts", () => {
  const llm = createLlmClient({ transport: anthropicTransport({ apiKey: key as string }) });
  const platform = createPlatform({ connectors: deploymentConnectors({} as never, false) });
  const ctx = platformBuilderContext(platform).context;
  const cases = DRAFT_CASES.filter((c) => only.length === 0 || only.includes(c.id));
  const lines: string[] = ["# Builder drafts", ""];

  for (const c of cases) {
    it(c.id, { timeout: 15 * 60_000 }, async () => {
      let answer = "";
      let costUsd: string | null = null;
      try {
        const out = await draftAgent(
          { description: c.description, worksFirst: true, ctx },
          { llm, validate: async () => [], ...(builderModel ? { model: builderModel } : {}) },
        );
        answer = renderDraft(out.bundle);
        costUsd = out.costUsd;
      } catch (error) {
        lines.push(
          `## ${c.id}`,
          "",
          `Error: ${error instanceof Error ? error.message : error}`,
          "",
        );
        return;
      }
      const judged = await llm.callTool({
        model: DEFAULT_MODELS.builderComplex,
        system:
          "You grade a drafted workflow against a checklist. For each point, decide whether the draft meets it, strictly and literally. Answer with every point.",
        messages: [
          {
            role: "user",
            content: `<situation>\n${c.situation}\n</situation>\n\n<description>\n${c.description}\n</description>\n\n<draft>\n${answer}\n</draft>\n\n<checklist>\n${c.points.map((p) => `- ${p.id}: ${p.text}`).join("\n")}\n</checklist>`,
          },
        ],
        tool: { name: "submit_grades", description: "The grade of each point", schema: Verdicts },
        maxTokens: 4000,
        label: "eval.judge",
      });
      const byId = new Map(judged.value.points.map((p) => [p.id, p]));
      const met = c.points.filter((p) => byId.get(p.id)?.met).length;
      lines.push(`## ${c.id}: ${met}/${c.points.length} (cost ${costUsd ?? "?"})`, "");
      for (const p of c.points) {
        const v = byId.get(p.id);
        lines.push(`- ${v?.met ? "✅" : "❌"} **${p.id}**: ${p.text}. _${v?.why ?? "not graded"}_`);
      }
      lines.push("", "```", answer, "```", "");
    });
  }

  it("writes the drafts report", () => {
    const text = lines.join("\n");
    if (reportPath) writeFileSync(reportPath.replace(/(\.md)?$/, "-drafts.md"), text);
    process.stdout.write(`${text}\n`);
  });
});
