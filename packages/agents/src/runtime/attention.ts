// Connections that need a person, as the runtime finds them (docs/plan.md §1.28).

import { type ConnectionRef, ReconnectRequiredError } from "@countersign/connectors";
import type { RuntimeDeps } from "./context";

/**
 * A connector that says the client must sign in again (ReconnectRequiredError): the connection is
 * marked as needing a person and `connection.needs_attention` is emitted, once (docs/plan.md
 * §1.28). Best effort: the call fails with its own error whatever happens here.
 */
export async function noteReconnect(
  deps: RuntimeDeps,
  tenantId: string,
  conn: ConnectionRef,
  error: unknown,
): Promise<void> {
  const reconnect =
    error instanceof ReconnectRequiredError ||
    (error instanceof Error && error.name === "ReconnectRequiredError");
  if (!reconnect || !deps.ports.attention) return;
  try {
    await deps.ports.attention.needsAttention(tenantId, {
      connectionId: conn.id,
      reason: "signin_expired",
      detail: (error as Error).message,
    });
  } catch (e) {
    deps.logger?.error("could not mark the connection as needing a person", { error: String(e) });
  }
}
