// See it work's shared pieces (docs/setup-plan.md §6; docs/plan.md §1.185, SU4 and SU5): the agent
// as Getting started reads it (the client's own copy, inside the request's one client: invariant
// 1), the steps its SOP numbers, and its guide in `stage_state.guide`, written with the row locked.
import {
  type AgentGuideState,
  type AnyAgentBundle,
  readAgentGuide,
  type StoredTry,
} from "@countersign/core";
import { agent, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { sopVersion } from "../sop/inputs";

export type AgentRow = typeof agent.$inferSelect;

/** The client's own agent (never a template or a test copy); locked when it will be written. */
export async function seeAgent(
  tx: Tx,
  tenantId: string,
  agentId: string,
  lock = false,
): Promise<AgentRow> {
  const q = tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId), eq(agent.kind, "client")));
  const [row] = lock ? await q.for("update") : await q;
  if (!row || row.testCopy || row.status !== "active") throw notFound("agent");
  return row;
}

/** A viewer reads See it work; only someone who can sign says what is right about it. */
// DECISION: marks and verdicts are a signer's, as tries are (owner, §1.185 q2): a viewer's word on
// a step would read as the client's.
export function refuseViewer(input: { canSign: boolean }): void {
  if (!input.canSign) {
    throw new HttpError(403, "cannot_sign", "Only someone who can sign says what's right here.");
  }
}

/** Being set up: on the bench, or with no stage yet (as Getting started's overview reads it). */
export function beingSetUp(row: Pick<AgentRow, "stage" | "runStatus">): boolean {
  return row.runStatus !== "retired" && (row.stage === null || row.stage === "bench");
}

/** A step as the walkthrough knows it: its name, and whether it is at the top of its workflow. */
export interface WalkStep {
  id: string;
  name: string;
  top: boolean;
}

type AnyStep = { id: string; name?: string; kind: string } & Record<string, unknown>;

/**
 * Every step of the version's workflows that are on, in run order, as the SOP numbers them: the
 * top-level steps and what an `if` (or a v3 `fork`), a `for_each` or a `repeat` holds.
 */
export function walkStepsOf(bundle: Pick<AnyAgentBundle, "workflows">): WalkStep[] {
  const out: WalkStep[] = [];
  const visit = (step: AnyStep, top: boolean) => {
    out.push({ id: step.id, name: typeof step.name === "string" ? step.name : step.id, top });
    if (step.kind === "if" || step.kind === "fork") {
      for (const p of (step.paths as { steps?: AnyStep[] }[] | undefined) ?? []) {
        for (const c of p.steps ?? []) visit(c, false);
      }
      for (const c of (step.otherwise as { steps?: AnyStep[] } | undefined)?.steps ?? []) {
        visit(c, false);
      }
    } else if (step.kind === "for_each" || step.kind === "repeat") {
      for (const c of (step.steps as AnyStep[] | undefined) ?? []) visit(c, false);
    }
  };
  for (const w of bundle.workflows) {
    if (w.enabled === false) continue;
    for (const s of (w.workflow as { steps?: AnyStep[] }).steps ?? []) visit(s, true);
  }
  return out;
}

/** The steps of the version the SOP reads (the live one, else the one being set up). */
export async function sopStepsOf(tx: Tx, row: AgentRow): Promise<WalkStep[]> {
  const v = await sopVersion(tx, row);
  return v ? walkStepsOf(v.bundle as AnyAgentBundle) : [];
}

export function guideOf(row: Pick<AgentRow, "stageState">): AgentGuideState {
  return readAgentGuide(row.stageState);
}

/** The tries recorded for the agent, newest first. */
export function triesOf(guide: AgentGuideState): StoredTry[] {
  return [...(guide.tries ?? [])].reverse();
}

/** Writes the guide into `stage_state`, keeping every other key (the caller holds the row lock). */
export async function writeGuide(tx: Tx, row: AgentRow, guide: AgentGuideState): Promise<void> {
  const state = { ...((row.stageState ?? {}) as Record<string, unknown>), guide };
  await tx
    .update(agent)
    .set({ stageState: state as AgentRow["stageState"] })
    .where(and(eq(agent.id, row.id), eq(agent.tenantId, row.tenantId as string)));
}
