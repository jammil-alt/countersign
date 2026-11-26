// Seats (docs/setup-plan.md §4.1): a template names a place a person fills ("approves bills over
// $5,000") as `seat:<role>`, declared in the bundle's `people`; each client fills it with its own
// people on the client agent (`agent.people`), never in a version (invariant 11). Pure: the
// validator checks references and kinds, and the executor rewrites a run's process with the
// people the run started with (`fillSeats`), so the engine and the ports see plain user ids.

import { type PersonRole, type SeatKind, seatKindOf } from "../reach/rules";
import type { Step as StepModelStep, Workflow as StepModelWorkflow } from "../steps/schema";
import { eachStep } from "../steps/walk";
import type { ApprovalCheck, Deadline, DeadlineThen, NotifyCheck, Process, Step } from "./schema";
import { walkSteps } from "./walk";

export const SEAT_PREFIX = "seat:";

/** How a step names a seat: `seat:bill-approver`. */
export function seatWho(role: string): string {
  return `${SEAT_PREFIX}${role}`;
}

/** The role a `Who` names as a seat, or null for anything else (a role, a user, a contact). */
export function seatRoleOf(who: string | null | undefined): string | null {
  return typeof who === "string" && who.startsWith(SEAT_PREFIX)
    ? who.slice(SEAT_PREFIX.length)
    : null;
}

/** What a step asks of the person it names. */
export type SeatUse = "approve" | "answer" | "escalate" | "tell" | "reach";

/** The seat kinds each use takes: a person who only gets messages never signs (invariant 8). */
export const SEAT_USES: Record<SeatUse, readonly SeatKind[]> = {
  approve: ["signs"],
  answer: ["signs", "answers"],
  escalate: ["signs", "answers"],
  tell: ["signs", "answers", "told"],
  // Collect reports (owner, 2026-11-24): a report's owner is contacted through reach out.
  reach: ["reached"],
};

/** One `Who` a step names, how it is used and where (a field path inside the step). */
export interface WhoRef {
  who: string;
  use: SeatUse;
  field: string;
}

function thenRefs(t: DeadlineThen | undefined, field: string, out: WhoRef[]): void {
  if (t && typeof t === "object" && "escalate" in t) {
    out.push({ who: t.escalate.to, use: "escalate", field: `${field}.escalate.to` });
    deadlineRefs(t.escalate.deadline, `${field}.escalate.deadline`, out);
  }
}

function deadlineRefs(d: Deadline | undefined, field: string, out: WhoRef[]): void {
  if (!d) return;
  (d.tell ?? []).forEach((w, i) => {
    out.push({ who: w, use: "tell", field: `${field}.tell.${i}` });
  });
  thenRefs(d.ifNoAnswer, `${field}.ifNoAnswer`, out);
}

function approvalRefs(a: ApprovalCheck, field: string, out: WhoRef[]): void {
  (a.approvers ?? []).forEach((ap, i) => {
    if (ap.who) out.push({ who: ap.who, use: "approve", field: `${field}.approvers.${i}.who` });
    deadlineRefs(ap.deadline, `${field}.approvers.${i}.deadline`, out);
  });
  thenRefs(a.ifNoAnswer, `${field}.ifNoAnswer`, out);
}

function notifyRefs(n: NotifyCheck, field: string, out: WhoRef[]): void {
  n.to.forEach((w, i) => {
    out.push({ who: w, use: "tell", field: `${field}.to.${i}` });
  });
  thenRefs(n.urgent?.ifNoAnswer, `${field}.urgent.ifNoAnswer`, out);
}

/** The checks every step carries: confer, approval, notify. */
function checkRefs(checks: Step["checks"], out: WhoRef[]): void {
  if (checks?.confer) {
    checks.confer.with.forEach((c, i) => {
      if ("person" in c) {
        out.push({ who: c.person, use: "answer", field: `checks.confer.with.${i}.person` });
      }
      deadlineRefs(c.deadline, `checks.confer.with.${i}.deadline`, out);
    });
  }
  if (checks?.approval) approvalRefs(checks.approval, "checks.approval", out);
  (checks?.notify ?? []).forEach((n, i) => {
    notifyRefs(n, `checks.notify.${i}`, out);
  });
}

