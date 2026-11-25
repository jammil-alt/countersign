// ONE-OFF (docs/step-model-plan.md §13b, wave 0): rewrites a v4 process (or a v3 workflow, through
// `fromWorkflowV3`) into the step model, for the test fixtures and the seeds while the codebase moves
// to it. Deleted in wave 4 with v3 and v4 (§12, R2): nothing stored is converted at run time, and the
// purge leaves nothing to convert (§2, principle 1).
//
// What has no place in the step model is reported in `notes`, by step id, for the person moving a
// fixture or a seed to look at: a step's edits to a library skill's rule rows, the output fields it
// kept. Converted workflows declare one output, "Done" (nothing to do), plus "Passed on" when the
// process passed its output on; every End that succeeds delivers them.

import { type ConvertLookup, fromWorkflowV3 } from "../process/convert";
import type { Process, Step as V4Step } from "../process/schema";
import { parseSkillRef } from "../schemas/common";
import type { Workflow as V3Workflow } from "../schemas/workflow";
import { endsAlways } from "./validate";

export interface V5ConvertLookup extends ConvertLookup {
  /** A skill's method: rules (code or rule rows), AI (one answer), or agent (its own reasoning). */
  skillMethod(skillId: string): "rules" | "ai" | "agent" | undefined;
}

export interface V5Conversion {
  /** The workflow, unparsed: `Workflow.parse` fills the defaults. */
  workflow: Record<string, unknown>;
  notes: Record<string, string[]>;
}

const WRITE_ACTION_IDS: Record<string, string> = {
  send_email: "email.send",
  send_text: "sms.send",
  create_bill: "accounting.bill.create",
  create_vendor: "accounting.vendor.create",
};

const DONE = "out-done";
const PASSED_ON = "out-passed-on";

type Out = Record<string, unknown>;

