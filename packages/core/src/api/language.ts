import { z } from "zod";
import { Locale } from "../i18n/locale";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Languages (docs/plan.md §1.18): each client has a default language, set by the operator on the
// back office's client page or by the client admin in the portal; each client user may choose
// their own, which wins. The session says which one the app reads in.

const Id = z.string().refine((v) => isUuid(v), "not an id");

/** The languages behind a session: what it reads in, and the two choices that decide it. */
export const SessionLanguage = z.object({
  /** User's choice, else the client's default, else the browser's (Accept-Language), else en. */
  effective: Locale,
  /** The user's own choice; null follows the client. */
  user: Locale.nullable(),
  /** The client's default; null follows each reader's browser. */
  client: Locale.nullable(),
});
export type SessionLanguage = z.infer<typeof SessionLanguage>;

export const languageRoutes = {
  portalSetMyLanguage: defineRoute({
    method: "PUT",
    path: "/api/portal/me/language",
    auth: "session",
    roles: ["client_admin", "client_user"],
    summary: "Choose the language you read the portal in (null follows your client's default)",
    body: z.strictObject({ language: Locale.nullable() }),
    response: z.object({ user: Locale.nullable(), client: Locale.nullable() }),
  }),
  portalSetClientLanguage: defineRoute({
    method: "PUT",
    path: "/api/portal/language",
    auth: "session",
    roles: ["client_admin"],
    summary: "Set your client's default language (the client admin)",
    body: z.strictObject({ language: Locale }),
    response: z.object({ client: Locale }),
  }),
  opsSetClientLanguage: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/language",
    auth: "session",
    roles: ["operator"],
    summary: "Set a client's default language",
    params: z.object({ id: Id }),
    body: z.strictObject({ language: Locale }),
    response: z.object({ client: Locale }),
  }),
} as const;
