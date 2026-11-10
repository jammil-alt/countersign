// R8 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Checks"): the portal timeline's view of a run
// whose workflow may be a v4 process: finding a row's step in either schema, which steps the client
// sees, and what each step's checks did (core's `run-checks`), with the names the client knows.
// Never a model, a prompt or a cost (invariant 11): a second check's note is model text, so it
// stays in the back office.

import {
  approvalOf,
  checkKindOf,
  conferOf,
  findStep,
  noAnswerOf,
  processes,
  type Step,
  stepNodeOf,
  type TimelineChecks,
  urgentOf,
  type Workflow,
} from "@countersign/core";
import { appUser, type stepRun, type Tx } from "@countersign/db";
import { inArray } from "drizzle-orm";

type StoredWorkflow = Workflow | processes.Process;

/** What the timeline reads of a step, v3 or v4: its id, kind, name and client label. */
export type TimelineStepDef = Step | processes.Step;

/** Finds a step by id in a stored v3 workflow or a v4 process. */
export function stepFinder(
  workflow: StoredWorkflow | undefined,
): (id: string) => TimelineStepDef | undefined {
  if (!workflow) return () => undefined;
  if (workflow.schemaVersion === 4) {
    return (id) => processes.findStep(workflow, id)?.step;
  }
  return (id) => findStep(workflow, id)?.step;
}

/** The step a row belongs to: its own node, or the step a check row (`:confer:`…) checks. */
export function stepOfRow(
  find: (id: string) => TimelineStepDef | undefined,
  nodeId: string,
): TimelineStepDef | undefined {
  const { node } = stepNodeOf(nodeId);
  return find(node) ?? find(node.split(":").at(-1) ?? node);
}

/** Check rows the client sees, besides the step rows themselves. */
export function isClientCheckRow(nodeId: string): boolean {
  const kind = checkKindOf(nodeId);
  return kind === "confer" || kind === "notify";
}

type RowSel = typeof stepRun.$inferSelect;
interface ItemSel {
  id: string;
  kind: string;
  status: string;
  payload: unknown;
  resolution: unknown;
  assigneeRole: string | null;
  assigneeUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

/**
 * Each row's check fields for the portal: a confer with the person's name, the approvers (named
 * where they are the client's users) and the mode, no-answer outcomes and an urgent notice's Seen.
 */
export async function timelineChecks(
  tx: Tx,
  rows: readonly RowSel[],
  items: readonly ItemSel[],
  runError: unknown,
  find: (id: string) => TimelineStepDef | undefined,
): Promise<Map<string, TimelineChecks>> {
  const asItems = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    status: i.status,
    payload: (i.payload ?? {}) as Record<string, unknown>,
    resolution: i.resolution,
    assigneeRole: i.assigneeRole,
    assigneeUserId: i.assigneeUserId,
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  }));
  const out = new Map<string, TimelineChecks>();
  const userIds = new Set<string>();
  for (const r of rows) {
    const checks: TimelineChecks = {};
    const confer = conferOf(r);
    if (confer) {
      // A second check's note is a model's words: never in the portal.
      checks.confer = {
        ...confer,
        note: confer.reviewer === "ai" ? null : confer.note,
        name: null,
      };
      if (confer.who) userIds.add(confer.who);
    }
    const noAnswer = noAnswerOf(r, runError);
    if (noAnswer) checks.noAnswer = noAnswer;
    const step = stepOfRow(find, r.nodeId);
    const mode =
      step && "checks" in step && step.checks?.approval?.mode
        ? step.checks.approval.mode
        : "in_turn";
    if (!checkKindOf(r.nodeId)) {
      const approval = approvalOf(r, asItems, mode);
      if (approval) {
        checks.approval = approval;
        for (const a of approval.approvers) if (a.userId) userIds.add(a.userId);
      }
    }
    const urgent = urgentOf(r, asItems);
    if (urgent) checks.urgent = urgent;
    if (Object.keys(checks).length > 0) out.set(r.id, checks);
  }
  const ids = [...userIds].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const names = new Map<string, string | null>();
  if (ids.length > 0) {
    const found = await tx
      .select({ id: appUser.id, name: appUser.name })
      .from(appUser)
      .where(inArray(appUser.id, ids));
    for (const u of found) names.set(u.id, u.name);
  }
  for (const checks of out.values()) {
    if (checks.confer?.who) checks.confer.name = names.get(checks.confer.who) ?? null;
    for (const a of checks.approval?.approvers ?? []) {
      a.name = a.userId ? (names.get(a.userId) ?? null) : null;
    }
  }
  return out;
}