/** Every `Who` one step names itself (not the steps inside an if, a for_each or a repeat). */
export function whoRefsOfStep(step: Step): WhoRef[] {
  const out: WhoRef[] = [];
  checkRefs(step.checks, out);
  switch (step.kind) {
    case "person":
      out.push({
        who: step.assignee,
        use: step.mode === "approve" ? "approve" : "answer",
        field: "assignee",
      });
      deadlineRefs(step.deadline, "deadline", out);
      break;
    case "conversation":
      deadlineRefs(step.deadline, "deadline", out);
      break;
    // Collect reports (owner, 2026-11-24)
    case "collect":
      step.items.forEach((item, i) => {
        out.push({ who: item.owner, use: "reach", field: `items.${i}.owner` });
      });
      if (step.escalate) {
        out.push({ who: step.escalate.to, use: "escalate", field: "escalate.to" });
        deadlineRefs(step.escalate.deadline, "escalate.deadline", out);
      }
      break;
    case "notify":
      notifyRefs(step.notify, "notify", out);
      break;
    case "process":
      for (const [inner, a] of Object.entries(step.approvals ?? {})) {
        approvalRefs(a, `approvals.${inner}`, out);
      }
      break;
    default:
      break;
  }
  return out;
}

/** Every `Who` one v5 step names itself (not the steps inside a Fork, a For each or a Repeat). */
export function whoRefsOfStepModelStep(step: StepModelStep): WhoRef[] {
  const out: WhoRef[] = [];
  if (step.kind === "do" || step.kind === "loop") checkRefs(step.checks as Step["checks"], out);
  if (step.kind !== "do") return out;
  const p = step.person;
  if (p) {
    out.push({ who: p.who, use: p.mode === "approve" ? "approve" : "answer", field: "person.who" });
    deadlineRefs(p.deadline, "person.deadline", out);
  }
  const c = step.collect;
  if (c) {
    c.items.forEach((item, i) => {
      out.push({ who: item.owner, use: "reach", field: `collect.items.${i}.owner` });
    });
    if (c.escalate) {
      out.push({ who: c.escalate.to, use: "escalate", field: "collect.escalate.to" });
      deadlineRefs(c.escalate.deadline, "collect.escalate.deadline", out);
    }
  }
  if (step.contact) deadlineRefs(step.contact.deadline, "contact.deadline", out);
  if (step.tell) notifyRefs(step.tell, "tell", out);
  return out;
}

/** A problem with a seat a step names, in the validator's shape. */
export interface SeatProblem {
  stepId: string;
  field: string;
  code: "unknown_seat" | "seat_kind";
  message: string;
}

const USE_WORDS: Record<SeatUse, string> = {
  approve: "approve",
  answer: "answer",
  escalate: "be asked when nobody answers",
  tell: "be told",
  reach: "send a report",
};

/**
 * The seats a process names that its bundle doesn't declare, or whose kind can't do what the step
 * asks (a `told` seat can't approve; a `reached` seat is for reach-outs only).
 */
export function seatProblems(
  process: Pick<Process, "steps">,
  roles: readonly PersonRole[],
): SeatProblem[] {
  const byRole = new Map(roles.map((r) => [r.role, r]));
  const out: SeatProblem[] = [];
  walkSteps(process, ({ step }) => {
    for (const ref of whoRefsOfStep(step)) {
      const role = seatRoleOf(ref.who);
      if (role === null) continue;
      const declared = byRole.get(role);
      if (!declared) {
        out.push({
          stepId: step.id,
          field: ref.field,
          code: "unknown_seat",
          message: `seat "${role}" isn't one of the agent's people`,
        });
        continue;
      }
      const kind = seatKindOf(declared);
      if (!SEAT_USES[ref.use].includes(kind)) {
        out.push({
          stepId: step.id,
          field: ref.field,
          code: "seat_kind",
          message: `seat "${role}" is for people who are ${kind === "reached" ? "contacted" : kind}, so it can't ${USE_WORDS[ref.use]}`,
        });
      }
    }
  });
  return out;
}

