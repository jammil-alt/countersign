// The client's view-only chart (docs/sop-plan.md §6a, stream W): the SOP's outline turned into the
// shape the builder's chart draws, and each box's words taken from the SOP's own step line. The
// chart never sees the agent's bundle (invariant 11): a step here has its id, its name from the
// SOP, its kind and its place, nothing else; every word on a box is what the SOP says of the step.

import type { SopOutlineStep, SopStepLine, SopView } from "@countersign/core";
import type { MessageKey, Translate } from "../i18n/catalog";
import { EN } from "../i18n/i18n";
import type { Process, Step } from "../ops/builder/model";
import type { ChartProps } from "../ops/flow/types";

type Words = ReturnType<NonNullable<ChartProps["label"]>>;

/** The workflows the outline holds, in order: one null when the agent has one. */
export function outlineWorkflows(view: SopView): (string | null)[] {
  const out: (string | null)[] = [];
  for (const o of view.outline) if (!out.includes(o.workflow)) out.push(o.workflow);
  return out;
}

/** The step lines by step id. */
export function stepLines(view: SopView): Map<string, SopStepLine> {
  const out = new Map<string, SopStepLine>();
  for (const l of view.procedure) if (l.line === "step") out.set(l.id, l);
  return out;
}

/**
 * One workflow's outline as a process the chart lays out: the same ids, kinds, paths and loops.
 * Nothing a step does is carried: a decision's paths have no rules (their words are their names),
 * a loop no list or limit.
 */
export function outlineProcess(
  view: SopView,
  workflow: string | null,
  t: Translate = EN.t,
): Process {
  const lines = stepLines(view);
  const mine = view.outline.filter((o) => o.workflow === workflow);
  const within = new Map<string, SopOutlineStep[]>();
  for (const o of mine) within.set(o.container, [...(within.get(o.container) ?? []), o]);
  const build = (container: string): Step[] =>
    (within.get(container) ?? []).map((o) => toStep(o, lines.get(o.id)?.name ?? "", build, t));
  return { schemaVersion: 4, steps: build("root") } as unknown as Process;
}

function toStep(
  o: SopOutlineStep,
  name: string,
  build: (container: string) => Step[],
  t: Translate,
): Step {
  const base = { id: o.id, name, kind: o.kind };
  if (o.kind === "if") {
    const paths = (o.paths ?? []).filter((p) => !p.otherwise);
    const other = (o.paths ?? []).find((p) => p.otherwise);
    return {
      ...base,
      paths: paths.map((p) => ({
        id: p.id,
        // The builder's label: the path's name, else what sends a run down it.
        name: p.name || capital(p.words) || t("flow.path", { letter: p.letter }),
        when: { match: "all", rules: [] },
        steps: build(`path:${p.id}`),
      })),
      otherwise: {
        id: other?.id ?? `${o.id}:otherwise`,
        steps: other ? build(`otherwise:${other.id}`) : [],
      },
    } as unknown as Step;
  }
  if (o.kind === "for_each" || o.kind === "repeat") {
    return { ...base, steps: build(`loop:${o.id}`) } as unknown as Step;
  }
  return base as unknown as Step;
}

function capital(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const KIND_WORD: Record<string, MessageKey> = {
  read: "workflow.kind.read",
  write: "workflow.kind.change",
  person: "workflow.kind.person",
  conversation: "workflow.kind.conversation",
  notify: "workflow.kind.notify",
  wait: "workflow.kind.wait",
  stop: "workflow.kind.stop",
  process: "workflow.kind.process",
  handoff: "workflow.kind.handoff",
  missing: "workflow.kind.person",
  if: "workflow.kind.decision",
  for_each: "workflow.kind.forEach",
  repeat: "workflow.kind.repeat",
  collect: "workflow.kind.collect",
};

/** A verb's level in the client's words, as the SOP says it ("Read: on its own"). */
function levelWords(t: Translate, verb: string, level: string): string {
  if (level === "off") return t("sop.level.off");
  if (verb.toLowerCase() === "read") return t("sop.level.on");
  return t(level === "auto" ? "sop.level.auto" : "sop.level.ask");
}

/**
 * What a box says, from the SOP's step line: its name, its kind in a word or two, the line under
 * the name in the client's words (the system and what the agent may do there, the person and by
 * when, who is told), whether AI does it and on which model, and the tool's mark.
 */
export function boxWords(view: SopView, t: Translate): (step: Step) => Words {
  const lines = stepLines(view);
  const outline = new Map(view.outline.map((o) => [o.id, o]));
  const systems = new Map(view.systems.map((s) => [s.id, s]));
  return (step: Step) => {
    const line = lines.get(step.id);
    const o = outline.get(step.id);
    const kind = o?.kind ?? step.kind;
    const ai = line?.method === "ai" || line?.method === "rules_then_ai";
    const words: Words = {
      title: line?.name || step.name,
      kind:
        kind === "skill"
          ? t(ai ? "workflow.kind.aiSkill" : "workflow.kind.rulesSkill")
          : (t as (key: MessageKey) => string)(KIND_WORD[kind] ?? "workflow.kind.process"),
      detail: line ? detailOf(line, t) : null,
      ...(ai ? { skillKind: "AI" } : {}),
      ...(ai && line?.model ? { model: line.model } : {}),
      // A step no model does says "rules" here, as its SOP does (docs/sop-plan.md §6a, §7).
      noModel: { word: t("workflow.noModel"), title: t("workflow.noModel.title") },
    };
    const sys = line?.systems[0];
    if (sys && (kind === "read" || kind === "write")) {
      const key = systems.get(sys.id)?.key ?? sys.id;
      words.connector = { id: key.split(":")[0] ?? key, name: sys.name };
    }
    return words;
  };
}

function detailOf(line: SopStepLine, t: Translate): string | null {
  // A Collect reports step: how many reports, and who sends them ("2 reports · Tom Guerra, Priya Shah").
  if (line.reports && line.reports.length > 0) {
    const owners = [...new Set(line.reports.map((r) => r.owner.name))];
    return `${t("workflow.reports", { count: line.reports.length })} · ${owners.join(", ")}`;
  }
  const sys = line.systems[0];
  if (sys) return `${sys.name} · ${levelWords(t, sys.verb, sys.level)}`;
  if (line.who && line.byWhen) return `${line.who.name} · ${line.byWhen}`;
  if (line.who) return line.who.name;
  if (line.told.length > 0) return line.told.map((p) => p.name).join(", ");
  if (line.method === "rules_then_ai") return t("workflow.rulesThenAi");
  return null;
}

/** The step's number and name, as the SOP's link to it says: "Step 5 A1". */
export function stepAnchor(stepId: string): string {
  return `sop-step-${stepId}`;
}
