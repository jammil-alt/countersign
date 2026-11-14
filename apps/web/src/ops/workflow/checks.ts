// R8 (ARCHITECTURE §10.14 "Checks", "Deadlines"): a v4 step's checks and deadlines in words, for
// the back office's read-only views (the merge view's step list, its conflicts, the run view):
// "Confer: a second check, then Dana", "Approval: client admin, then Dana, in turn · 2 days in
// business hours · if nobody answers, it stops". Never ids where a name is known.
// DECISION: these words are the read-only views' own; the builder's checks panel edits the same
// fields with its own controls. Both read core's schema, so they can't disagree on what a field is.
import type { processes } from "@countersign/core";
import { deadlineText } from "./describe";
import { roleLabel } from "./labels";

type Checks = processes.Checks;

/** "client admin", a person's name when the caller knows it, else the text as written. */
export type WhoName = (who: string) => string | undefined;

export function whoWords(who: string, name?: WhoName): string {
  return name?.(who) ?? (who.includes("{{") ? who.replace(/[{}]/g, "").trim() : roleLabel(who));
}

/** What happens when nobody answers in time: "it stops", "it goes ahead", "asks Dana". */
export function ifNoAnswerWords(then: processes.DeadlineThen | undefined, name?: WhoName): string {
  if (!then || then === "stop") return "it stops";
  if (then === "proceed") return "it goes ahead";
  if (then === "skip") return "the step is skipped";
  return `asks ${whoWords(then.escalate.to, name)} (${deadlineText(then.escalate.deadline)})`;
}

/** "2 days in business hours · if nobody answers, it stops". */
export function deadlineWords(d: processes.Deadline, name?: WhoName): string {
  const parts = [deadlineText(d)];
  if (d.remind?.length) parts.push(`reminds after ${d.remind.join(", ")}`);
  parts.push(`if nobody answers, ${ifNoAnswerWords(d.ifNoAnswer, name)}`);
  if (d.tell?.length) parts.push(`tells ${d.tell.map((w) => whoWords(w, name)).join(", ")}`);
  return parts.join(" · ");
}

export const APPROVAL_MODE_WORDS: Record<processes.ApprovalCheck["mode"], string> = {
  in_turn: "in turn",
  any: "any one of them",
  all: "all of them",
};

function conferee(c: processes.Conferee, name?: WhoName): string {
  return "ai" in c ? "a second check" : whoWords(c.person, name);
}

/** One line per check, in the order they run: confer, approval, notify. */
export function checksLines(checks: Checks | undefined, name?: WhoName): string[] {
  if (!checks) return [];
  const out: string[] = [];
  const some = (when: unknown) => (when ? " (some runs)" : "");
  if (checks.confer) {
    out.push(
      `Confer${some(checks.confer.when)}: ${checks.confer.with.map((c) => conferee(c, name)).join(", then ")}`,
    );
  }
  const a = checks.approval;
  if (a) {
    if (a.required === "not_required") {
      out.push("Runs without approval");
    } else {
      const who = (a.approvers ?? []).map((x) => (x.who ? whoWords(x.who, name) : "the approver"));
      const list =
        who.length > 0 ? who.join(a.mode === "in_turn" ? ", then " : ", ") : "the approver";
      const mode = who.length > 1 ? `, ${APPROVAL_MODE_WORDS[a.mode]}` : "";
      const first = a.approvers?.find((x) => x.deadline)?.deadline;
      out.push(
        [
          `Approval${some(a.when)}: ${list}${mode}`,
          first ? deadlineText(first) : null,
          `if nobody answers, ${ifNoAnswerWords(a.ifNoAnswer, name)}`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    }
  }
  for (const n of checks.notify ?? []) out.push(notifyWords(n, name));
  return out;
}

const CHANNEL: Record<string, string> = {
  inbox: "in the inbox",
  email: "by email",
  sms: "by text",
};

export function notifyWords(n: processes.NotifyCheck, name?: WhoName): string {
  const to = n.to.map((w) => whoWords(w, name)).join(", ");
  const urgent = n.urgent ? ` · urgent, Seen within ${n.urgent.ackWithin}` : "";
  return `Notify${n.when ? " (some runs)" : ""}: ${to} ${CHANNEL[n.channel] ?? n.channel}${urgent}`;
}

/**
 * A changed value under a step's checks, in words where its shape is known (an approver list, a
 * deadline, what happens with no answer); null otherwise, for the caller's own fallback.
 */
export function checkValueWords(pointer: string, value: unknown, name?: WhoName): string | null {
  const last = pointer.split("/").filter(Boolean).at(-1) ?? "";
  if (value === undefined || value === null) return null;
  if (last === "ifNoAnswer") return ifNoAnswerWords(value as processes.DeadlineThen, name);
  if (last === "mode" && typeof value === "string" && value in APPROVAL_MODE_WORDS) {
    return APPROVAL_MODE_WORDS[value as keyof typeof APPROVAL_MODE_WORDS];
  }
  if (last === "required" && typeof value === "string") {
    return value === "required" ? "needs approval" : "runs without approval";
  }
  if (last === "hours" && typeof value === "string") {
    return value === "business" ? "business hours" : "clock hours";
  }
  if (last === "deadline" && typeof value === "object" && "after" in value) {
    return deadlineWords(value as processes.Deadline, name);
  }
  if (last === "approvers" && Array.isArray(value)) {
    return value
      .map((x: { who?: string; deadline?: processes.Deadline }) =>
        [
          x.who ? whoWords(x.who, name) : "the approver",
          x.deadline ? deadlineText(x.deadline) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      )
      .join(", then ");
  }
  if ((last === "to" || last === "tell") && Array.isArray(value)) {
    return value.map((w) => whoWords(String(w), name)).join(", ");
  }
  return null;
}
