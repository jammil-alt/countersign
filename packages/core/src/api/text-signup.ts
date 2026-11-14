// Signing up for texts (docs/plan.md §1.98): the public page's two routes, the client's sign-up
// link, and invitations from the portal and the back office.

import { z } from "zod";
import { isUuid } from "../ids";
import { TEXT_INVITE_BATCH_MAX } from "../messaging/signup";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;
const TokenParams = z.object({ token: z.string().min(10).max(2000) });
const ClientParams = z.object({ id: Id });

/** What the page shows: whose page, which kind of link, and the exact words to agree to. */
export const TextSignupView = z.object({
  client: z.string(),
  /** `link`: the client's sign-up link (name and number asked); `invitation`: one person's. */
  kind: z.enum(["link", "invitation"]),
  /** An invitation's person, as the client has them. */
  name: z.string().nullable(),
  /** The number the client has for them (an invitation), to confirm or change. */
  phone: z.string().nullable(),
  terms: z.string(),
  wordingVersion: z.number().int(),
  /** `signed_up`: already agreed to texts; `declined`: said "don't ask me again". */
  state: z.enum(["open", "signed_up", "declined"]),
});
export type TextSignupView = z.infer<typeof TextSignupView>;

export const TextSignupSubmit = z.strictObject({
  /** Asked on the client's link only; an invitation's person is already known. */
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(1).max(40),
  /** The box: the person ticked it. */
  agree: z.literal(true),
  /** The words the page showed, so a sign-up records what was on screen. */
  wordingVersion: z.number().int(),
});
export type TextSignupSubmitInput = z.input<typeof TextSignupSubmit>;

export const TextSignupDone = z.object({
  /** `sent`: the confirmation text went; `pending`: the client's number can't text yet. */
  confirmation: z.enum(["sent", "pending"]),
});

export const TextSignupLink = z.object({ url: z.string() });

export const TextInvitations = z.strictObject({
  contactIds: z.array(Id).min(1).max(TEXT_INVITE_BATCH_MAX),
});
export type TextInvitationsInput = z.input<typeof TextInvitations>;

export const TEXT_INVITE_SKIPS = [
  "not_found",
  "no_email",
  "opted_out",
  "signed_up",
  "declined",
  "asked_twice",
  "too_soon",
  "not_configured",
  "send_failed",
] as const;
export const TextInviteSkip = z.enum(TEXT_INVITE_SKIPS);
export type TextInviteSkip = z.infer<typeof TextInviteSkip>;

/** Who got an invitation (or their reminder), and who was left out and why. */
export const TextInvitationsResult = z.object({
  sent: z.array(z.object({ id: z.string(), reminder: z.boolean() })),
  skipped: z.array(z.object({ id: z.string(), reason: TextInviteSkip })),
});
export type TextInvitationsResult = z.infer<typeof TextInvitationsResult>;

export const textSignupRoutes = {
  textSignupView: defineRoute({
    method: "GET",
    path: "/api/text-signup/:token",
    auth: "public",
    roles: [],
    summary: "The texting sign-up page for a client's link or a person's invitation",
    params: TokenParams,
    response: TextSignupView,
  }),
  textSignupSubmit: defineRoute({
    method: "POST",
    path: "/api/text-signup/:token",
    auth: "public",
    roles: [],
    summary: "Agree to texts from the client: the number, the ticked box and the words shown",
    params: TokenParams,
    body: TextSignupSubmit,
    response: TextSignupDone,
  }),
  textSignupDecline: defineRoute({
    method: "POST",
    path: "/api/text-signup/:token/decline",
    auth: "public",
    roles: [],
    summary: "Don't ask me again: an invited person turns texting invitations down",
    params: TokenParams,
    response: z.object({ ok: z.literal(true) }),
  }),
  portalTextSignupLink: defineRoute({
    method: "GET",
    path: "/api/texting/signup-link",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Your texting sign-up link, to share with your people",
    response: TextSignupLink,
  }),
  portalTextSignupLinkReplace: defineRoute({
    method: "POST",
    path: "/api/texting/signup-link",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Make a new texting sign-up link; the old one stops working",
    response: TextSignupLink,
  }),
  portalTextInvitations: defineRoute({
    method: "POST",
    path: "/api/contacts/text-invitations",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Email these people an invitation to get texts from you",
    body: TextInvitations,
    response: TextInvitationsResult,
  }),
  opsTextSignupLink: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/texting/signup-link",
    auth: "session",
    roles: OPS,
    summary: "The client's texting sign-up link",
    params: ClientParams,
    response: TextSignupLink,
  }),
  opsTextInvitations: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/contacts/text-invitations",
    auth: "session",
    roles: OPS,
    summary: "Email the client's people an invitation to get texts from the client",
    params: ClientParams,
    body: TextInvitations,
    response: TextInvitationsResult,
  }),
} as const;
