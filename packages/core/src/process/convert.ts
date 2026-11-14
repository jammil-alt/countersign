// R1 (docs/plan.md §1.86): read a stored v3 workflow as a v4 process. Pure: nothing stored
// changes (invariant 3), and every step, path and trigger id is kept, so merges still line up.

import { CONVERSE_SKILL } from "../converse";
import { REACH_OUT_SKILL } from "../reach/rules";
import type { Approval } from "../schemas/approval";
import { parseSkillRef } from "../schemas/common";
import type { Step as V3Step, Workflow } from "../schemas/workflow";
import { conversationFromConverse } from "./conversation";
import type { ApprovalCheck, Deadline, DeadlineThen, Process, Step } from "./schema";

/** A tool's side effect, as the tool registry knows it. */
export type SideEffect = "none" | "internal" | "external";

/**
 * What the converter needs from the registries: the tool a `tool`-mode skill wraps (by skill id),
 * and each tool's side effect. Unknown skills stay skill steps; unknown tools are treated as
 * external writes, the safe side (approval stays on).
 */
export interface ConvertLookup {
  wrappedTool(skillId: string): string | null;
  sideEffect(toolId: string): SideEffect | null;
}

/** A v3 timeout in the v4 deadline shape: clock time, `stop` unless the step said otherwise. */
function deadlineOf(after: string, then: DeadlineThen = "stop", remind?: string): Deadline {
  const d: Deadline = { after, hours: "clock", ifNoAnswer: then };
  if (remind) d.remind = [remind];
  return d;
}

/**
 * How the converter treats v3 `comms.converse` steps. `keep` (reading stored versions): they stay
 * skill steps and run on P-4's engine exactly as before (ARCHITECTURE §10.14: "Stored
 * `comms.converse` steps keep running as skill steps"). `upgrade` (the operator asks the builder to
 * move a workflow to v4, saved as a new version they review): each becomes a `conversation` step
 * where it can (`conversationFromConverse`), and `onDropped` hears what didn't carry over.
 */
// DECISION: reading never upgrades. v4 has no field for a v3 conversation's opening, its `about`
// and `data`, confirm off, a WhatsApp template, the reply wait or the spending limit, and the
// step's deadline (not a hand-over) decides what happens when nobody answers, so a stored
// conversation read as a v4 step would run differently; invariant 3 keeps its behaviour.
export interface ConvertOptions {
  conversations?: "keep" | "upgrade";
  onDropped?: (stepId: string, dropped: string[]) => void;
}

/**
 * Built-in skills that run only as workflow steps (apps/api carries them out): never a read or a
 * write on their handler tool, which refuses to run anywhere else.
 */
// DECISION: `comms.reach-out` stays a skill step even on upgrade: its plan approval, urgency,
// message template, attachments and the role's conditions have no v4 field; a one-off message
// with a reply is the reach-out it already is.
export const STEP_ONLY_SKILLS: readonly string[] = [CONVERSE_SKILL, REACH_OUT_SKILL];

function approvalOf(a: Approval): ApprovalCheck {
  const check: ApprovalCheck = {
    required: a.required,
    mode: "in_turn",
    ifNoAnswer: "stop",
    onReject: a.onReject,
  };
  if (a.approver || a.timeout) {
    const approver: { who?: string; deadline?: Deadline } = {};
    if (a.approver) approver.who = a.approver;
    if (a.timeout) approver.deadline = deadlineOf(a.timeout);
    check.approvers = [approver];
  }
  return check;
}

