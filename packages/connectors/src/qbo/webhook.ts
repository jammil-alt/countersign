// Intuit's webhooks (ARCHITECTURE §6.2): one endpoint for the app, signed with the app's verifier
// token. A notification says which records changed in which companies; the platform keeps each
// change as a row (docs/plan.md §1.81) and starts a sync for each company (it never processes the
// change inline), and the sync reads the changes through CDC.

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
              .array(
                z.looseObject({
                  name: z.string(),
                  id: z.union([z.string(), z.number()]).transform(String).optional(),
                  operation: z.string().optional(),
                  lastUpdated: z.string().optional(),
                }),
              )
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
      intuitentityid: z.union([z.string(), z.number()]).transform(String).optional(),
      time: z.string().optional(),
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

/** One record change a notification names (docs/plan.md §1.81). */
export interface QboWebhookChange {
  realmId: string;
  /** Intuit's entity name: `Bill`, `Vendor`, … */
  entity: string;
  id: string;
  /** `Create`, `Update`, `Delete`, `Merge`, `Void`, `Emailed`, … as Intuit sends it. */
  operation: string;
  /** When it changed at Intuit; null when the notification doesn't say or says it badly. */
  lastUpdated: Date | null;
}

const REALM = /^\d{1,32}$/;
const ENTITY = /^[A-Za-z]{1,64}$/;
const SHORT = /^[\w.-]{1,64}$/;

function when(v: string | undefined): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** `qbo.bill.created.v1` → `Bill` and `Create`. */
const CLOUD_OPERATIONS: Record<string, string> = {
  created: "Create",
  updated: "Update",
  deleted: "Delete",
  merged: "Merge",
  voided: "Void",
  emailed: "Emailed",
};

/**
 * Each record change a notification names, in either payload shape; null when the body is neither.
 * A change missing its entity, id or operation, or with values that aren't Intuit's shape, is left
 * out (the company's sync still reads it).
 */
export function parseQboWebhookChanges(body: unknown): QboWebhookChange[] | null {
  const out: QboWebhookChange[] = [];
  const add = (c: QboWebhookChange) => {
    if (
      REALM.test(c.realmId) &&
      ENTITY.test(c.entity) &&
      SHORT.test(c.id) &&
      SHORT.test(c.operation)
    ) {
      out.push(c);
    }
  };
  const classic = Classic.safeParse(body);
  if (classic.success) {
    for (const n of classic.data.eventNotifications) {
      for (const e of n.dataChangeEvent?.entities ?? []) {
        if (!e.id || !e.operation) continue;
        add({
          realmId: n.realmId,
          entity: e.name,
          id: e.id,
          operation: e.operation,
          lastUpdated: when(e.lastUpdated),
        });
      }
    }
    return out;
  }
  const ce = CloudEvents.safeParse(body);
  if (!ce.success) return null;
  for (const e of ce.data) {
    const [, name, verb] = e.type?.split(".") ?? [];
    const operation = verb ? CLOUD_OPERATIONS[verb] : undefined;
    if (!e.intuitaccountid || !e.intuitentityid || !name || !operation) continue;
    add({
      realmId: e.intuitaccountid,
      entity: name.charAt(0).toUpperCase() + name.slice(1),
      id: e.intuitentityid,
      operation,
      lastUpdated: when(e.time),
    });
  }
  return out;
}
