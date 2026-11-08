import { z } from "zod";
import { ContactAutonomy } from "../directory/autonomy";
import { ContactAccess } from "../directory/invite";
import { DIRECTORY_TITLE_MAX, OrganizationKind, Relationship } from "../directory/kinds";
import { LanguageUsed } from "../directory/language";
import { Locale } from "../i18n/locale";
import { isUuid } from "../ids";
// P-8: US texting registration by API
import { A2pCampaignText, A2pRegistrationState } from "../messaging/a2p";
import {
  CONSENT_SOURCE_MAX,
  ConsentChannel,
  ContactConsent,
  E164,
  QuietHours,
} from "../messaging/rules";
import { ReachChannel, RoleName } from "../reach/rules";
// P-7
import { ContactTranslation, OpsTranslationView, TranslationView } from "../translate/settings";
import { A2pRegistrationView } from "./a2p";
import { defineRoute } from "./contract";

// Texts and WhatsApp through Twilio (docs/plan.md §1.19, §1.22): a client's contacts and their
// consent, Mezonas' Twilio subaccount and numbers for the client (the operator's alone: a number
// costs money and agents can't change their own setup), A2P 10DLC status, quiet hours, and the
// public routes Twilio calls with inbound messages and delivery status.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;

export const CONTACT_NAME_MAX = 120;
/**
 * One of the six languages agents write in (docs/plan.md §1.18, §1.27).
 */
// DECISION: contacts used to accept any `xx` or `xx-YY` tag; new values must be one of the six.
// Values stored before are kept and read through `supportedLanguage` (a regional tag reads as its
// language, anything else falls through to the organization's or the client's).
const Language = Locale;

// ── Contacts ─────────────────────────────────────────────────────────────────────────────────────

/** A phone as typed; the API turns it into E.164 or answers 422 `invalid_phone`. */
const PhoneInput = z.string().trim().min(1).max(40);
/** Stored in lower case. */
export const EmailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "an email address like pat@shop.com");
/** An IANA zone, checked by the API against the runtime's list. */
const Timezone = z.string().trim().min(1).max(64);
export const CONTACT_NOTES_MAX = 2000;
export const CONTACT_ROLES_MAX = 10;
const Roles = z.array(RoleName).max(CONTACT_ROLES_MAX);
const Preferred = z.array(ReachChannel).max(4);

export const ContactCreate = z
  .strictObject({
    name: z.string().trim().min(1).max(CONTACT_NAME_MAX),
    phone: PhoneInput.optional(),
    whatsapp: PhoneInput.optional(),
    email: EmailAddress.optional(),
    language: Language.optional(),
    preferredChannels: Preferred.optional(),
    timezone: Timezone.optional(),
    quietHours: QuietHours.optional(),
    roles: Roles.optional(),
    notes: z.string().trim().max(CONTACT_NOTES_MAX).optional(),
    /** The directory (docs/plan.md §1.27): the person's organization, title and relationship. */
    organizationId: Id.optional(),
    title: z.string().trim().min(1).max(DIRECTORY_TITLE_MAX).optional(),
    relationship: Relationship.optional(),
    /** Consent given already (e.g. on the client's web form): channels and how. */
    consent: z
      .strictObject({
        channels: z.array(ConsentChannel).min(1),
        source: z.string().trim().min(1).max(CONSENT_SOURCE_MAX),
      })
      .optional(),
  })
  .refine((b) => b.phone !== undefined || b.whatsapp !== undefined || b.email !== undefined, {
    message: "give a phone, a WhatsApp number or an email address",
    path: ["phone"],
  });
export type ContactCreateInput = z.input<typeof ContactCreate>;

export const ContactPatch = z.strictObject({
  name: z.string().trim().min(1).max(CONTACT_NAME_MAX).optional(),
  phone: PhoneInput.nullable().optional(),
  whatsapp: PhoneInput.nullable().optional(),
  email: EmailAddress.nullable().optional(),
  language: Language.nullable().optional(),
  preferredChannels: Preferred.optional(),
  timezone: Timezone.nullable().optional(),
  quietHours: QuietHours.nullable().optional(),
  roles: Roles.optional(),
  notes: z.string().trim().max(CONTACT_NOTES_MAX).nullable().optional(),
  organizationId: Id.nullable().optional(),
  title: z.string().trim().max(DIRECTORY_TITLE_MAX).nullable().optional(),
  relationship: Relationship.nullable().optional(),
});
export type ContactPatchInput = z.input<typeof ContactPatch>;

/**
 * A change to a contact's consent. Opt-outs from a STOP text are lifted only by the contact's own
 * START; an opt-out a person recorded can be lifted by a person.
 */
