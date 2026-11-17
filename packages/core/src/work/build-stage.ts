// Where an agent build stands in Build's Agent builds pipeline (docs/plan.md §1.123): derived from
// the build, its agent's go-live stage and its requirements request; never stored.

import type { BuildPhase, BuildStatus } from "../build/build";
import type { WorkBuildStage } from "./pipelines";

export interface BuildStageInput {
  status: BuildStatus;
  path: "new" | "template";
  phase: BuildPhase;
  /** The client agent's go-live stage (bench, trial, signoff, live), if it has one. */
  agentStage: string | null;
  /** The requirements request's progress, when one was sent. */
  requirements: { answered: number; total: number } | null;
  /** Connections the agent needs that the client hasn't made. */
  missingConnections: number;
}

export function buildPipelineStage(b: BuildStageInput): WorkBuildStage {
  if (b.status === "live" || b.agentStage === "live") return "live";
  if (b.requirements && b.requirements.answered < b.requirements.total) return "requirements";
  // A new agent is built through the Builder's phases until its client test.
  if (b.path === "new" && b.phase !== "client_test" && b.phase !== "qa") return "building";
  if (b.missingConnections > 0) return "connect";
  if (b.agentStage === "trial") return "trial";
  if (b.agentStage === "signoff") return "signoff";
  // DECISION: a template build with no requirements sent and every connection made is at the bench.
  return "bench";
}