/** `seatProblems` for a v5 workflow's steps. */
export function stepModelSeatProblems(
  workflow: Pick<StepModelWorkflow, "steps">,
  roles: readonly PersonRole[],
): SeatProblem[] {
  const byRole = new Map(roles.map((r) => [r.role, r]));
  const out: SeatProblem[] = [];
  eachStep(workflow.steps, ({ step }) => {
    for (const ref of whoRefsOfStepModelStep(step)) {
      const role = seatRoleOf(ref.who);
      if (role === null) continue;
      const declared = byRole.get(role);
      if (!declared) {
        out.push({
          stepId: step.id,
          field: ref.field,
          code: "unknown_seat",
          message: `seat "${role}" isn't one of the agent's people`,
        });
        continue;
      }
      const kind = seatKindOf(declared);
      if (!SEAT_USES[ref.use].includes(kind)) {
        out.push({
          stepId: step.id,
          field: ref.field,
          code: "seat_kind",
          message: `seat "${role}" is for people who are ${kind === "reached" ? "contacted" : kind}, so it can't ${USE_WORDS[ref.use]}`,
        });
      }
    }
  });
  return out;
}

/** The seats a process names, each with the uses it is named for. */
export function seatsNamed(process: Pick<Process, "steps">): Map<string, Set<SeatUse>> {
  const out = new Map<string, Set<SeatUse>>();
  walkSteps(process, ({ step }) => {
    for (const ref of whoRefsOfStep(step)) {
      const role = seatRoleOf(ref.who);
      if (role === null) continue;
      const uses = out.get(role) ?? new Set<SeatUse>();
      uses.add(ref.use);
      out.set(role, uses);
    }
  });
  return out;
}

/** Who fills one seat, as a run reads it. */
export interface SeatPeople {
  /** Client users, in order. */
  userIds: readonly string[];
  /** Client users asked only after them (in turn), for a `signs` seat. */
  backupUserIds: readonly string[];
  /** Directory contacts (told and reached seats). */
  contactIds: readonly string[];
}

/** Role → who fills it. A seat missing from the map is empty. */
export type Seats = Readonly<Record<string, SeatPeople>>;

/** The seats as a client agent's bindings hold them (`agent.people`). */
export function seatsFromBindings(
  bindings: Readonly<
    Record<
      string,
      {
        contactIds?: readonly string[] | undefined;
        userIds?: readonly string[] | undefined;
        backupUserIds?: readonly string[] | undefined;
      }
    >
  >,
): Seats {
  const out: Record<string, SeatPeople> = {};
  for (const [role, b] of Object.entries(bindings)) {
    out[role] = {
      userIds: [...(b.userIds ?? [])],
      backupUserIds: [...(b.backupUserIds ?? [])],
      contactIds: [...(b.contactIds ?? [])],
    };
  }
  return out;
}

/** Who answers for an empty seat that must reach someone: the client admin (as approvers default). */
export const EMPTY_SEAT_FALLBACK = "client_admin";

/** The most people one seat expands to in one approval. */
const SEAT_APPROVERS_MAX = 10;

function one(seats: Seats, who: string): string {
  const role = seatRoleOf(who);
  if (role === null) return who;
  const s = seats[role];
  return s?.userIds[0] ?? s?.backupUserIds[0] ?? EMPTY_SEAT_FALLBACK;
}

function many(seats: Seats, list: readonly string[]): string[] {
  const out: string[] = [];
  for (const who of list) {
    const role = seatRoleOf(who);
    if (role === null) {
      out.push(who);
      continue;
    }
    const s = seats[role];
    out.push(...(s?.userIds ?? []), ...(s?.contactIds ?? []));
  }
  return [...new Set(out)];
}

function fillThen(seats: Seats, t: DeadlineThen): DeadlineThen {
  if (typeof t === "object" && "escalate" in t) {
    return {
      escalate: {
        to: one(seats, t.escalate.to),
        deadline: fillDeadline(seats, t.escalate.deadline),
      },
    };
  }
  return t;
}

function fillDeadline(seats: Seats, d: Deadline): Deadline {
  const out: Deadline = { ...d, ifNoAnswer: fillThen(seats, d.ifNoAnswer) };
  if (d.tell) out.tell = many(seats, d.tell);
  return out;
}