export const ContactConsentChange = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("grant"),
    channel: ConsentChannel,
    source: z.string().trim().min(1).max(CONSENT_SOURCE_MAX),
  }),
  z.strictObject({ action: z.literal("withdraw"), channel: ConsentChannel }),
  z.strictObject({ action: z.literal("opt_out") }),
  z.strictObject({ action: z.literal("lift_opt_out") }),
]);
export type ContactConsentChangeInput = z.input<typeof ContactConsentChange>;

export const Contact = z.object({
  id: z.string(),
  name: z.string(),
  phone: E164.nullable(),
  whatsapp: E164.nullable(),
  email: z.string().nullable().optional(),
  language: z.string().nullable(),
  preferredChannels: z.array(ReachChannel).optional(),
  /** Null: the client's timezone and quiet hours. */
  timezone: z.string().nullable().optional(),
  quietHours: QuietHours.nullable().optional(),
  roles: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
  /** The directory (docs/plan.md §1.27). */
  organization: z
    .object({
      id: z.string(),
      name: z.string(),
      language: z.string().nullable().optional(),
      /** What the organization is to the client (the directory's list; `own` is the client's). */
      kinds: z.array(OrganizationKind).optional(),
    })
    .nullable()
    .optional(),
  /** The language agents write to them in: theirs, else their organization's, else yours. */
  languageUsed: LanguageUsed.optional(),
  title: z.string().nullable().optional(),
  relationship: Relationship.nullable().optional(),
  /** `manual`, `csv`, `agent` or a connector; null: added before the directory. */
  source: z.string().nullable().optional(),
  consent: ContactConsent,
  optedOut: z.object({ at: z.string(), source: z.string() }).nullable(),
  /** Whether a send could go out now, quiet hours aside. */
  canMessage: z.object({ sms: z.boolean(), whatsapp: z.boolean() }),
  /** Whether an agent's call could be placed now (consent to calls, a phone), quiet hours aside. */
  canCall: z.boolean().optional(),
  /** Whether an agent's email could go out now (an address and consent, not opted out). */
  canEmail: z.boolean().optional(),
  // v0.12 W1-G: per channel, `auto`, `approval` or `off`; a channel left out narrows nothing.
  autonomy: ContactAutonomy.optional(),
  // P-7: this person's switch over the client's translation (docs/plan.md §1.69).
  translation: ContactTranslation.optional(),
  /**
   * Whether they can sign in (2026-11-08): `member`, `invited` (not signed in yet) or null. Only
   * in the directory's list, for the client admin and the operator.
   */
  access: ContactAccess.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Contact = z.infer<typeof Contact>;

/** One message in a contact's thread. The text is the sender's: shown to people, never obeyed. */
export const ContactMessage = z.object({
  id: z.string(),
  direction: z.enum(["in", "out"]),
  /** `voice`: a phone call; its text is the call's summary (or what happened, e.g. voicemail). */
  channel: z.enum(["sms", "whatsapp", "voice", "email"]),
  /** A reach-out line: why, by which agent version, about which records (invariant 10). */
  reachOut: z
    .object({
      id: z.string(),
      runId: z.string().nullable(),
      agentVersionId: z.string().nullable(),
      sources: z.array(z.string()),
    })
    .optional(),
  text: z.string(),
  /** The provider's message id. */
  sid: z.string().nullable(),
  /** Delivery status for messages we sent (queued, sent, delivered, failed…). */
  status: z.string().nullable(),
  at: z.string(),
  // P-7: the latest translation of this message, beside it (docs/plan.md §1.69).
  translation: TranslationView.optional(),
});
export type ContactMessage = z.infer<typeof ContactMessage>;

/** P-7: the back office's line: its translation with the model and cost (docs/plan.md §1.69). */
export const OpsContactMessage = ContactMessage.extend({
  translation: OpsTranslationView.optional(),
});
export type OpsContactMessage = z.infer<typeof OpsContactMessage>;

const ContactParams = z.object({ id: Id, contactId: Id });
const PortalContactParams = z.object({ id: Id });
const ContactList = z.object({ items: z.array(Contact) });
const OneContact = z.object({ contact: Contact });
const MessageList = z.object({ items: z.array(ContactMessage) });
const OpsMessageList = z.object({ items: z.array(OpsContactMessage) });

// ── Twilio setup ─────────────────────────────────────────────────────────────────────────────────

export const TwilioNumber = z.object({
  sid: z.string(),
  phoneNumber: E164,
  friendlyName: z.string().nullable(),
  capabilities: z.object({ sms: z.boolean(), mms: z.boolean(), voice: z.boolean() }),
  /** Registered as the client's WhatsApp sender (Twilio's self sign-up, done by the operator). */
  whatsapp: z.boolean(),
  purchasedAt: z.string(),
});
export type TwilioNumber = z.infer<typeof TwilioNumber>;

export const A2pStatus = z.enum(["not_started", "pending", "approved", "failed"]);
export type A2pStatus = z.infer<typeof A2pStatus>;

export const A2pRegistration = z.object({
  /** BN… */
  brandSid: z.string().nullable(),
  /** The Messaging Service (MG…) the campaign is registered on. */
  messagingServiceSid: z.string().nullable(),
  brandStatus: z.string().nullable(),
  campaignStatus: z.string().nullable(),
  status: A2pStatus,
  checkedAt: z.string().nullable(),
  // P-8: the registration by API, when Mezonas registers it (docs/plan.md §1.70); absent for a
  // client registered by hand in Twilio's console.
  registration: A2pRegistrationState.optional(),
});
export type A2pRegistration = z.infer<typeof A2pRegistration>;

export const AvailableNumber = z.object({
  phoneNumber: E164,
  friendlyName: z.string().nullable(),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  capabilities: z.object({ sms: z.boolean(), mms: z.boolean(), voice: z.boolean() }),
});
export type AvailableNumber = z.infer<typeof AvailableNumber>;

export const MessagingSetup = z.object({
  /** Whether this deployment has Mezonas' Twilio account (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN). */
  available: z.boolean(),
  timezone: z.string(),
  quietHours: QuietHours,
  twilio: z
    .object({
      connectionId: z.string(),
      status: z.string(),
      subaccountSid: z.string(),
      numbers: z.array(TwilioNumber),
      a2p: A2pRegistration,
      // P-8: the registration by API, as the operator reviews it.
      registration: A2pRegistrationView.nullable().optional(),
    })
    .nullable(),
  /** Where Twilio sends inbound messages and delivery status for this client. */
  webhooks: z.object({ messages: z.string(), status: z.string() }),
});
export type MessagingSetup = z.infer<typeof MessagingSetup>;

const SetupResponse = z.object({ setup: MessagingSetup });
const ClientParams = z.object({ id: Id });
const NumberParams = z.object({ id: Id, sid: z.string().regex(/^PN[0-9a-fA-F]{32}$/) });

/** What Twilio's inbound and status webhooks are answered with: empty TwiML. */
export const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export const messagingRoutes = {
  // Contacts, back office.
  opsContacts: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/contacts",
    auth: "session",
    roles: OPS,
    summary: "A client's contacts, by name",
    params: ClientParams,
    response: ContactList,
  }),
  opsCreateContact: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/contacts",
    auth: "session",
    roles: OPS,
    summary: "Add a contact to a client",
    params: ClientParams,
    body: ContactCreate,
    response: OneContact,
  }),
  opsUpdateContact: defineRoute({
    method: "PATCH",
    path: "/api/ops/clients/:id/contacts/:contactId",
    auth: "session",
    roles: OPS,
    summary: "Edit a contact's name, numbers or language",
    params: ContactParams,
    body: ContactPatch,
    response: OneContact,
  }),
  opsContactConsent: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/contacts/:contactId/consent",
    auth: "session",
    roles: OPS,
    summary: "Record consent, withdraw it, opt a contact out, or lift an opt-out a person set",
    params: ContactParams,
    body: ContactConsentChange,
    response: OneContact,
  }),
  opsContactMessages: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/contacts/:contactId/messages",
    auth: "session",
    roles: OPS,
    summary: "A contact's messages, newest first",
    params: ContactParams,
    response: OpsMessageList,
  }),
  // Contacts, portal (the client admin).
  portalContacts: defineRoute({
    method: "GET",
    path: "/api/contacts",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Your contacts, by name",
    response: ContactList,
  }),
  portalCreateContact: defineRoute({
    method: "POST",
    path: "/api/contacts",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Add a contact",
    body: ContactCreate,
    response: OneContact,
  }),
  portalUpdateContact: defineRoute({
    method: "PATCH",
    path: "/api/contacts/:id",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Edit a contact",
    params: PortalContactParams,
    body: ContactPatch,
    response: OneContact,
  }),
  portalContactConsent: defineRoute({
    method: "POST",
    path: "/api/contacts/:id/consent",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Record a contact's consent, withdraw it, or opt them out",
    params: PortalContactParams,
    body: ContactConsentChange,
    response: OneContact,
  }),
  portalContactMessages: defineRoute({
    method: "GET",
    path: "/api/contacts/:id/messages",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "A contact's messages, newest first",
    params: PortalContactParams,
    response: MessageList,
  }),
  // Twilio setup, back office only.
  opsMessaging: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/messaging",
    auth: "session",
    roles: OPS,
    summary: "A client's texting setup: Twilio subaccount, numbers, A2P 10DLC, quiet hours",
    params: ClientParams,
    response: SetupResponse,
  }),
  opsMessagingSettings: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/messaging",
    auth: "session",
    roles: OPS,
    summary: "Set a client's quiet hours (in its timezone)",
    params: ClientParams,
    body: z.strictObject({ quietHours: QuietHours }),
    response: SetupResponse,
  }),
  opsTwilioProvision: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/messaging/twilio",
    auth: "session",
    roles: OPS,
    summary: "Make the client's Twilio subaccount under Mezonas' account and connect it",
    params: ClientParams,
    response: SetupResponse,
  }),
  opsTwilioAvailableNumbers: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/messaging/numbers/available",
    auth: "session",
    roles: OPS,
    summary: "Numbers Twilio has for sale, by country and area code",
    params: ClientParams,
    query: z.object({
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .default("US"),
      areaCode: z
        .string()
        .regex(/^\d{3}$/)
        .optional(),
      contains: z
        .string()
        .regex(/^[0-9*]{1,10}$/)
        .optional(),
    }),
    response: z.object({ items: z.array(AvailableNumber) }),
  }),
  opsTwilioBuyNumber: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/messaging/numbers",
    auth: "session",
    roles: OPS,
    summary: "Buy a number in the client's subaccount, pointed at our webhooks",
    params: ClientParams,
    body: z.strictObject({ phoneNumber: E164 }),
    response: SetupResponse,
  }),
  opsTwilioReleaseNumber: defineRoute({
    method: "DELETE",
    path: "/api/ops/clients/:id/messaging/numbers/:sid",
    auth: "session",
    roles: OPS,
    summary: "Release a number back to Twilio",
    params: NumberParams,
    response: SetupResponse,
  }),
  opsTwilioNumberWhatsApp: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/messaging/numbers/:sid/whatsapp",
    auth: "session",
    roles: OPS,
    summary: "Mark a number as the client's WhatsApp sender, once registered with Twilio",
    params: NumberParams,
    body: z.strictObject({ enabled: z.boolean() }),
    response: SetupResponse,
  }),
  opsTwilioA2p: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/messaging/a2p",
    auth: "session",
    roles: OPS,
    summary: "Record the client's A2P 10DLC brand and Messaging Service",
    params: ClientParams,
    body: z.strictObject({
      brandSid: z
        .string()
        .regex(/^BN[0-9a-fA-F]{32}$/)
        .nullable(),
      messagingServiceSid: z
        .string()
        .regex(/^MG[0-9a-fA-F]{32}$/)
        .nullable(),
    }),
    response: SetupResponse,
  }),
  // P-8: submit the client's details to Twilio (docs/plan.md §1.70).
  opsA2pSubmit: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/messaging/a2p/submit",
    auth: "session",
    roles: OPS,
    summary: "Submit (or resubmit) the client's US texting registration to Twilio, fees confirmed",
    params: ClientParams,
    body: z.strictObject({
      reason: z.string().trim().min(3).max(500),
      /** The operator read the fees shown for this submit. */
      confirmFees: z.literal(true),
      /** The campaign's words, if the operator edited them. */
      campaign: A2pCampaignText.optional(),
    }),
    response: SetupResponse,
  }),
  opsTwilioA2pRefresh: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/messaging/a2p/refresh",
    auth: "session",
    roles: OPS,
    summary: "Ask Twilio for the A2P 10DLC brand and campaign status",
    params: ClientParams,
    response: SetupResponse,
  }),
  // Twilio's webhooks: no session; X-Twilio-Signature is the credential.
  twilioInboundMessage: defineRoute({
    method: "POST",
    path: "/api/twilio/:tenantId/messages",
    auth: "public",
    roles: [],
    summary: "Twilio: a text or WhatsApp message to one of the client's numbers (signed)",
    params: z.object({ tenantId: Id }),
    response: z.string(),
  }),
  twilioMessageStatus: defineRoute({
    method: "POST",
    path: "/api/twilio/:tenantId/status",
    auth: "public",
    roles: [],
    summary: "Twilio: the delivery status of a message we sent (signed)",
    params: z.object({ tenantId: Id }),
    response: z.string(),
  }),
} as const;
