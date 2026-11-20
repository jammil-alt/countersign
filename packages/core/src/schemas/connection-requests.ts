// Connectors C3 (docs/connectors-plan.md §7.1, §7.2; docs/plan.md §1.161): what is stored for our
// change requests to a client's connection and for the client's standing say over our changes.
// The rules that read them (stale, within an authorization, who may answer) are in permissions/change.ts (C4).

import { z } from "zod";
import { isUuid } from "../ids";
import { PermissionLevel, PermissionMatrix, Verb } from "./permissions";

/** A change request's life: open until answered, replaced by a newer one, expired or withdrawn. */
export const CONNECTION_CHANGE_REQUEST_STATUSES = [
  "open",
  "approved",
  "declined",
  "replaced",
  "expired",
  "withdrawn",
] as const;
export type ConnectionChangeRequestStatus = (typeof CONNECTION_CHANGE_REQUEST_STATUSES)[number];

/** Open requests end after this many days (§7.1). */
export const CONNECTION_CHANGE_REQUEST_DAYS = 14;

/**
 * A connection's settings as a request sees them: the matrix and the tool's setup (Gmail query,
 * Drive folders, Slack channels). `against` is what we asked against; `proposed` what approving
 * sets.
 */
export const ConnectionSettings = z
  .strictObject({
    permissions: PermissionMatrix,
    config: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "ConnectionSettings" });
export type ConnectionSettings = z.infer<typeof ConnectionSettings>;

/**
 * Changes by Mezonas (§7.2), beside "Ask me each time" (no value): `needs` lets us turn on the rows
 * an agent's needs call for, `any` any row and the tool's setup; both only up to Ask me first.
 */
export const MEZONAS_MAY_CHOICES = ["needs", "any"] as const;
export type MezonasMayChoice = (typeof MEZONAS_MAY_CHOICES)[number];

/** The client admin's standing authorization on one connection; null `until` means until turned off. */
export const MezonasMay = z
  .strictObject({
    choice: z.enum(MEZONAS_MAY_CHOICES),
    until: z.iso.datetime({ offset: true }).nullable(),
    setBy: z.string().refine((v) => isUuid(v), "not an id"),
    setAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "MezonasMay" });
export type MezonasMay = z.infer<typeof MezonasMay>;

// ── Connectors C4: a change's rows, as screens, requests and notices carry them ─────────────────

const RowDirection = z.enum(["tighter", "looser"]);

/**
 * One row of a change (core's `RowChange` from `changeDirection`) with its words
 * (`describeRowChange`: "Create bills: Off → Ask me first"), as the API sends it.
 */
export const ConnectionRowChange = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("level"),
      verb: Verb,
      /** Null: the verb's own row (the group's control, and tools with no record type). */
      entity: z.string().nullable(),
      from: PermissionLevel,
      to: PermissionLevel,
      direction: RowDirection,
      label: z.string(),
    }),
    z.object({
      kind: z.literal("scope"),
      /** Both null: the connection's own connector-specific scope. */
      verb: Verb.nullable(),
      entity: z.string().nullable(),
      from: z.unknown(),
      to: z.unknown(),
      direction: RowDirection,
      label: z.string(),
    }),
    z.object({
      kind: z.literal("setup"),
      key: z.string(),
      added: z.array(z.unknown()).nullable(),
      removed: z.array(z.unknown()).nullable(),
      direction: RowDirection,
      label: z.string(),
    }),
  ])
  .meta({ id: "ConnectionRowChange" });
export type ConnectionRowChange = z.infer<typeof ConnectionRowChange>;

/**
 * The inbox items a change request and our changes make (docs/connectors-plan.md §7.1, §7.2), by
 * `inbox_item.subject_type` (the inbox's kinds are fixed by a check in the database, so these are
 * subjects, as Sloan's drafted changes are).
 */
// DECISION (docs/plan.md §1.161, C4): a request is an `approval` item for the client admin with
// subject `connection_change_request` (subject id: the request), answered only through its own
// approve and decline routes; our change applied at once (tighter, or under Changes by Mezonas) is
// a `review` item with subject `connection_change_notice` (subject id: the connection), a notice
// that waits on nobody.
export const CONNECTION_REQUEST_SUBJECT = "connection_change_request";
export const CONNECTION_NOTICE_SUBJECT = "connection_change_notice";

const Person = z.object({ id: z.string(), name: z.string().nullable() });
const AgentRef = z.object({ id: z.string(), name: z.string() });

/** The payload of a change request's inbox item: enough to render the card without a read. */
export const ConnectionRequestInboxPayload = z
  .object({
    requestId: z.string(),
    connectionId: z.string(),
    connector: z.string(),
    connectorName: z.string(),
    rows: z.array(ConnectionRowChange),
    reason: z.string(),
    requestedBy: Person,
    forAgent: AgentRef.nullable(),
    expiresAt: z.string(),
  })
  .meta({ id: "ConnectionRequestInboxPayload" });
export type ConnectionRequestInboxPayload = z.infer<typeof ConnectionRequestInboxPayload>;

/** The payload of a notice: a change of ours that applied at once, and why it could. */
export const ConnectionNoticeInboxPayload = z
  .object({
    connectionId: z.string(),
    connector: z.string(),
    connectorName: z.string(),
    /** `tightened`: it only made things safer; `authorized`: under the client's go-ahead. */
    because: z.enum(["tightened", "authorized"]),
    rows: z.array(ConnectionRowChange),
    reason: z.string(),
    changedBy: Person,
    /** The go-ahead it used, for `authorized`. */
    authorization: MezonasMay.nullable(),
  })
  .meta({ id: "ConnectionNoticeInboxPayload" });
export type ConnectionNoticeInboxPayload = z.infer<typeof ConnectionNoticeInboxPayload>;
