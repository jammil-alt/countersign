// v0.14 W4-B: Zoho CRM sync and notifications (docs/plan.md §1.9 "Sync (W4-B)"; ARCHITECTURE
// §6.7). Changes in the modules the tools work in (Leads, Contacts, Accounts, Deals) come in as raw
// records, read by a cursor poll: each module's records modified since the cursor, oldest first, a
// page at a time. Zoho's notifications (the Notification API's `watch`) only say that something
// changed: the platform starts the same poll, never processing a change inline, as QuickBooks'
// webhooks do. Pure here: the cursor, the page plan, the mapping and the notification checks; the
// calls are the connector's (./index.ts) and the writes apps/api's.

import { z } from "zod";
import type { RawRecordInput } from "../connector";
import { constantTimeEqual } from "../http";
import { hmacKey, subtle, toHex, utf8 } from "../runtime";

/** The modules synced: the ones the record tools work in, in this order. */
export const ZOHO_SYNCED_MODULES = ["Leads", "Contacts", "Accounts", "Deals"] as const;
export type ZohoSyncedModule = (typeof ZOHO_SYNCED_MODULES)[number];

/**
 * The fields read per module. v8's list call needs `fields` (at most 50); these are the ones an
 * agent works with, plus the times the cursor reads.
 */
// UNCHECKED (NOTES.md): the field API names of a standard org; a field an org renamed or removed
// comes back absent, not as an error.
export const ZOHO_SYNC_FIELDS: Record<ZohoSyncedModule, readonly string[]> = {
  Leads: ["First_Name", "Last_Name", "Company", "Email", "Phone", "Lead_Status", "Lead_Source"],
  Contacts: ["First_Name", "Last_Name", "Email", "Phone", "Account_Name", "Title"],
  Accounts: ["Account_Name", "Phone", "Website", "Account_Type", "Industry"],
  Deals: ["Deal_Name", "Stage", "Amount", "Closing_Date", "Account_Name", "Contact_Name"],
};
const TIME_FIELDS = ["Owner", "Created_Time", "Modified_Time"] as const;
/** v8's most fields in one list call (./fields.ts ZOHO_MAX_FIELDS_PER_CALL). */
const MAX_FIELDS = 50;

/** How many fields a module reads before any the connection adds: standard ones and the times. */
export function zohoStandardFieldCount(module: ZohoSyncedModule): number {
  return new Set<string>([...ZOHO_SYNC_FIELDS[module], ...TIME_FIELDS]).size;
}

/**
 * The `fields` parameter for a module: the standard ones, then the connection's own (docs/plan.md
 * §1.164 "Syncing custom fields"; checked against Zoho's field list when they are set), then the
 * times the cursor reads; each once, at most v8's 50.
 */
export function zohoSyncFields(module: ZohoSyncedModule, extra: readonly string[] = []): string {
  const standard: readonly string[] = [...ZOHO_SYNC_FIELDS[module], ...TIME_FIELDS];
  const own = [...new Set(extra)].filter((f) => !standard.includes(f));
  // Checked when set; a list that grew past the limit some other way reads its first fields.
  const room = Math.max(0, MAX_FIELDS - zohoStandardFieldCount(module));
  return [...ZOHO_SYNC_FIELDS[module], ...own.slice(0, room), ...TIME_FIELDS].join(",");
}

/**
 * A short name for the extra fields a connection reads (empty when none): part of each record's
 * version, so a record read with more fields is stored again (raw records are never updated), and
 * kept on the cursor, so a change to the fields starts a pass that reads every module again.
 */
