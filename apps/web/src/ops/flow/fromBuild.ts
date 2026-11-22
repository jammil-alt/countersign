// A build's issues, questions and decisions on the steps they belong to (docs/builder-plan.md
// §12.4, F3): what the chart, the list and the side panel show on a step, read from the build as
// its page reads it. Only what names a step is here; the rest stays on the build's own list.
import { type BuildDetail, buildIssues } from "@countersign/core";
import type { DecidedNote, SettleItem } from "./types";

export interface FromBuildOptions {
  /**
   * The draft's validator problems, as the build read them from its saved version. Leave them out
   * (false) where the host shows the live problems of the process being edited, so a step doesn't
   * show the same problem twice. Default: in.
   */
  problems?: boolean;
}

/**
 * Open issues and questions with a step: a build item (a question is a question; a gap, a test,
 * client feedback or a note is an issue), the draft's problems, and a high-risk decision nobody has
 * looked at (a question). A gap put off ("a person does this for now") is still shown on its step.
 */
export function settleItems(d: BuildDetail, options: FromBuildOptions = {}): SettleItem[] {
  const withProblems = options.problems ?? true;
  const items = new Map(d.items.map((i) => [i.id, i]));
  const out: SettleItem[] = [];
  for (const issue of buildIssues(d)) {
    if (!issue.stepId) continue;
    const base = {
      key: issue.key,
      stepId: issue.stepId,
      title: issue.title,
      ...(issue.detail ? { detail: issue.detail } : {}),
    };
    switch (issue.source) {
      case "item": {
        const item = issue.itemId ? items.get(issue.itemId) : undefined;
        if (!item || item.state === "done") continue;
        const putOff = item.state === "deferred";
        out.push({
          ...base,
          ...(putOff ? { detail: ["Put off.", issue.detail].filter(Boolean).join(" ") } : {}),
          level: item.kind === "question" ? "question" : "issue",
          source: "build_item",
          refId: item.id,
        });
        break;
      }
      case "problem":
        if (withProblems && issue.open) out.push({ ...base, level: "issue", source: "problem" });
        break;
      case "decision": {
        if (!issue.open) continue;
        const id = issue.key.slice("decision:".length);
        out.push({ ...base, level: "question", source: "decision", refId: id });
        break;
      }
      default:
        // Failing cases, QA checks and the client's rejections name no step (`stepId` null).
        break;
    }
  }
  return out;
}

/** The decisions the Builder made that shape a step ("Decided for you"), their risk kept. */
export function decidedNotes(d: BuildDetail): DecidedNote[] {
  const out: DecidedNote[] = [];
  for (const dec of d.build.fitgap?.decisions ?? []) {
    if (!dec.stepId) continue;
    const why = [dec.value ? `Starts at ${dec.value}` : null, dec.why || null]
      .filter(Boolean)
      .join(". ");
    out.push({
      key: `decision:${dec.id}`,
      stepId: dec.stepId,
      what: dec.what,
      ...(why ? { why } : {}),
      decisionId: dec.id,
      risk: dec.risk === "high" ? "high" : "normal",
    });
  }
  return out;
}

/** Both, from one build. */
export function fromBuild(
  d: BuildDetail,
  options: FromBuildOptions = {},
): { items: SettleItem[]; decided: DecidedNote[] } {
  return { items: settleItems(d, options), decided: decidedNotes(d) };
}
