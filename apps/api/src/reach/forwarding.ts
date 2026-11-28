// A client's forwarding address (stream D), made when it is first needed. The portal makes it the
// first time a client looks at forwarding; the back office makes it when it sets up a client's
// email sending, since an agent's replies come back to it (staging, 2026-11-27: the Sandbox, which
// has no client people to open its portal, had none, so replies to its agents were never read).
import {
  ensureUploadConnection,
  forwardingAddress,
  forwardingOf,
  newForwardingSecret,
  type UploadConnectionRow,
  updateForwarding,
} from "@countersign/connectors";
import { type Tx, tenant } from "@countersign/db";
import { eq } from "drizzle-orm";

/**
 * The client's upload connection with its forwarding address set, on this deployment's forwarding
 * domain (none when the deployment has no forwarding domain: then the row as it was).
 */
export async function withForwardingAddress(
  tx: Tx,
  input: {
    tenantId: string;
    domain: string | undefined;
    actorId: string | null;
    row?: UploadConnectionRow;
  },
): Promise<UploadConnectionRow> {
  const domain = input.domain?.trim().toLowerCase();
  const conn = input.row ?? (await ensureUploadConnection(tx, input.tenantId));
  if (!domain || forwardingOf(conn).address) return conn;
  const [t] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, input.tenantId));
  const address = forwardingAddress({
    tenantId: input.tenantId,
    clientName: t?.name ?? "client",
    secret: newForwardingSecret(),
    domain,
  });
  return updateForwarding(tx, conn, { address }, input.actorId);
}
