// The vault's hourly upkeep (docs/plan.md §1.26), from the cron: re-wrap client data keys still
// wrapped by a previous master key (a rotation: `ENCRYPTION_KEY_PREVIOUS`), and re-encrypt a
// bounded batch of v1 credential envelopes as v2 under each client's own key, until none are
// left. Each client in its own transaction (withTenant), as the cron has no session.

import {
  type CredentialCipher,
  reencryptClientCredentials,
  rewrapClientKeys,
  tenantKeysIn,
} from "@countersign/connectors";
import { type Db, tenant, withTenant } from "@countersign/db";
import { asc } from "drizzle-orm";
import type { Bindings } from "../env";
import { cipherFor } from "../secrets";

/** v1 envelopes re-encrypted per hour, across every client. */
// DECISION: 200 an hour: a deployment's few hundred connections move to v2 within a day, and one
// cron run stays short (each is a decrypt, an encrypt and an update).
export const REENCRYPT_BATCH = 200;

export interface VaultTickResult {
  rewrapped: number;
  reencrypted: number;
  failed: number;
}

export async function vaultUpkeep(
  db: Db,
  master: CredentialCipher,
  limit = REENCRYPT_BATCH,
): Promise<VaultTickResult> {
  const out: VaultTickResult = { rewrapped: 0, reencrypted: 0, failed: 0 };
  // `tenant` is global (no RLS): the list of clients to visit, one at a time.
  const clients = await db.select({ id: tenant.id }).from(tenant).orderBy(asc(tenant.id));
  let budget = limit;
  for (const c of clients) {
    await withTenant(db, c.id, async (tx) => {
      out.rewrapped += await rewrapClientKeys(tx, { tenantId: c.id, master });
      if (budget <= 0) return;
      const r = await reencryptClientCredentials(tx, {
        tenantId: c.id,
        vault: master.forClients(tenantKeysIn(tx)),
        limit: budget,
      });
      budget -= r.reencrypted + r.failed;
      out.reencrypted += r.reencrypted;
      out.failed += r.failed;
    });
  }
  return out;
}

/** The cron's entry: nothing to do on a deployment without ENCRYPTION_KEY. */
export async function vaultTick(
  db: Db,
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">,
): Promise<VaultTickResult | null> {
  if (!env.ENCRYPTION_KEY) return null;
  const result = await vaultUpkeep(db, await cipherFor(env));
  if (result.failed > 0) {
    console.warn(`vault upkeep: ${result.failed} credential envelopes could not be re-encrypted`);
  }
  return result;
}
