// Twilio for the code service: checking the signature on inbound texts and buying or releasing an
// identity's number, in the codes subaccount (MFA_TWILIO_ACCOUNT_SID / MFA_TWILIO_AUTH_TOKEN), which
// is separate from the subaccounts clients text from (docs/plan.md §1.26 "Agent identities").
// The REST calls follow packages/connectors/src/twilio/ (copied, not imported: this app imports
// core only); the facts marked UNCHECKED there are unchecked here too (NOTES.md).

import { constantTimeEqual, toBase64 } from "./crypto";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

/**
 * X-Twilio-Signature: base64 of HMAC-SHA1 under the auth token, over the URL Twilio called followed
 * by each POST parameter's name and value, names sorted.
 */
export async function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toBase64(new Uint8Array(sig));
}

export async function verifyTwilioSignature(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | undefined | null;
}): Promise<boolean> {
  if (!input.signature) return false;
  const expected = await twilioSignature(input.authToken, input.url, input.params);
  return constantTimeEqual(input.signature.trim(), expected);
}

export interface TwilioAccount {
  accountSid: string;
  authToken: string;
}

export class TwilioError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(
  fetcher: typeof fetch,
  account: TwilioAccount,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, string>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    authorization: `Basic ${btoa(`${account.accountSid}:${account.authToken}`)}`,
  };
  let payload: string | undefined;
  if (body) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetcher(`${TWILIO_API}/Accounts/${account.accountSid}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  if (res.status === 204) return null;
  const json = (await res.json().catch(() => null)) as { message?: unknown } | null;
  if (!res.ok) {
    const msg = typeof json?.message === "string" ? json.message : `HTTP ${res.status}`;
    throw new TwilioError(`Twilio: ${msg}`, res.status);
  }
  return json;
}

export interface BoughtNumber {
  sid: string;
  phoneNumber: string;
}

/**
 * Finds a US local number that can receive texts (in `areaCode` when given), buys it, and points
 * its inbound texts at `smsUrl` (POST).
 */
// DECISION: US local numbers only, as the messaging setup screen does today; other countries need a
// regulatory bundle first (packages/connectors/src/twilio/NOTES.md).
export async function buyNumber(
  fetcher: typeof fetch,
  account: TwilioAccount,
  input: { areaCode?: string | undefined; smsUrl: string; friendlyName: string },
): Promise<BoughtNumber> {
  const q = new URLSearchParams({ SmsEnabled: "true", PageSize: "5" });
  if (input.areaCode) q.set("AreaCode", input.areaCode);
  const found = (await call(
    fetcher,
    account,
    "GET",
    `/AvailablePhoneNumbers/US/Local.json?${q.toString()}`,
  )) as { available_phone_numbers?: { phone_number?: unknown }[] } | null;
  const candidate = found?.available_phone_numbers?.find((n) => typeof n.phone_number === "string")
    ?.phone_number as string | undefined;
  if (!candidate) throw new TwilioError("Twilio: no number available", 404);
  const bought = (await call(fetcher, account, "POST", "/IncomingPhoneNumbers.json", {
    PhoneNumber: candidate,
    SmsUrl: input.smsUrl,
    SmsMethod: "POST",
    FriendlyName: input.friendlyName,
  })) as { sid?: unknown; phone_number?: unknown } | null;
  if (typeof bought?.sid !== "string" || typeof bought.phone_number !== "string") {
    throw new TwilioError("Twilio: unexpected answer buying a number", 502);
  }
  return { sid: bought.sid, phoneNumber: bought.phone_number };
}

/** Releases a number back to Twilio. A number already gone counts as released. */
export async function releaseNumber(
  fetcher: typeof fetch,
  account: TwilioAccount,
  sid: string,
): Promise<void> {
  try {
    await call(fetcher, account, "DELETE", `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`);
  } catch (error) {
    if (error instanceof TwilioError && error.status === 404) return;
    throw error;
  }
}

/** Twilio's reply to an inbound text: an empty TwiML response, so nothing is sent back. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