function fillApproval(seats: Seats, a: ApprovalCheck): ApprovalCheck {
  const out: ApprovalCheck = { ...a, ifNoAnswer: fillThen(seats, a.ifNoAnswer) };
  if (!a.approvers) return out;
  const list: NonNullable<ApprovalCheck["approvers"]> = [];
  for (const ap of a.approvers) {
    const deadline = ap.deadline ? fillDeadline(seats, ap.deadline) : undefined;
    const role = seatRoleOf(ap.who);
    if (role === null) {
      list.push(deadline ? { ...ap, deadline } : ap);
      continue;
    }
    const s = seats[role];
    // DECISION (setup-plan §4.1): backups follow the seat's people only when one answer decides
    // (in turn): an away person is skipped at once, so the backup is asked. `any` and `all` ask
    // the seat's people alone, so a backup never adds a signature `all` would wait for.
    const people = [
      ...(s?.userIds ?? []),
      ...((a.mode ?? "in_turn") === "in_turn" ? (s?.backupUserIds ?? []) : []),
    ];
    const unique = [...new Set(people)];
    // An empty seat is the default approver: the agent's, then the client's rules, then the admin.
    if (unique.length === 0) list.push(deadline ? { deadline } : {});
    for (const who of unique) list.push(deadline ? { who, deadline } : { who });
  }
  out.approvers = list.slice(0, SEAT_APPROVERS_MAX);
  return out;
}

function fillNotify(seats: Seats, n: NotifyCheck): NotifyCheck {
  const to = many(seats, n.to);
  const out: NotifyCheck = { ...n, to: to.length ? to : [EMPTY_SEAT_FALLBACK] };
  if (n.urgent) out.urgent = { ...n.urgent, ifNoAnswer: fillThen(seats, n.urgent.ifNoAnswer) };
  return out;
}

function fillStep(seats: Seats, step: Step): Step {
  const s = { ...step } as Step;
  if (step.checks) {
    const checks = { ...step.checks };
    if (checks.confer) {
      checks.confer = {
        ...checks.confer,
        with: checks.confer.with.map((c) => {
          const deadline = c.deadline ? fillDeadline(seats, c.deadline) : undefined;
          if ("person" in c) {
            return { ...c, person: one(seats, c.person), deadline: deadline as Deadline };
          }
          return deadline ? { ...c, deadline } : c;
        }),
      };
    }
    if (checks.approval) checks.approval = fillApproval(seats, checks.approval);
    if (checks.notify) checks.notify = checks.notify.map((n) => fillNotify(seats, n));
    s.checks = checks;
  }
  switch (s.kind) {
    case "person":
      s.assignee = one(seats, s.assignee);
      s.deadline = fillDeadline(seats, s.deadline);
      break;
    case "conversation":
      s.deadline = fillDeadline(seats, s.deadline);
      break;
    // Collect reports: owners stay seats (reach out finds the role's contacts on the agent);
    // the person a late report is escalated to is one of the client's people, as a person step's.
    case "collect":
      if (s.escalate) {
        s.escalate = {
          ...s.escalate,
          to: one(seats, s.escalate.to),
          deadline: fillDeadline(seats, s.escalate.deadline),
        };
      }
      break;
    case "notify":
      s.notify = fillNotify(seats, s.notify);
      break;
    case "process":
      if (s.approvals) {
        s.approvals = Object.fromEntries(
          Object.entries(s.approvals).map(([k, a]) => [k, fillApproval(seats, a)]),
        );
      }
      break;
    case "if":
      s.paths = s.paths.map((p) => ({ ...p, steps: p.steps.map((x) => fillStep(seats, x)) }));
      s.otherwise = {
        ...s.otherwise,
        steps: s.otherwise.steps.map((x) => fillStep(seats, x)),
      };
      break;
    case "for_each":
    case "repeat":
      s.steps = s.steps.map((x) => fillStep(seats, x));
      break;
    default:
      break;
  }
  return s;
}

/**
 * The process with every seat it names replaced by the people in it: an approval's seat becomes
 * one approver per person (in turn, then its backups), a person step's or an escalation's the
 * first person, a notify's or a deadline's `tell` everyone. An empty seat falls back the way an
 * unnamed approver does (the default approver) or, where someone must be asked or told, to the
 * client admin. Ids, names and everything else are kept; nothing is mutated.
 */
export function fillSeats<P extends Pick<Process, "steps">>(process: P, seats: Seats): P {
  return { ...process, steps: process.steps.map((s) => fillStep(seats, s)) };
}

/** Whether a process names any seat (so a run without bindings can skip the rewrite). */
export function namesSeats(process: Pick<Process, "steps">): boolean {
  return seatsNamed(process).size > 0;
}