export function toStepModel(source: Process | V3Workflow, lookup: V5ConvertLookup): V5Conversion {
  const process = source.schemaVersion === 3 ? fromWorkflowV3(source, lookup) : source;
  const notes: Record<string, string[]> = {};
  const note = (id: string, what: string) => {
    notes[id] = [...(notes[id] ?? []), what];
  };
  const succeeded = process.handoff ? [DONE, PASSED_ON] : [DONE];

  const common = (s: V4Step): Out => {
    const out: Out = { id: s.id, name: s.name };
    for (const key of ["purpose", "client", "review", "onError", "checks"] as const) {
      const v = (s as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = v;
    }
    return out;
  };

  const convert = (s: V4Step): Out => {
    const base = common(s);
    switch (s.kind) {
      case "read":
        return {
          ...base,
          kind: "do",
          doneBy: "rules",
          uses: { type: "action", action: s.tool },
          input: s.input,
        };
      case "write":
        return {
          ...base,
          kind: "do",
          doneBy: "rules",
          uses: {
            type: "action",
            action: s.tool ?? WRITE_ACTION_IDS[s.action as string] ?? String(s.action),
          },
          input: s.input,
        };
      case "notify":
        return { ...base, kind: "do", doneBy: "rules", uses: { type: "tell" }, tell: s.notify };
      case "skill": {
        const id = parseSkillRef(s.skill).id;
        if (s.reshape) {
          return {
            ...base,
            kind: "do",
            doneBy: "rules",
            uses: { type: "skill", skill: s.skill },
            input: s.input,
            translation: s.reshape,
          };
        }
        const c = s.customize;
        if (c?.rules?.edit?.length) note(s.id, "edits to the skill's rule rows were dropped");
        if (c?.keep) note(s.id, "the output fields it kept were dropped");
        const values = { ...(s.settings ?? {}), ...(c?.settings ?? {}), ...(c?.parameters ?? {}) };
        const hasValues = Object.keys(values).length > 0;
        const method = lookup.skillMethod(id) ?? "ai";
        if (method === "agent") {
          return {
            ...base,
            kind: "loop",
            skill: s.skill,
            goal: s.name,
            input: s.input,
            instructions: c?.addInstructions ?? "",
            ...(s.model || c?.model ? { model: c?.model ?? s.model } : {}),
          };
        }
        if (method === "rules") {
          return {
            ...base,
            kind: "do",
            doneBy: "rules",
            uses: { type: "skill", skill: s.skill },
            input: s.input,
            ...(hasValues || c?.rules?.add?.length
              ? {
                  rules: {
                    ...(c?.rules?.add?.length ? { rows: c.rules.add } : {}),
                    ...(hasValues ? { values } : {}),
                  },
                }
              : {}),
          };
        }
        const model = c?.model ?? s.model;
        return {
          ...base,
          kind: "do",
          doneBy: "ai",
          uses: { type: "skill", skill: s.skill },
          input: s.input,
          ...(c?.addInstructions || model || hasValues
            ? {
                ai: {
                  ...(c?.addInstructions ? { text: c.addInstructions } : {}),
                  ...(model ? { model } : {}),
                  ...(hasValues ? { values } : {}),
                },
              }
            : {}),
        };
      }
      case "person":
        return {
          ...base,
          kind: "do",
          doneBy: "person",
          person: {
            mode: s.mode,
            who: s.assignee,
            question: s.title,
            show: s.payload,
            ...(s.choices ? { choices: s.choices } : {}),
            deadline: s.deadline,
            channel: s.channel,
            onReject: s.onReject,
          },
        };
      case "conversation":
        return {
          ...base,
          kind: "do",
          doneBy: "contact",
          contact: {
            with: s.with,
            channel: s.channel,
            goal: s.goal,
            mayShare: s.mayShare,
            maxTurns: s.maxTurns,
            messages: s.messages,
            deadline: s.deadline,
          },
          ...(Object.keys(s.find ?? {}).length
            ? {
                output: Object.entries(s.find).map(([name, type]) => ({
                  name,
                  type: "text",
                  required: !String(type).endsWith("?"),
                  about: String(type).replace(/\?$/, ""),
                })),
              }
            : {}),
        };
      case "collect":
        return {
          ...base,
          kind: "do",
          doneBy: "person",
          uses: { type: "collect" },
          collect: {
            items: s.items,
            ...(s.escalate ? { escalate: s.escalate } : {}),
            ifMissing: s.ifMissing,
          },
        };
      case "process":
        if (s.approvals) note(s.id, "the automation's approval overrides were dropped");
        return { ...base, kind: "do", uses: { type: "automation", automation: s.process } };
      case "missing":
        return {
          ...base,
          kind: "do",
          uses: { type: "missing", need: s.need, ...(s.fill ? { fill: s.fill } : {}) },
        };
      case "if":
        return {
          ...base,
          kind: "fork",
          paths: s.paths.map((p) => ({ ...p, steps: p.steps.map(convert) })),
          otherwise: { id: s.otherwise.id, steps: s.otherwise.steps.map(convert) },
          ...(s.decide ? { decide: s.decide } : {}),
          ...(s.show ? { show: s.show } : {}),
          ...(s.ifUnsure ? { ifUnsure: s.ifUnsure } : {}),
        };
      case "for_each":
        return {
          ...base,
          kind: "for_each",
          over: s.over,
          concurrency: s.concurrency,
          steps: s.steps.map(convert),
        };
      case "repeat":
        return {
          ...base,
          kind: "repeat",
          steps: s.steps.map(convert),
          until: s.until,
          maxTimes: s.maxTimes,
          ...(s.between ? { between: s.between } : {}),
          onLimit: s.onLimit,
        };
      case "wait":
        return { ...base, kind: "wait", for: s.for };
      case "handoff":
        return { ...base, kind: "handoff", to: s.to, input: s.input };
      case "stop":
        return s.status === "succeeded"
          ? { ...base, kind: "end", outputs: succeeded }
          : { ...base, kind: "end", status: s.status, nothingToDo: `Ends here (${s.status})` };
    }
  };

  const steps = process.steps.map(convert);
  if (!endsAlways(steps as never)) {
    const taken = new Set<string>();
    const walk = (list: readonly Out[]) => {
      for (const s of list) {
        taken.add(String(s.id));
        for (const key of ["steps"] as const) if (Array.isArray(s[key])) walk(s[key] as Out[]);
        for (const p of (s.paths as Out[] | undefined) ?? []) walk(p.steps as Out[]);
        const o = s.otherwise as Out | undefined;
        if (o) walk(o.steps as Out[]);
      }
    };
    walk(steps);
    let id = "end";
    for (let n = 2; taken.has(id); n++) id = `end-${n}`;
    steps.push({ id, kind: "end", name: "Done", outputs: succeeded });
  }
  const outputs: Out[] = [{ id: DONE, name: "Done", kind: "nothing" }];
  if (process.handoff) {
    outputs.push({ id: PASSED_ON, name: "Passed on", kind: "pass_on", passOn: process.handoff });
  }
  return {
    workflow: { schemaVersion: 5, triggers: process.triggers, outputs, steps },
    notes,
  };
}
