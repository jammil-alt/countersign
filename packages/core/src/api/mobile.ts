// The phone app's routes (docs/plan.md §1.97): signing in from the app, the person's phones and
// their push settings. Desk items, signing and everything else the app shows use the portal's own
// routes; a phone's signature rides on `POST /api/inbox/:id/resolve` (ResolveBody.deviceSignature).

import { z } from "zod";
import { isUuid } from "../ids";
import {
  DevicePlatform,
  DevicePublicKey,
  MyDevice,
  MyPush,
  PkceChallenge,
  PkceVerifier,
  PushToken,
} from "../mobile/mobile";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const CLIENT = ["client_admin", "client_user"] as const;

export const MobileSessionResponse = z.object({
  /** The sealed session, sent back in MOBILE_SESSION_HEADER on every request. */
  session: z.string().min(1),
  /** When it ends at the latest (12 hours after sign-in). */
  expiresAt: z.string(),
});
export type MobileSessionResponse = z.infer<typeof MobileSessionResponse>;

export const RegisterDeviceBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  platform: DevicePlatform,
  pushToken: PushToken.nullable(),
  publicKey: DevicePublicKey.nullable(),
});
export type RegisterDeviceBody = z.infer<typeof RegisterDeviceBody>;

export const UpdateDeviceBody = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  pushToken: PushToken.nullable().optional(),
});
export type UpdateDeviceBody = z.infer<typeof UpdateDeviceBody>;

export const SetMyPushBody = z.strictObject({
  on: z.boolean(),
  every: z.enum(["now", "hour"]),
  showClient: z.boolean(),
});
export type SetMyPushBody = z.infer<typeof SetMyPushBody>;

export const mobileRoutes = {
  // Sign-in from the app: the app opens this in the system browser with its PKCE challenge; it
  // runs the usual WorkOS sign-in and ends at `mobileHandoff`, which sends the browser back to the
  // app (mezonas://signed-in?code=…). Full-page navigations, not JSON.
  mobileSignIn: defineRoute({
    method: "GET",
    path: "/api/mobile/sign-in",
    auth: "public",
    roles: [],
    summary: "Start signing in from the phone app (redirects to sign-in)",
    query: z.object({ challenge: PkceChallenge }),
    response: z.object({}),
  }),
  mobileHandoff: defineRoute({
    method: "GET",
    path: "/api/mobile/handoff",
    auth: "public",
    roles: [],
    summary: "After sign-in: hand the session to the phone app (redirects to the app)",
    response: z.object({}),
  }),
  mobileSession: defineRoute({
    method: "POST",
    path: "/api/mobile/session",
    auth: "public",
    roles: [],
    summary: "The phone app trades its handoff code and PKCE verifier for its session",
    body: z.strictObject({ code: z.string().min(1).max(8192), verifier: PkceVerifier }),
    response: MobileSessionResponse,
  }),
  myDevices: defineRoute({
    method: "GET",
    path: "/api/me/devices",
    auth: "session",
    roles: CLIENT,
    summary: "Your phones: the ones that get notifications and can sign",
    response: z.object({ devices: z.array(MyDevice) }),
  }),
  registerDevice: defineRoute({
    method: "POST",
    path: "/api/me/devices",
    auth: "session",
    roles: CLIENT,
    summary: "Register this phone: its push token and the public half of its signing key",
    body: RegisterDeviceBody,
    response: z.object({ device: MyDevice }),
  }),
  updateDevice: defineRoute({
    method: "PATCH",
    path: "/api/me/devices/:id",
    auth: "session",
    roles: CLIENT,
    summary: "Rename one of your phones or give it a new push token",
    params: z.object({ id: Id }),
    body: UpdateDeviceBody,
    response: z.object({ device: MyDevice }),
  }),
  removeDevice: defineRoute({
    method: "DELETE",
    path: "/api/me/devices/:id",
    auth: "session",
    roles: CLIENT,
    summary: "Remove one of your phones: its notifications and its signing key stop at once",
    params: z.object({ id: Id }),
    response: z.object({ ok: z.literal(true) }),
  }),
  myPush: defineRoute({
    method: "GET",
    path: "/api/settings/my-push",
    auth: "session",
    roles: CLIENT,
    summary: "Your phone notifications: on or off, how soon, and what the lock screen shows",
    response: MyPush,
  }),
  setMyPush: defineRoute({
    method: "PUT",
    path: "/api/settings/my-push",
    auth: "session",
    roles: CLIENT,
    summary: "Set your phone notifications",
    body: SetMyPushBody,
    response: MyPush,
  }),
} as const;
