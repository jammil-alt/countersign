import { z } from "zod";
import { isUuid } from "../ids";
import {
  ContactTranslation,
  ContactTranslationBody,
  OpsTranslationBody,
  OpsTranslationSettingsView,
  PortalTranslationBody,
  TranslationSettingsView,
} from "../translate/settings";
import { defineRoute } from "./contract";

// P-7: message translation's settings (docs/plan.md §1.69). The operator sets everything, with a
// reason; the client admin sets the working language and the three switches (the model and the
// daily limit are cost, so ours); client users read them. Each save is a `tenant_change` row. A
// contact's own switch is a `contact_change` row.

const Id = z.string().refine((v) => isUuid(v), "not an id");

const ContactSwitch = z.object({ contactId: z.string(), translation: ContactTranslation });

export const translationRoutes = {
  opsTranslation: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/translation",
    auth: "session",
    roles: ["operator"],
    summary:
      "A client's message translation: its working language, switches, model and daily limit",
    params: z.object({ id: Id }),
    response: z.object({ translation: OpsTranslationSettingsView }),
  }),
  opsSetTranslation: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/translation",
    auth: "session",
    roles: ["operator"],
    summary:
      "Set a client's working language for messages (null turns translation off), its switches, model and daily limit",
    params: z.object({ id: Id }),
    body: OpsTranslationBody,
    response: z.object({ translation: OpsTranslationSettingsView }),
  }),
  portalTranslation: defineRoute({
    method: "GET",
    path: "/api/translation",
    auth: "session",
    roles: ["client_admin", "client_user"],
    summary: "Your team's working language for messages, and what we translate",
    response: z.object({ translation: TranslationSettingsView }),
  }),
  portalSetTranslation: defineRoute({
    method: "PUT",
    path: "/api/translation",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "Keep your messages in one working language (null turns it off): what comes in, what you write and your team's thread messages",
    body: PortalTranslationBody,
    response: z.object({ translation: TranslationSettingsView }),
  }),
  opsContactTranslation: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/contacts/:contactId/translation",
    auth: "session",
    roles: ["operator"],
    summary: "Translate this person's messages, or not, whatever the client's setting",
    params: z.object({ id: Id, contactId: Id }),
    body: ContactTranslationBody,
    response: ContactSwitch,
  }),
  portalContactTranslation: defineRoute({
    method: "PUT",
    path: "/api/contacts/:id/translation",
    auth: "session",
    roles: ["client_admin"],
    summary: "Translate this person's messages, or not, whatever your team's setting",
    params: z.object({ id: Id }),
    body: ContactTranslationBody,
    response: ContactSwitch,
  }),
} as const;
