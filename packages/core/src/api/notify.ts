// Notification routes (ARCHITECTURE §11.3, §14 v0.12; docs/plan.md §1.37): the operator asks a
// client to reconnect a connection; each person chooses their own channels. Sends themselves
// happen in the cron's pass, never on request.

import { z } from "zod";
import { isUuid } from "../ids";
import { NotificationChannel, NotificationStatus } from "../notify/notify";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const MyNotifications = z.object({
  /** Emails from Mezonas: items waiting, the weekly summary, reconnects. */
  email: z.boolean(),
  /** Texts from your business's number; only when one can reach you (`canText`). */
  sms: z.boolean(),
  /** A text can reach you: your directory entry has a phone with text consent and no STOP. */
  canText: z.boolean(),
  /** False while Mezonas sends no email here (no sending key is set up). */
  emailsOn: z.boolean(),
});
export type MyNotifications = z.infer<typeof MyNotifications>;

export const RemindResult = z.object({
  /** One row per person and channel, queued and sent by the next pass. */
  notifications: z.array(
    z.object({
      channel: NotificationChannel,
      status: NotificationStatus,
      reason: z.string().nullable(),
    }),
  ),
});
export type RemindResult = z.infer<typeof RemindResult>;

export const notifyRoutes = {
  opsRemindConnection: defineRoute({
    method: "POST",
    path: "/api/ops/connections/:id/remind",
    auth: "session",
    roles: OPS,
    summary:
      "Ask the client to reconnect a connection: once a day per connection (409 already_sent), logged",
    params: z.object({ id: Id }),
    response: RemindResult,
  }),
  portalMyNotifications: defineRoute({
    method: "GET",
    path: "/api/settings/my-notifications",
    auth: "session",
    roles: CLIENT,
    summary: "Your own notification channels: email and texts",
    response: MyNotifications,
  }),
  portalSetMyNotifications: defineRoute({
    method: "PUT",
    path: "/api/settings/my-notifications",
    auth: "session",
    roles: CLIENT,
    summary: "Turn your own emails and texts from Mezonas on or off",
    body: z.strictObject({ email: z.boolean(), sms: z.boolean() }),
    response: MyNotifications,
  }),
} as const;
