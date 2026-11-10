// The MCP server's audit trail (docs/plan.md §1.34, §1.86): one entry per tool call, under the
// signed-in person's name, with the tool, its arguments (a confirm token only as "[token]"), the
// outcome and the time it took. Written as one JSON log line, which Workers Logs keeps (wrangler.jsonc `observability`).
//
// A write also leaves what the back office's own write leaves (feedback's `resolved_by`), so the
// database says who did it either way; the log line says it was through the MCP server.

import { CONFIRM_ARG } from "./confirm";

export interface McpAuditEntry {
  /** `mcp.tool_call`. */
  event: "mcp.tool_call";
  via: "mcp";
  at: string;
  environment: string;
  /** Whose tools: the back office's (an operator) or the portal's (a client's admin or user). */
  audience: "ops" | "client";
  userId: string;
  email: string;
  tool: string;
  args: Record<string, unknown>;
  /** ok; error (the tool answered with an error); preview (step one of a write); done (step two). */
  outcome: "ok" | "error" | "preview" | "done";
  /** The error code, for `error`. */
  code?: string;
  /** What a write changed, e.g. `{ feedback: "<id>" }`. */
  target?: Record<string, string>;
  durationMs: number;
}

export interface McpAuditSink {
  record(entry: McpAuditEntry): Promise<void>;
}

/** Arguments as logged: the confirm token is never written down. */
export function loggedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return CONFIRM_ARG in args ? { ...args, [CONFIRM_ARG]: "[token]" } : { ...args };
}

// DECISION: a log line, not a table, until the audit table (#82, `audit_event`) lands: then a sink
// that inserts there is passed as AppDeps.mcpAudit (HOOK), and this stays as the fallback.
export const logAuditSink: McpAuditSink = {
  async record(entry) {
    console.log(JSON.stringify(entry));
  },
};
