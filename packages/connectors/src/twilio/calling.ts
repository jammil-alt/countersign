// §1.160: calls that carry the client's name. Two Trust Hub trust products in the client's
// subaccount, both on the secondary customer profile its texting registration made (a2p.ts):
// SHAKEN/STIR, so carriers see our calls signed with "A" attestation, and CNAM, so the person
// called sees the client's name. Both are free; Twilio reviews them. Each number is assigned to
// the profile and to both products. Facts and their sources are in NOTES.md, "Calls that carry
// the client's name".

import { CNAM_NAME_RE } from "@countersign/core";
import { z } from "zod";
import type { FetchLike } from "../http";
import { type BundleKind, BundleSid, EndUserSid, TWILIO_TRUSTHUB_API } from "./a2p";
import { type TwilioAuth, twilioRequest } from "./api";

// DECISION: the policy SIDs are written here as for A2P's. Twilio's SHAKEN/STIR and CNAM guides
// call them static across accounts; its Trust Hub overview says to read them from /Policies.
// A wrong one fails the create loudly, so we keep them as constants.
/** Trust Hub's policy for the SHAKEN/STIR trust product (SHAKEN/STIR ISV guide). */
export const SHAKEN_STIR_POLICY = "RN7a97559effdf62d00f4298208492a5ea";
/** Trust Hub's policy for the CNAM trust product (Branded calls using CNAM). */
export const CNAM_POLICY = "RNf3db3cd1fe25fcfd3c3ded065c8fea53";

export type CallingProduct = "shaken_stir" | "cnam";
const POLICY: Record<CallingProduct, string> = {
  shaken_stir: SHAKEN_STIR_POLICY,
  cnam: CNAM_POLICY,
};

const Created = z.looseObject({ sid: BundleSid, status: z.string() });

/** An empty trust product for calls (status `draft`). */
export async function createCallingProduct(
  fetch: FetchLike,
  auth: TwilioAuth,
  product: CallingProduct,
  input: { friendlyName: string; email: string },
): Promise<{ sid: string; status: string }> {
  const b = Created.parse(
    await twilioRequest(fetch, auth, "POST", `${TWILIO_TRUSTHUB_API}/TrustProducts`, {
      form: {
        FriendlyName: input.friendlyName.slice(0, 64),
        Email: input.email,
        PolicySid: POLICY[product],
      },
    }),
  );
  return { sid: b.sid, status: b.status };
}

/** The name calls show (`cnam_information`): at most 15 letters, digits, periods, commas, spaces. */
export async function createCnamEndUser(
  fetch: FetchLike,
  auth: TwilioAuth,
  displayName: string,
): Promise<string> {
  if (!CNAM_NAME_RE.test(displayName)) throw new Error("not a caller name Twilio accepts");
  return z.looseObject({ sid: EndUserSid }).parse(
    await twilioRequest(fetch, auth, "POST", `${TWILIO_TRUSTHUB_API}/EndUsers`, {
      form: {
        Type: "cnam_information",
        FriendlyName: `Caller name ${displayName}`.slice(0, 64),
        Attributes: JSON.stringify({ cnam_display_name: displayName }),
      },
    }),
  ).sid;
}

/** Changes the name on an existing CNAM end user (before it is sent again for review). */
export async function updateCnamEndUser(
  fetch: FetchLike,
  auth: TwilioAuth,
  endUserSid: string,
  displayName: string,
): Promise<void> {
  if (!CNAM_NAME_RE.test(displayName)) throw new Error("not a caller name Twilio accepts");
  await twilioRequest(fetch, auth, "POST", `${TWILIO_TRUSTHUB_API}/EndUsers/${endUserSid}`, {
    form: { Attributes: JSON.stringify({ cnam_display_name: displayName }) },
  });
}

const Assignment = z.looseObject({ sid: z.string().regex(/^RA[0-9a-fA-F]{32}$/) });

/** Puts a number (PN…) on a profile or trust product. Returns the assignment (RA…). */
export async function assignNumber(
  fetch: FetchLike,
  auth: TwilioAuth,
  kind: BundleKind,
  bundleSid: string,
  numberSid: string,
): Promise<string> {
  return Assignment.parse(
    await twilioRequest(
      fetch,
      auth,
      "POST",
      `${TWILIO_TRUSTHUB_API}/${kind}/${bundleSid}/ChannelEndpointAssignments`,
      { form: { ChannelEndpointType: "phone-number", ChannelEndpointSid: numberSid } },
    ),
  ).sid;
}

/** Takes a number off a profile or trust product (before it is released). */
export async function unassignNumber(
  fetch: FetchLike,
  auth: TwilioAuth,
  kind: BundleKind,
  bundleSid: string,
  assignmentSid: string,
): Promise<void> {
  await twilioRequest(
    fetch,
    auth,
    "DELETE",
    `${TWILIO_TRUSTHUB_API}/${kind}/${bundleSid}/ChannelEndpointAssignments/${assignmentSid}`,
  );
}
