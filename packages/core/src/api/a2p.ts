import { z } from "zod";
import {
  A2P_ISSUE_SOURCES,
  A2pBusinessDetails,
  A2pCampaignText,
  A2pFeeLine,
  A2pStage,
} from "../messaging/a2p";
import { defineRoute } from "./contract";

// P-8: US texting registration (A2P 10DLC) by API (docs/plan.md §1.70). The client admin gives the
// business details in the portal (the EIN write-only); the operator reviews them, sees the fees
// and submits; the cron follows Twilio's statuses. The portal's view has no SID, fee or cost.

const CLIENT_ADMIN = ["client_admin"] as const;

/**
 * The details as a body: `uses` is read as words so a body naming `marketing` is refused with its
 * own reason (422 `marketing_refused`) rather than a generic one; the route then parses it strictly.
 */
export const A2pDetailsBody = A2pBusinessDetails.extend({
  uses: z.array(z.string().max(40)).min(1).max(5),
});

/** A reason Twilio gave, with what to fix, in plain words. */
export const A2pIssueView = z.object({
  source: z.enum(A2P_ISSUE_SOURCES),
  code: z.string().nullable(),
  fields: z.array(z.string()),
  description: z.string(),
  words: z.string(),
});

/** The portal's view: the client's own details and where things stand. No SID, fee or cost. */
export const TextingRegistrationView = z.object({
  /** Whether the client has a Twilio subaccount with us (the details live on it). */
  available: z.boolean(),
  stage: A2pStage,
  details: A2pBusinessDetails.nullable(),
  einSet: z.boolean(),
  /** `••-•••••89`: what is shown of the EIN. */
  einHint: z.string().nullable(),
  editable: z.boolean(),
  /** What Twilio needs changed, in plain words. */
  needs: z.array(z.string()),
  updatedAt: z.string().nullable(),
});
export type TextingRegistrationView = z.infer<typeof TextingRegistrationView>;

/** The back office's view, on the client's messaging page. */
export const A2pRegistrationView = z.object({
  stage: A2pStage,
  details: A2pBusinessDetails.nullable(),
  detailsUpdatedAt: z.string().nullable(),
  einSet: z.boolean(),
  einHint: z.string().nullable(),
  /** What a submit still needs (`details`, `ein`, `stage`, `settings`); empty: it can go. */
  missing: z.array(z.string()),
  brandType: z.enum(["standard", "low_volume"]),
  useCase: z.enum(["MIXED", "LOW_VOLUME"]),
  /** The campaign's words the next submit sends (the operator's edit, else built). */
  campaign: A2pCampaignText.nullable(),
  campaignEdited: z.boolean(),
  statuses: z.object({
    customerProfile: z.string().nullable(),
    trustProduct: z.string().nullable(),
    brand: z.string().nullable(),
    campaign: z.string().nullable(),
  }),
  sids: z.object({
    customerProfile: z.string().nullable(),
    trustProduct: z.string().nullable(),
    brand: z.string().nullable(),
    messagingService: z.string().nullable(),
  }),
  issues: z.array(A2pIssueView),
  /** What the next submit charges, before it is sent. */
  fees: z.object({ lines: z.array(A2pFeeLine), nowUsd: z.string() }),
  /** Fees recorded as the client's usage. */
  recorded: z.array(
    z.object({ key: z.string(), kind: z.string(), amountUsd: z.string(), at: z.string() }),
  ),
  submissions: z.array(z.object({ at: z.string(), by: z.string(), reason: z.string() })),
  brandUpdates: z.number(),
  campaignAttempts: z.number(),
  serviceNumbers: z.array(z.string()),
  updatedAt: z.string().nullable(),
});
export type A2pRegistrationView = z.infer<typeof A2pRegistrationView>;

const PortalResponse = z.object({ registration: TextingRegistrationView });

export const a2pRoutes = {
  portalTextingRegistration: defineRoute({
    method: "GET",
    path: "/api/texting-registration",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "The client's US texting registration: its details and where it stands",
    response: PortalResponse,
  }),
  portalSaveTextingRegistration: defineRoute({
    method: "PUT",
    path: "/api/texting-registration",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Give the business details for US texting registration (the EIN is write-only)",
    body: z.strictObject({
      details: A2pDetailsBody,
      /** Only to set or replace it; leave it out to keep the one stored. */
      ein: z.string().max(20).optional(),
    }),
    response: PortalResponse,
  }),
};
