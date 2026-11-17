// The MCP server's audit trail (docs/plan.md §1.34, §1.89, §1.35): one entry per tool call, under
// the signed-in person's name, with the tool, its arguments (a confirm token only as "[token]"), the
// outcome and the time it took. Each entry is an `audit_event` row (`mcp.tool_call <tool>`), as
// every other read and write on a person's behalf is; a sign-in the server refuses is one too
// (`mcp.sign_in`, refused).
//
// A write also leaves what the back office's own write leaves (feedback's `resolved_by`), so the
// database says who did it either way; the row says it was through the MCP server.

import { isUuid } from "@countersign/core";
import type { Db } from "@countersign/db";
import type { Context } from "hono";
import { type AuditEntry, auditAlone } from "../audit";
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
  /** The person's role, for the audit row (operator, client_admin, client_user). */
  role?: string | null;
  /** The client the call acted in, when it named one of the caller's; null across clients. */
  tenantId?: string | null;
  tool: string;
  args: Record<string, unknown>;
  /** ok; error (the tool answered with an error); preview (step one of a write); done (step two). */
  outcome: "ok" | "error" | "preview" | "done";
  /** The error code, for `error`. */
  code?: string;
  /** The error's HTTP status, for `error`. */
  status?: number;
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

/**
 * The audit row for a tool call. Rows hold ids, never bodies (§1.35): the arguments that are ids
 * (a client, a run, a feedback item) go in its target, free text (a note, a search) does not.
 */
export function mcpAuditRow(entry: McpAuditEntry): AuditEntry {
  const ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.args)) {
    if (k !== CONFIRM_ARG && typeof v === "string" && isUuid(v)) ids[k] = v;
  }
  const failed = entry.outcome === "error";
  return {
    tenantId: entry.tenantId && isUuid(entry.tenantId) ? entry.tenantId : null,
    actorKind: "user",
    actorUserId: entry.userId,
    actorEmail: entry.email,
    actorRole: entry.role ?? null,
    action: `mcp.tool_call ${entry.tool}`,
    outcome: failed ? ((entry.status ?? 500) >= 500 ? "error" : "refused") : "ok",
    httpStatus: failed ? (entry.status ?? 500) : 200,
    target: {
      ...ids,
      ...(entry.target ?? {}),
      audience: entry.audience,
      result: entry.outcome,
      ...(entry.code ? { code: entry.code.slice(0, 100) } : {}),
      durationMs: String(entry.durationMs),
    },
  };
}

/** Each tool call as an `audit_event` row, written alone (auditAlone: it never fails the call). */
export function auditEventSink(db: Db, c: Context | null): McpAuditSink {
  return {
    async record(entry) {
      await auditAlone(db, c, mcpAuditRow(entry));
    },
  };
}

/** Why the server refused to let a request in, for its `mcp.sign_in` audit row. */
export type McpRefusal =
  | "no_token"
  | "invalid_token"
  | "unknown_user"
  | "no_membership"
  | "sign_in_unavailable";

/**
 * A refused MCP sign-in as an audit row: never the token or its claims, only why, and who when
 * the token named a Mezonas user.
 */
export async function auditRefusedSignIn(
  db: Db,
  c: Context,
  refusal: {
    reason: McpRefusal;
    status: number;
    /** A fixed phrase (the verifier's), never the token or a claim. */
    detail?: string;
    userId?: string;
    email?: string;
  },
): Promise<void> {
  await auditAlone(db, c, {
    tenantId: null,
    actorKind: refusal.userId ? "user" : "anonymous",
    actorUserId: refusal.userId ?? null,
    actorEmail: refusal.email ?? null,
    action: "mcp.sign_in",
    outcome: refusal.status >= 500 ? "error" : "refused",
    httpStatus: refusal.status,
    target: {
      reason: refusal.reason,
      ...(refusal.detail ? { detail: refusal.detail.slice(0, 100) } : {}),
    },
  });
}
