// v0.12 W3-A: how alike two agent bundles are (ARCHITECTURE §9.6 "Closest template"; docs/plan.md
// §1.51). A deterministic score, 0–1, over what the bundles use and how their steps run: Jaccard
// over skills, tools and trigger kinds, and a sequence score over the step kinds, weighted 0.4,
// 0.3, 0.1 and 0.2. The Builder shows it as "Collections v2 · 62% alike" and offers to fork the
// template instead. Pure: no model, no clock, no randomness, so the same bundles always score the
// same.

import type { AgentBundle } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import { walkSteps } from "../workflow/walk";
import { lcs } from "./diff";

export const SIMILARITY_WEIGHTS = { skills: 0.4, tools: 0.3, triggers: 0.1, steps: 0.2 } as const;

export interface BundleSimilarity {
  /** The weighted score, 0–1, rounded to 4 places. */
  score: number;
  /** Each part's own score, 0–1, rounded to 4 places. */
  skills: number;
  tools: number;
  triggers: number;
  steps: number;
}

/** What a bundle is compared on. */
export interface BundleFeatures {
  /** Skill ids (no version pins) the agent lists or a skill step runs. */
  skills: string[];
  /** Tools its action steps call and its extra tools. */
  tools: string[];
  /** Its workflows' trigger kinds (`manual`, `event`, `schedule`, …), every trigger counted. */
  triggers: string[];
  /** The kind of every step, workflow by workflow, depth first. */
  steps: string[];
}

export function bundleFeatures(bundle: AgentBundle): BundleFeatures {
  const skills = new Set<string>();
  const tools = new Set<string>();
  const triggers = new Set<string>();
  const steps: string[] = [];
  for (const s of bundle.definition.skills) skills.add(parseSkillRef(s.skill).id);
  for (const t of bundle.definition.extraTools) tools.add(t);
  for (const w of bundle.workflows) {
    triggers.add(w.workflow.trigger.on.type);
    for (const t of w.workflow.moreTriggers ?? []) triggers.add(t.on.type);
    walkSteps(w.workflow, ({ step }) => {
      steps.push(step.kind);
      if (step.kind === "skill") skills.add(parseSkillRef(step.skill).id);
      if (step.kind === "action") tools.add(step.tool);
    });
  }
  return {
    skills: [...skills].sort(),
    tools: [...tools].sort(),
    triggers: [...triggers].sort(),
    steps,
  };
}

// DECISION: two empty sets (or two empty step lists) agree completely (1), so a part neither
// bundle has neither raises nor lowers how alike they are relative to bundles that both have it.
/** |a ∩ b| / |a ∪ b|; 1 when both are empty. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let both = 0;
  for (const x of sa) if (sb.has(x)) both += 1;
  return both / (sa.size + sb.size - both);
}

/** 2·LCS / (|a| + |b|): 1 for the same sequence, 0 for nothing in common; 1 when both are empty. */
export function sequenceScore(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  return (2 * lcs(a, b).length) / (a.length + b.length);
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** How alike `a` and `b` are: symmetric, 1 for bundles that use and run the same things. */
export function bundleSimilarity(a: AgentBundle, b: AgentBundle): BundleSimilarity {
  const fa = bundleFeatures(a);
  const fb = bundleFeatures(b);
  const skills = jaccard(fa.skills, fb.skills);
  const tools = jaccard(fa.tools, fb.tools);
  const triggers = jaccard(fa.triggers, fb.triggers);
  const steps = sequenceScore(fa.steps, fb.steps);
  const w = SIMILARITY_WEIGHTS;
  return {
    score: round(w.skills * skills + w.tools * tools + w.triggers * triggers + w.steps * steps),
    skills: round(skills),
    tools: round(tools),
    triggers: round(triggers),
    steps: round(steps),
  };
}

/**
 * The candidates most like `bundle`, best first (ties by key, so the order is stable), those
 * scoring at least `min`, at most `limit`.
 */
export function closestBundles<T extends { key: string; bundle: AgentBundle }>(
  bundle: AgentBundle,
  candidates: readonly T[],
  options: { limit?: number; min?: number } = {},
): (T & { similarity: BundleSimilarity })[] {
  const min = options.min ?? 0;
  return candidates
    .map((c) => ({ ...c, similarity: bundleSimilarity(bundle, c.bundle) }))
    .filter((c) => c.similarity.score >= min)
    .sort((x, y) =>
      y.similarity.score !== x.similarity.score
        ? y.similarity.score - x.similarity.score
        : x.key < y.key
          ? -1
          : x.key > y.key
            ? 1
            : 0,
    )
    .slice(0, options.limit ?? 3);
}
