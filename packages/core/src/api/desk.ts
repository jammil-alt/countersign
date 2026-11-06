import { z } from "zod";
import { UndoSeconds } from "../desk/rules";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// The Desk (ARCHITECTURE §11.1, §4, §14; docs/plan.md §1.39): snooze, edit before signing, sign a
// batch, undo inside the window, who signs what. The inbox list and the one-item resolve stay in
// routes.ts; these sit beside them on the same `inbox_item` rows and resolve path.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** An item's Desk state after a Desk action; lists carry the full item. */
export const DeskItemState = z.object({
  id: z.string(),
  status: z.enum(["open", "resolved", "expired"]),
  deliverAfter: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  batchKey: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});
export type DeskItemState = z.infer<typeof DeskItemState>;

export const SnoozeBody = z.strictObject({
  /** When the item comes back: later today, tomorrow 8:00, Monday 8:00 or a time (the portal). */
  until: z.iso.datetime({ offset: true }),
});
export type SnoozeBody = z.infer<typeof SnoozeBody>;

export const EditBody = z.strictObject({
  /** The whole input as the person wants it signed; only the tool's editable fields may differ. */
  input: z.record(z.string(), z.unknown()),
});
export type EditBody = z.infer<typeof EditBody>;

export const BATCH_MAX = 100;

export const BatchResolveBody = z
  .strictObject({
    batchKey: z.string().min(1).max(200),
    approve: z.array(Id).max(BATCH_MAX).default([]),
    reject: z.array(Id).max(BATCH_MAX).default([]),
    note: z.string().max(2000).optional(),
  })
  .refine((b) => b.approve.length + b.reject.length > 0, {
    message: "name at least one item",
    path: ["approve"],
  })
  .refine((b) => !b.approve.some((id) => b.reject.includes(id)), {
    message: "an item can't be approved and rejected",
    path: ["reject"],
  })
  .refine((b) => new Set([...b.approve, ...b.reject]).size === b.approve.length + b.reject.length, {
    message: "an item is named twice",
    path: ["approve"],
  });
export type BatchResolveBody = z.input<typeof BatchResolveBody>;

/** A person in the client and what they sign, in plain words. */
export const TeamMember = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  role: z.enum(["client_admin", "client_user"]),
  /** False for a viewer (`membership.can_sign`). */
  canSign: z.boolean(),
  /** What the approver rules send to them, one plain line each. */
  signs: z.array(z.string()),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const DeskSettings = z.object({ undoSeconds: UndoSeconds });
export type DeskSettings = z.infer<typeof DeskSettings>;

export const DeskSettingsBody = z.strictObject({ undoSeconds: UndoSeconds });

export const deskRoutes = {
  portalSnoozeInbox: defineRoute({
    method: "POST",
    path: "/api/inbox/:id/snooze",
    auth: "session",
    roles: CLIENT,
    summary: "Not now: hide an item from what waits on you until a time (at most 14 days)",
    params: IdParams,
    body: SnoozeBody,
    response: z.object({ item: DeskItemState }),
  }),
  portalUndoInbox: defineRoute({
    method: "POST",
    path: "/api/inbox/:id/undo",
    auth: "session",
    roles: CLIENT,
    summary: "Undo an approval inside its undo window: the item opens again and nothing is written",
    params: IdParams,
    response: z.object({ item: DeskItemState }),
  }),
  portalEditInbox: defineRoute({
    method: "PUT",
    path: "/api/inbox/:id/edit",
    auth: "session",
    roles: CLIENT,
    summary: "Edit a drafted change before signing it (its editable fields only)",
    params: IdParams,
    body: EditBody,
    response: z.object({
      item: DeskItemState,
      edited: z.object({ input: z.record(z.string(), z.unknown()), at: z.string() }),
    }),
  }),
  portalBatchResolve: defineRoute({
    method: "POST",
    path: "/api/inbox/batch/resolve",
    auth: "session",
    roles: CLIENT,
    summary: "Sign part of a batch: approve and reject items one step proposed, in one go",
    body: BatchResolveBody,
    response: z.object({ items: z.array(DeskItemState) }),
  }),
  portalTeam: defineRoute({
    method: "GET",
    path: "/api/team",
    auth: "session",
    roles: CLIENT,
    summary: "Your team: each person's role, whether they sign, and what the rules send them",
    response: z.object({ members: z.array(TeamMember), settings: DeskSettings }),
  }),
  portalDeskSettings: defineRoute({
    method: "PUT",
    path: "/api/desk/settings",
    auth: "session",
    roles: ["client_admin"],
    summary: "Set the undo window (0 to 300 seconds; 0 switches it off)",
    body: DeskSettingsBody,
    response: z.object({ settings: DeskSettings }),
  }),
  opsUndoInbox: defineRoute({
    method: "POST",
    path: "/api/ops/inbox/:id/undo",
    auth: "session",
    roles: OPS,
    summary: "Undo the operator's approval inside its undo window",
    params: IdParams,
    response: z.object({ item: DeskItemState }),
  }),
  opsDeskSettings: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/desk",
    auth: "session",
    roles: OPS,
    summary: "Set a client's undo window (0 to 300 seconds)",
    params: IdParams,
    body: DeskSettingsBody,
    response: z.object({ settings: DeskSettings }),
  }),
} as const;
