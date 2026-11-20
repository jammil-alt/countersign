// An agent's own phone line given back when the agent is retired (docs/plan.md §1.160, owner
// 2026-11-20). The number stays in the client's Twilio account (we keep paying Twilio for it), now
// the account's: texts to it reach the account's agents and Sloan, and the back office's Messaging
// marks it spare, for the operator to give to another agent or release.
import { readTwilioConfig, TWILIO_CONNECTOR_ID } from "@countersign/connectors";
import { connection, connectionChange, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";

/**
 * Takes `agentId` off every number it owns in the client's Twilio account, each recorded as a
 * connection change. Returns the numbers given back. No call to Twilio: the number stays bought.
 */
// DECISION: given back at once, not left marked for the operator: a retired agent's line is billed
// to nobody and heard by nobody, so leaving it marked only strands the people who text it.
export async function returnAgentLine(
  tx: Tx,
  input: { tenantId: string; agentId: string; actorId: string | null; reason: string },
): Promise<string[]> {
  const rows = await tx
    .select()
    .from(connection)
    .where(
      and(eq(connection.tenantId, input.tenantId), eq(connection.connector, TWILIO_CONNECTOR_ID)),
    );
  const returned: string[] = [];
  for (const row of rows) {
    const config = readTwilioConfig(row.config);
    if (!config) continue;
    const owned = config.numbers.filter((n) => n.agentId === input.agentId);
    if (owned.length === 0) continue;
    await tx
      .update(connection)
      .set({
        config: {
          ...config,
          numbers: config.numbers.map((n) =>
            n.agentId === input.agentId ? { ...n, agentId: null } : n,
          ),
        } as unknown as Record<string, unknown>,
      })
      .where(and(eq(connection.id, row.id), eq(connection.tenantId, input.tenantId)));
    for (const n of owned) {
      await tx.insert(connectionChange).values({
        tenantId: input.tenantId,
        connectionId: row.id,
        actorId: input.actorId,
        change: {
          by: "operator",
          kind: "phone_line",
          number: n.phoneNumber,
          from: input.agentId,
          to: null,
          reason: input.reason,
        },
      });
      returned.push(n.phoneNumber);
    }
  }
  return returned;
}