export function zohoSyncFieldsKey(
  extra: Partial<Record<ZohoSyncedModule, readonly string[]>>,
): string {
  const parts = ZOHO_SYNCED_MODULES.flatMap((m) => {
    const standard: readonly string[] = ZOHO_SYNC_FIELDS[m];
    const own = [...new Set(extra[m] ?? [])].filter((f) => !standard.includes(f)).sort();
    return own.length > 0 ? [`${m}:${own.join(",")}`] : [];
  });
  if (parts.length === 0) return "";
  // FNV-1a, 32 bits: a name, not a secret.
  let h = 0x811c9dc5;
  for (const ch of parts.join(";")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `f${h.toString(16).padStart(8, "0")}`;
}

/** The modification time a record version stands for (`2026-…+00:00~f1a2b3c4` → the time). */
export function zohoVersionTime(version: string | null | undefined): string | null {
  if (!version) return null;
  return version.split("~")[0] || null;
}

/** Records per page (Zoho's list maximum). */
export const ZOHO_SYNC_PAGE_SIZE = 200;
/** The deepest page asked for in one window; past it, the window moves on by time. */
// UNCHECKED (NOTES.md): v8 lists only the first 2,000 records by page number (10 pages of 200).
export const ZOHO_MAX_PAGE = 10;
/** A first sync reads this far back, as history: no events. */
export const ZOHO_INITIAL_DAYS = 90;
/** Changes are read from a minute before the last pass started, to cover clock drift. */
const OVERLAP_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ZohoSyncCursor = z.object({
  v: z.literal(1),
  /** The module being read (an index into ZOHO_SYNCED_MODULES). */
  module: z
    .number()
    .int()
    .min(0)
    .max(ZOHO_SYNCED_MODULES.length - 1),
  /** Records modified after this instant come in (`If-Modified-Since`). */
  since: z.iso.datetime({ offset: true }),
  /** 1-based page within the window. */
  page: z.number().int().min(1).max(ZOHO_MAX_PAGE),
  /** Where the next pass starts: when this one began, less the overlap. */
  next: z.iso.datetime({ offset: true }),
  /** This pass is the first one: history, so no events. */
  initial: z.boolean(),
  /** The extra fields this pass reads (zohoSyncFieldsKey); absent: none. */
  fields: z.string().max(20).optional(),
});
export type ZohoSyncCursor = z.infer<typeof ZohoSyncCursor>;

/** The stored cursor, or null (none, or one that doesn't read: a fresh first sync). */
export function readZohoSyncCursor(stored: unknown): ZohoSyncCursor | null {
  const zoho = (stored as { zoho?: unknown } | null | undefined)?.zoho;
  const parsed = ZohoSyncCursor.safeParse(zoho);
  return parsed.success ? parsed.data : null;
}

/** A first sync: every module from ZOHO_INITIAL_DAYS ago. */
export function startZohoSync(now: Date, fieldsKey = ""): ZohoSyncCursor {
  return {
    v: 1,
    module: 0,
    since: new Date(now.getTime() - ZOHO_INITIAL_DAYS * DAY_MS).toISOString(),
    page: 1,
    next: new Date(now.getTime() - OVERLAP_MS).toISOString(),
    initial: true,
    ...(fieldsKey ? { fields: fieldsKey } : {}),
  };
}

/**
 * The cursor a page starts from: the stored one; a first sync when there is none; and when the
 * connection's extra fields changed since the pass began, a pass that reads every module again over
 * the first sync's window, so the records we hold get the new fields. Not history: a change made
 * meanwhile still raises its event, and a record read again only for its fields raises none (the
 * platform compares the versions' times, zohoVersionTime).
 */
// DECISION (docs/plan.md §1.164): fields chosen after a record was synced reach it by reading it
// again, never by changing a stored raw record (invariant 3). Records older than the first sync's
// window keep what they were read with until they change.
export function zohoCursorFor(stored: unknown, now: Date, fieldsKey: string): ZohoSyncCursor {
  const cursor = readZohoSyncCursor(stored);
  if (!cursor) return startZohoSync(now, fieldsKey);
  if ((cursor.fields ?? "") === fieldsKey) return cursor;
  const { fields: _old, ...rest } = cursor;
  return {
    ...rest,
    module: 0,
    since: new Date(now.getTime() - ZOHO_INITIAL_DAYS * DAY_MS).toISOString(),
    page: 1,
    next: new Date(now.getTime() - OVERLAP_MS).toISOString(),
    ...(fieldsKey ? { fields: fieldsKey } : {}),
  };
}

/** A new pass over every module, from where the last one began. */
function nextPass(cursor: ZohoSyncCursor, now: Date): ZohoSyncCursor {
  return {
    v: 1,
    module: 0,
    since: cursor.next,
    page: 1,
    next: new Date(now.getTime() - OVERLAP_MS).toISOString(),
    initial: false,
    ...(cursor.fields ? { fields: cursor.fields } : {}),
  };
}

/** One list call: which module, the window and the page. */
export interface ZohoPageRequest {
  module: ZohoSyncedModule;
  since: string;
  page: number;
}

export function zohoPageRequest(cursor: ZohoSyncCursor): ZohoPageRequest {
  return {
    module: ZOHO_SYNCED_MODULES[cursor.module] as ZohoSyncedModule,
    since: cursor.since,
    page: cursor.page,
  };
}

const ListedRecord = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  Modified_Time: z.string().max(64).optional(),
});

