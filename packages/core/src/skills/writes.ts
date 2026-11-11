// The skill model (owner, 2026-11-10): skills never write and never message anyone, our own
// records included ("skills think, tools act"). Every write is a write step calling one tool. A
// write to our own database (a tool with side effect `internal`) shows as "Save to records",
// approval off by default (the operator may turn it on); a write to a client's tool (`external`)
// shows as "Change in <connector name>", approval on by default (invariant 8). Same write step
// underneath: only the label and the default differ. One rule here, so the builder, the run view
// and the Builder (the AI) say and default the same.

import type { ApprovalCheck } from "../process/schema";
import type { ToolSpec } from "../schemas/tool";

export type WriteStepKind = "save_to_records" | "change_in";

export interface WriteStepLabel {
  kind: WriteStepKind;
  /** "Save to records", or "Change in QuickBooks Online". */
  text: string;
}

/** Whether a write step's tool writes to a client's tool (unknown tools count as external). */
// DECISION: a tool the registries don't know is treated as a client's tool, so its label says
// so and its approval starts on: the safe side of invariant 8.
export function writesToClientTool(tool: Pick<ToolSpec, "sideEffect"> | undefined): boolean {
  return tool === undefined || tool.sideEffect === "external";
}

/**
 * How a write step reads: "Save to records" for the platform's own records, "Change in
 * <connector>" for a client's tool. `connectorName` is the connector's display name (its
 * manifest's `name`); without one the tool's connector id is used.
 */
export function writeStepLabel(
  _step: { kind: string },
  tool: Pick<ToolSpec, "sideEffect" | "connector" | "source"> | undefined,
  connectorName?: string | null,
): WriteStepLabel {
  if (!writesToClientTool(tool)) return { kind: "save_to_records", text: "Save to records" };
  const name = connectorName ?? tool?.connector ?? tool?.source ?? "the client's tool";
  return { kind: "change_in", text: `Change in ${name}` };
}

/** The approval a new write step starts with: on for a client's tool, none for our records. */
export function defaultWriteApproval(
  tool: Pick<ToolSpec, "sideEffect"> | undefined,
): ApprovalCheck | undefined {
  if (!writesToClientTool(tool)) return undefined;
  return { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" };
}
