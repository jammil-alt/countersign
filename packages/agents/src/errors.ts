// Errors the registries and the runtime raise for callers (apps/api maps `code` to HTTP answers).

export type AgentsErrorCode =
  | "not_found"
  | "invalid_bundle"
  | "invalid_definition"
  | "no_op"
  | "not_a_template"
  | "not_a_client_agent"
  | "not_linked"
  | "no_live_version"
  | "no_update"
  | "merge_conflicts"
  | "activation_refused"
  | "invalid_state"
  | "unknown_skill"
  | "unknown_tool"
  | "not_assignee"
  | "test_run";

export class AgentsError extends Error {
  override name = "AgentsError";
  constructor(
    readonly code: AgentsErrorCode,
    message: string,
    /** Structured detail (validation errors, merge conflicts, activation problems). */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function notFound(what: string): AgentsError {
  return new AgentsError("not_found", `${what} not found`);
}
