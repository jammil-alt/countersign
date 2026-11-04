// Connection credentials from routes (OAuth callbacks, webhook setup, inbound hooks): encrypted
// with the deployment's ENCRYPTION_KEY, bound to the client and the connection, read and written
// inside the request's transaction. Responses never carry them except where a route exists to
// show the client its own secret (the webhook setup).

import {
  CredentialCipher,
  type CredentialsAccessor,
  credentialKeysFromEnv,
  encryptedCredentials,
} from "@countersign/connectors";
import { connection, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Bindings } from "./env";
import { HttpError } from "./http";

const ciphers = new Map<string, Promise<CredentialCipher>>();

/** The deployment's cipher; 503 when ENCRYPTION_KEY is not set (nothing secret can be stored). */
export function cipherFor(env: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">) {
  if (!env.ENCRYPTION_KEY) {
    throw new HttpError(503, "not_configured", "connection credentials can't be stored here yet");
  }
  const cacheKey = `${env.ENCRYPTION_KEY}|${env.ENCRYPTION_KEY_PREVIOUS ?? ""}`;
  let c = ciphers.get(cacheKey);
  if (!c) {
    c = CredentialCipher.create(credentialKeysFromEnv(env));
    ciphers.set(cacheKey, c);
  }
  return c;
}

/** One connection's credentials, in `tx`. */
export async function connectionCredentials(
  tx: Tx,
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">,
  row: { id: string; tenantId: string },
): Promise<CredentialsAccessor> {
  const cipher = await cipherFor(env);
  const where = and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId));
  return encryptedCredentials({
    cipher,
    binding: { tenantId: row.tenantId, connectionId: row.id },
    load: async () => {
      const [r] = await tx
        .select({ c: connection.credentialsEncrypted })
        .from(connection)
        .where(where);
      return r?.c ?? null;
    },
    save: async (envelope) => {
      await tx
        .update(connection)
        .set({ credentialsEncrypted: envelope as Record<string, unknown> })
        .where(where);
    },
  });
}