/**
 * A listed record as a raw record: its module, id, `Modified_Time` as the version (with the extra
 * fields' key after a `~` when the connection reads any, zohoSyncFieldsKey), its fields.
 */
export function zohoRawRecord(
  module: ZohoSyncedModule,
  raw: unknown,
  fieldsKey = "",
): RawRecordInput | null {
  const r = ListedRecord.safeParse(raw);
  if (!r.success || !/^\d{1,30}$/.test(r.data.id)) return null;
  // Zoho's own `$` keys (state, permissions) are not the record's. Field names come from Zoho's
  // answer: built with fromEntries, without the names that could reach an object's prototype.
  const payload: Record<string, unknown> = Object.fromEntries(
    Object.entries(r.data).filter(
      ([k]) => !k.startsWith("$") && k !== "__proto__" && k !== "constructor" && k !== "prototype",
    ),
  );
  return {
    entityType: module,
    externalId: r.data.id,
    externalVersion:
      r.data.Modified_Time && fieldsKey
        ? `${r.data.Modified_Time}~${fieldsKey}`
        : (r.data.Modified_Time ?? null),
    payload: payload as RawRecordInput["payload"],
  };
}

export interface ZohoSyncPage {
  records: RawRecordInput[];
  next: ZohoSyncCursor;
  /** The pass is over: every module read up to now. */
  done: boolean;
  /** The records are history (a first sync): no events. */
  initial: boolean;
}

/**
 * The cursor after a page: the next page of the same window while Zoho says there are more (up to
 * ZOHO_MAX_PAGE, then a new window from the last record's time), else the next module, else a new
 * pass from when this one began.
 */
export function afterZohoPage(
  cursor: ZohoSyncCursor,
  answer: { records: RawRecordInput[]; more: boolean },
  now: Date,
): ZohoSyncPage {
  const records = answer.records;
  const initial = cursor.initial;
  if (answer.more && records.length > 0) {
    if (cursor.page < ZOHO_MAX_PAGE) {
      return { records, next: { ...cursor, page: cursor.page + 1 }, done: false, initial };
    }
    // Past the deepest page: a new window from the last record read (oldest first, so nothing
    // in between is skipped; the records at that instant are read again, and stored once).
    const last = zohoVersionTime(records[records.length - 1]?.externalVersion);
    const at = last ? Date.parse(last) : Number.NaN;
    if (Number.isFinite(at) && at > Date.parse(cursor.since)) {
      return {
        records,
        next: { ...cursor, since: new Date(at).toISOString(), page: 1 },
        done: false,
        initial,
      };
    }
  }
  if (cursor.module + 1 < ZOHO_SYNCED_MODULES.length) {
    return {
      records,
      next: { ...cursor, module: cursor.module + 1, page: 1 },
      done: false,
      initial,
    };
  }
  return { records, next: nextPass(cursor, now), done: true, initial };
}

