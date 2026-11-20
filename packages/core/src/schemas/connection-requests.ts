// Connectors C3 (docs/connectors-plan.md §7.1, §7.2; docs/plan.md §1.161): what is stored for our
// change requests to a client's connection and for the client's standing say over our changes.
// The rules that read them (stale, within an authorization, who may answer) come in C4.

import { z } from "zod";
import { isUuid } from "../ids";
import { PermissionMatrix } from "./permissions";

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
