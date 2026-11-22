// Getting started's See it work (docs/setup-plan.md §6; docs/plan.md §1.185, SU4 and SU5): stream
// SEE. The walkthrough's marks and the tries started from the portal.
//
// The steps the client reads are the agent's SOP (`GET /api/services/:id/sop`, made by code from
// its setup): this file keeps only what the client said about each one, by the step's id, in
// `stage_state.guide.marks`. "Looks right" is a mark; "We do it differently" files a request to us
// tied to the step (the manual's "This is wrong because…", `manualFeedback`) and keeps its number.
// Their words are data (invariant 9): a request, never a change to the agent. Choices within
// bounds are the agent's adjustable settings (`/api/services/:id/adjustable`), unchanged here.
import {
  SETUP_TRIES_MAX,
  type SetupLeft,
  type WalkMarkBody,
  type WalkthroughView,
} from "@countersign/core";
import type { Tx } from "@countersign/db";
import { notFound } from "../http";
import { manualFeedback } from "./adjust";
import { beingSetUp, guideOf, refuseViewer, seeAgent, sopStepsOf, writeGuide } from "./see-agent";
import { tryCandidates, tryRunning, tryViews } from "./try";

export interface SeeInput {
  tenantId: string;
  agentId: string;
  userId: string;
  name: string | null;
  /** Whether this person may try the agent (a signer; a viewer only reads). */
  canSign: boolean;
  /** The agents a limited client user sees (§1.122); null for everyone else. */
  sees?: readonly string[] | null;
}

export async function walkthrough(tx: Tx, input: SeeInput): Promise<WalkthroughView> {
  const row = await seeAgent(tx, input.tenantId, input.agentId);
  const guide = guideOf(row);
  const steps = new Set((await sopStepsOf(tx, row)).map((s) => s.id));
  // A mark on a step the agent no longer has stays stored, unread.
  const marks = Object.entries(guide.marks ?? {})
    .filter(([id]) => steps.has(id))
    .map(([stepId, m]) => ({
      stepId,
      state: m.state,
      byName: m.byName,
      at: m.at,
      text: m.state === "asked" ? (m.text ?? null) : null,
      request:
        m.state === "asked" && m.requestId && m.number !== undefined
          ? { id: m.requestId, number: m.number }
          : null,
    }));
  const used = guide.tries?.length ?? 0;
  const candidates = await tryCandidates(tx, row, input);
  // DECISION: "may try now": someone who can sign, while the agent is being set up, with a try
  // left and none running. The page says which of these holds it back.
  const canTry =
    input.canSign &&
    beingSetUp(row) &&
    used < SETUP_TRIES_MAX &&
    candidates.length > 0 &&
    !(await tryRunning(tx, row));
  return {
    agentId: row.id,
    name: row.serviceName ?? row.name,
    marks,
    tries: { used, max: SETUP_TRIES_MAX, recent: await tryViews(tx, row) },
    candidates,
    canTry,
    canSign: input.canSign,
  };
}

/** How a request quotes the step it is about. */
const LINE_MAX = 1000;

export async function markStep(
  tx: Tx,
  input: SeeInput & { stepId: string; body: WalkMarkBody },
): Promise<void> {
  refuseViewer(input);
  const row = await seeAgent(tx, input.tenantId, input.agentId, true);
  const step = (await sopStepsOf(tx, row)).find((s) => s.id === input.stepId);
  if (!step) throw notFound("step");
  const at = new Date().toISOString();
  const by = { by: input.userId, byName: input.name, at };
  const guide = guideOf(row);
  // DECISION: the latest word on a step stands: Looks right after a "different" replaces the mark,
  // and the request it filed stays with us; a second "different" files a second request.
  let mark: NonNullable<typeof guide.marks>[string];
  if ("ok" in input.body) {
    mark = { state: "ok", ...by };
  } else {
    const request = await manualFeedback(tx, {
      tenantId: input.tenantId,
      agentId: row.id,
      body: {
        section: "how",
        lineId: step.id,
        line: step.name.slice(0, LINE_MAX),
        because: input.body.different,
      },
      actor: { userId: input.userId, name: input.name, side: "client" },
    });
    mark = {
      state: "asked",
      ...by,
      text: input.body.different,
      requestId: request.id,
      number: request.number,
    };
  }
  await writeGuide(tx, row, { ...guide, marks: { ...(guide.marks ?? {}), [step.id]: mark } });
}

/** What See it work still holds per agent (agent id → lines), and how far it is. */
// DECISION: "Read how it works" is left while any top-level step of the SOP has no mark (a step
// inside a decision or a loop is read with its parent); "Try it on a real one" while no try was
// made and there is something to try it on. See it work is anyone's who sees the agent, so its
// lines name nobody.
export async function seeProgress(
  tx: Tx,
  input: { tenantId: string; agentIds: readonly string[] },
): Promise<{ left: Map<string, SetupLeft[]>; done: number; total: number }> {
  const left = new Map<string, SetupLeft[]>();
  let done = 0;
  for (const agentId of input.agentIds) {
    const row = await seeAgent(tx, input.tenantId, agentId);
    const guide = guideOf(row);
    const top = (await sopStepsOf(tx, row)).filter((s) => s.top);
    const lines: SetupLeft[] = [];
    if (top.some((s) => !guide.marks?.[s.id])) {
      lines.push({ key: "see", chapter: "see", label: "Read how it works", who: null });
    }
    if (
      (guide.tries?.length ?? 0) === 0 &&
      (await tryCandidates(tx, row, { tenantId: input.tenantId, sees: null })).length > 0
    ) {
      lines.push({ key: "try", chapter: "see", label: "Try it on a real one", who: null });
    }
    if (lines.length === 0) done += 1;
    left.set(agentId, lines);
  }
  return { left, done, total: input.agentIds.length };
}