// ── Events ──────────────────────────────────────────────────────────────────────────────────────

/** A record changed in a synced module: one event per new raw record (never on a first sync). */
export const ZOHO_RECORD_CHANGED_EVENT = "zoho_crm.record.changed";

export const ZohoRecordChangedPayload = z.object({
  connectionId: z.string(),
  rawRecordId: z.string(),
  module: z.enum(ZOHO_SYNCED_MODULES),
  recordId: z.string(),
  /** `created` when this is the first version we hold of the record, else `updated`. */
  change: z.enum(["created", "updated"]),
  modifiedTime: z.string().nullable(),
});
export type ZohoRecordChangedPayload = z.infer<typeof ZohoRecordChangedPayload>;

// ── Notifications ───────────────────────────────────────────────────────────────────────────────

/** The longest notification read; Zoho's are small. */
export const ZOHO_NOTIFY_MAX_BYTES = 64 * 1024;

/** How long a watch lasts before it is renewed (Zoho's maximum is a day). */
// UNCHECKED (NOTES.md): the one-day maximum of `channel_expiry`.
export const ZOHO_WATCH_HOURS = 23;

/**
 * The token a connection's notifications carry, made from a deployment secret and the connection,
 * so nothing is stored: Zoho echoes it in every notification and it is checked in constant time.
 */
export async function zohoNotifyToken(secret: string, connectionId: string): Promise<string> {
  const key = await hmacKey(utf8(secret));
  const mac = await subtle().sign("HMAC", key, utf8(`zoho_crm.notify:${connectionId}`));
  // Zoho caps the token at 50 characters.
  return toHex(new Uint8Array(mac)).slice(0, 48);
}

/**
 * The channel id Zoho needs (a number): the connection's id, first 15 hex digits as a decimal,
 * stable and well under 2^63.
 */
export function zohoChannelId(connectionId: string): string {
  const hex = connectionId.replace(/-/g, "").slice(0, 15);
  return BigInt(`0x${hex}`).toString(10);
}

const Notification = z.looseObject({
  channel_id: z.union([z.string(), z.number()]).transform(String),
  token: z.string().max(200).optional(),
  module: z.string().max(100).optional(),
  operation: z.string().max(20).optional(),
  ids: z
    .array(z.union([z.string(), z.number()]).transform(String))
    .max(1000)
    .optional(),
});
export type ZohoNotification = z.infer<typeof Notification>;

/** A notification's body, or null when it isn't one. */
export function parseZohoNotification(body: unknown): ZohoNotification | null {
  const parsed = Notification.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Whether a notification is this connection's: its channel and its token (constant time). */
export async function verifyZohoNotification(
  n: ZohoNotification,
  input: { secret: string; connectionId: string },
): Promise<boolean> {
  if (!n.token) return false;
  const token = await zohoNotifyToken(input.secret, input.connectionId);
  const tokenOk = constantTimeEqual(token, n.token);
  const channelOk = constantTimeEqual(zohoChannelId(input.connectionId), n.channel_id);
  return tokenOk && channelOk;
}

/** The `watch` body that turns notifications on for the synced modules. */
export function zohoWatchBody(input: {
  connectionId: string;
  token: string;
  notifyUrl: string;
  now: Date;
}) {
  const expiry = new Date(input.now.getTime() + ZOHO_WATCH_HOURS * 60 * 60 * 1000);
  return {
    watch: [
      {
        channel_id: zohoChannelId(input.connectionId),
        events: ZOHO_SYNCED_MODULES.map((m) => `${m}.all`),
        // Zoho's format: no milliseconds, with an offset.
        channel_expiry: `${expiry.toISOString().slice(0, 19)}+00:00`,
        token: input.token,
        notify_url: input.notifyUrl,
      },
    ],
  };
}
