// M46 (docs/plan.md §1.76): a change outside that a person signs as they make it, from the back
// office, with no run: publishing a guide on a client's site. The pack action asks for it
// (`signedWrite`, handed to every pack action by routes/packs.ts); this records it as an
// `external_action` the person approved (approved_by, approved_at, no run, no agent) and runs it
// once through its connector with the agents' `executeAction`, which captures the before state,
// executes by the action's idempotency key and records the outcome (invariant 8). Nothing here
// names a pack or a connector.
//
// What the person signs is the action itself: the back office shows the change (the guide, its
// checks, where it goes) and the person confirms it. The connection's matrix still applies (a
// verb that is off refuses), and a test run never reaches here.

import { executeAction } from "@countersign/agents";
import { connection, externalAction, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Services } from "./http";
import { forClient, runDepsFromEnv, runtimeFor } from "./runs/execute";

export interface SignedWriteRequest {
  connectionId: string;
  tool: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
  title: string;
}

export type SignedWriteOutcome =
  | { status: "done"; actionId: string; output: unknown }
  | { status: "failed"; actionId: string | null; error: string };

export type SignedWrite = (request: SignedWriteRequest) => Promise<SignedWriteOutcome>;

/** Keys of signed writes are their own namespace, apart from runs' `<run>:<step>:<n>`. */
export const SIGNED_KEY_PREFIX = "signed:";

/** The signed writes one person may make for one client, in this request. */
export function signedWriteFor(
  services: Pick<Services, "db" | "env" | "platform" | "instances">,
  who: { tenantId: string; userId: string },
): SignedWrite {
  const { tenantId, userId } = who;
  return async (request) => {
    const tool = services.platform.tools.get(request.tool);
    if (tool?.kind !== "connector" || tool.spec.sideEffect !== "external") {
      return { status: "failed", actionId: null, error: `${request.tool} isn't a change outside` };
    }
    const actionId = await withTenant(services.db, tenantId, async (tx) => {
      const [conn] = await tx
        .select({ id: connection.id, connector: connection.connector })
        .from(connection)
        .where(and(eq(connection.tenantId, tenantId), eq(connection.id, request.connectionId)));
      if (!conn) return null;
      if (!services.platform.tools.forConnector(request.tool, conn.connector)) return null;
      const key = `${SIGNED_KEY_PREFIX}${request.idempotencyKey}`;
      const [inserted] = await tx
        .insert(externalAction)
        .values({
          tenantId,
          connectionId: conn.id,
          tool: request.tool,
          runId: null,
          agentVersionId: null,
          input: request.input,
          idempotencyKey: key,
          status: "approved",
          approvedBy: userId,
          approvedAt: new Date(),
        })
        .onConflictDoNothing({ target: [externalAction.tenantId, externalAction.idempotencyKey] })
        .returning({ id: externalAction.id });
      if (inserted) return inserted.id;
      // The same change asked again (a double click): the first stands, written once.
      const [existing] = await tx
        .select({ id: externalAction.id })
        .from(externalAction)
        .where(and(eq(externalAction.tenantId, tenantId), eq(externalAction.idempotencyKey, key)));
      return existing?.id ?? null;
    });
    if (!actionId) {
      return {
        status: "failed",
        actionId: null,
        error: "that connection isn't this client's, or doesn't make this change",
      };
    }
    const runtime = runtimeFor(
      forClient(
        runDepsFromEnv(services.env, {
          db: services.db,
          platform: services.platform,
          instances: services.instances,
        }),
        tenantId,
      ),
    );
    const outcome = await executeAction(runtime, { tenantId, actionId });
    if (outcome.status === "done") return { status: "done", actionId, output: outcome.output };
    if (outcome.status === "failed") return { status: "failed", actionId, error: outcome.error };
    return { status: "failed", actionId, error: `the change is ${outcome.action.status}` };
  };
}
