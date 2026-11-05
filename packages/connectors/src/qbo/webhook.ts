// Intuit's webhooks (ARCHITECTURE §6.2): one endpoint for the app, signed with the app's verifier
// token. A notification only says which companies changed; the platform starts a sync for each
// (it never processes the change inline), and the sync reads the changes through CDC.

import { z } from "zod";
import { constantTimeEqual } from "../http";
import { hmacKey, subtle, toBase64, utf8 } from "../runtime";

export const QBO_SIGNATURE_HEADER = "intuit-signature";
/** Intuit's notifications are small; anything bigger is refused unread. */
export const QBO_WEBHOOK_MAX_BYTES = 256 * 1024;

/**
 * `intuit-signature` is the base64 HMAC-SHA256 of the raw body under the app's verifier token.
 */
// UNCHECKED (NOTES.md): the header name, base64 (not hex), and that the body is signed as sent.
export async function qboWebhookSignature(verifier: string, body: Uint8Array): Promise<string> {
  const key = await hmacKey(utf8(verifier));
  return toBase64(new Uint8Array(await subtle().sign("HMAC", key, body)));
}

export async function verifyQboWebhook(
  verifier: string | undefined,
  signature: string | null | undefined,
  body: Uint8Array,
): Promise<boolean> {
  if (!verifier || !signature) return false;
  const expected = await qboWebhookSignature(verifier, body);
  return constantTimeEqual(expected, signature.trim());
}

const Classic = z.object({
  eventNotifications: z
    .array(
      z.looseObject({
        realmId: z.union([z.string(), z.number()]).transform(String),
        dataChangeEvent: z
          .looseObject({
            entities: z
              .array(z.looseObject({ name: z.string(), id: z.string().optional() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .max(1000),
});

const CloudEvents = z
  .array(
    z.looseObject({
      type: z.string().optional(),
      intuitaccountid: z.union([z.string(), z.number()]).transform(String).optional(),
      intuitentityid: z.string().optional(),
    }),
  )
  .max(1000);

/** Which companies a notification names, with the entity types that changed in each. */
// DECISION: both payload shapes are read: the classic `eventNotifications` and the CloudEvents
// array Intuit announced moving webhooks to (NOTES.md: which one the app gets is to be checked).
export function parseQboWebhook(body: unknown): { realmId: string; entities: string[] }[] | null {
  const byRealm = new Map<string, Set<string>>();
  const add = (realm: string, entity: string | undefined) => {
    if (!/^\d{1,32}$/.test(realm)) return;
    const set = byRealm.get(realm) ?? new Set<string>();
    if (entity) set.add(entity);
    byRealm.set(realm, set);
  };
  const classic = Classic.safeParse(body);
  if (classic.success) {
    for (const n of classic.data.eventNotifications) {
      const entities = n.dataChangeEvent?.entities ?? [];
      if (entities.length === 0) add(n.realmId, undefined);
      for (const e of entities) add(n.realmId, e.name);
    }
  } else {
    const ce = CloudEvents.safeParse(body);
    if (!ce.success) return null;
    for (const e of ce.data) {
      if (!e.intuitaccountid) continue;
      // `qbo.bill.created.v1` → Bill
      const name = e.type?.split(".")[1];
      add(e.intuitaccountid, name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined);
    }
  }
  return [...byRealm.entries()].map(([realmId, entities]) => ({
    realmId,
    entities: [...entities].sort(),
  }));
}