function stepOf(s: V3Step, lookup: ConvertLookup, options: ConvertOptions = {}): Step {
  const common = {
    id: s.id,
    name: s.name,
    ...(s.client ? { client: s.client } : {}),
  };
  switch (s.kind) {
    case "skill": {
      const review = s.review ? { review: s.review } : {};
      const skillId = parseSkillRef(s.skill).id;
      if (skillId === CONVERSE_SKILL && options.conversations === "upgrade") {
        const up = conversationFromConverse(s.input, s.approval?.required ?? "required");
        if (up) {
          const dropped = [...up.dropped];
          if (s.agent) dropped.push("the agent that ran it");
          if (s.model) dropped.push("its model");
          if (s.settings) dropped.push("its settings");
          if (s.approval?.approver) dropped.push("its approver");
          if (s.approval?.timeout) dropped.push("its approval's timeout");
          if (s.approval?.onReject === "continue") dropped.push("going on when rejected");
          if (dropped.length) options.onDropped?.(s.id, dropped);
          return { ...common, ...review, ...up.step };
        }
      }
      // A step-only skill wraps no tool a step could call: it stays a skill step.
      const tool = STEP_ONLY_SKILLS.includes(skillId) ? null : lookup.wrappedTool(skillId);
      if (tool && !s.agent && !s.model && !s.settings) {
        const effect = lookup.sideEffect(tool) ?? "external";
        if (effect === "none") return { ...common, ...review, kind: "read", tool, input: s.input };
        return {
          ...common,
          ...review,
          kind: "write",
          tool,
          input: s.input,
          ...(s.approval ? { checks: { approval: approvalOf(s.approval) } } : {}),
        };
      }
      return {
        ...common,
        ...review,
        kind: "skill",
        skill: s.skill,
        input: s.input,
        ...(s.agent ? { agent: s.agent } : {}),
        ...(s.settings ? { settings: s.settings } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(s.approval ? { checks: { approval: approvalOf(s.approval) } } : {}),
      };
    }
    case "action":
      return {
        ...common,
        ...(s.review ? { review: s.review } : {}),
        kind: "write",
        tool: s.tool,
        input: s.input,
        checks: { approval: approvalOf(s.approval) },
      };
    case "person": {
      const ifNoAnswer: DeadlineThen = s.onTimeout === "continue" ? "proceed" : "stop";
      const deadline = deadlineOf(s.timeout, ifNoAnswer, s.remindEvery);
      // v3 `notify_operator` tells the operator, then ends the run like `stop`.
      if (s.onTimeout === "notify_operator") deadline.tell = ["operator"];
      return {
        ...common,
        kind: "person",
        mode: s.mode,
        assignee: s.assignee,
        title: s.title,
        payload: s.payload,
        deadline,
        channel: s.channel,
        onReject: s.onReject,
        ...(s.choices ? { choices: s.choices } : {}),
      };
    }
    case "notify":
      return {
        ...common,
        kind: "notify",
        notify: {
          to: [s.to ?? "client_admin"],
          // DECISION: v3 `thread` and `digest` both land in the inbox; `email` stays email.
          channel: s.channel === "email" ? "email" : "inbox",
          message: s.message,
          ...(s.sources ? { sources: s.sources } : {}),
        },
      };
    case "fork":
      return {
        ...common,
        kind: "if",
        paths: s.paths.map((p) => ({
          id: p.id,
          name: p.name,
          when: p.when,
          steps: p.steps.map((c) => stepOf(c, lookup, options)),
        })),
        otherwise: {
          id: s.otherwise.id,
          steps: s.otherwise.steps.map((c) => stepOf(c, lookup, options)),
        },
      };
    case "for_each":
      return {
        ...common,
        kind: "for_each",
        over: s.over,
        concurrency: s.concurrency,
        steps: s.steps.map((c) => stepOf(c, lookup, options)),
      };
    case "wait":
      return { ...common, kind: "wait", for: s.for };
    case "stop":
      return { ...common, kind: "stop", status: s.status };
    case "use_automation": {
      const approvals = s.approvals
        ? Object.fromEntries(Object.entries(s.approvals).map(([k, a]) => [k, approvalOf(a)]))
        : undefined;
      return {
        ...common,
        kind: "process",
        process: s.automation,
        input: s.input,
        ...(approvals ? { approvals } : {}),
      };
    }
  }
}

/** A stored v3 workflow, read as a v4 process. */
export function fromWorkflowV3(
  w: Workflow,
  lookup: ConvertLookup,
  options: ConvertOptions = {},
): Process {
  return {
    schemaVersion: 4,
    triggers: [w.trigger, ...(w.moreTriggers ?? [])],
    steps: w.steps.map((s) => stepOf(s, lookup, options)),
    ...(w.handoff ? { handoff: w.handoff } : {}),
  };
}

/**
 * A v3 workflow moved to v4 at the operator's request (the builder's upgrade, saved as a new
 * version): conversations become `conversation` steps where they can, and `dropped` lists, by step
 * id, what didn't carry over for the operator to review.
 */
export function upgradeWorkflowV3(
  w: Workflow,
  lookup: ConvertLookup,
): { process: Process; dropped: Record<string, string[]> } {
  const dropped: Record<string, string[]> = {};
  const process = fromWorkflowV3(w, lookup, {
    conversations: "upgrade",
    onDropped: (id, what) => {
      dropped[id] = what;
    },
  });
  return { process, dropped };
}
