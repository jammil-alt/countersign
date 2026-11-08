// Twilio's REST API as the connector uses it: Basic auth with an account's SID and auth token, form
// bodies, JSON answers. Every call goes through an injected fetch (tests answer from a fake Twilio,
// @countersign/connectors/testing). Details not checked against Twilio's docs are in NOTES.md.

import { z } from "zod";
import {
  constantTimeEqual,
  type FetchLike,
  formEncode,
  type HttpResponseLike,
  timeoutSignal,
} from "../http";
import { hmacKey, subtle, toBase64, utf8 } from "../runtime";

export const TWILIO_API = "https://api.twilio.com/2010-04-01";
export const TWILIO_MESSAGING_API = "https://messaging.twilio.com/v1";
const TIMEOUT_MS = 15_000;

export const AccountSid = z.string().regex(/^AC[0-9a-f]{32}$/);

export interface TwilioAuth {
  accountSid: string;
  authToken: string;
}

export class TwilioError extends Error {
  constructor(
    readonly status: number | null,
    /** Twilio's error code (e.g. 21211 invalid To), when it gave one. */
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "TwilioError";
  }
}

function basic(auth: TwilioAuth): string {
  return `Basic ${toBase64(utf8(`${auth.accountSid}:${auth.authToken}`))}`;
}

/** One call. `form` goes as application/x-www-form-urlencoded; GET parameters go in `query`. */
export async function twilioRequest(
  fetch: FetchLike,
  auth: TwilioAuth,
  method: "GET" | "POST" | "DELETE",
  url: string,
  opts: {
    form?: Record<string, string>;
    query?: Record<string, string | undefined>;
    // P-3: a field Twilio takes more than once (`MediaUrl`), after the form's own fields.
    repeated?: { name: string; values: readonly string[] };
    // P-8: more than one such field (a campaign's samples and keywords, docs/plan.md §1.70).
    repeatedMany?: readonly { name: string; values: readonly string[] }[];
  } = {},
): Promise<unknown> {
  const q = Object.entries(opts.query ?? {}).filter(
    (e): e is [string, string] => e[1] !== undefined,
  );
  const lists = [...(opts.repeated ? [opts.repeated] : []), ...(opts.repeatedMany ?? [])];
  const repeated = lists
    .flatMap((r) => r.values.map((v) => `${encodeURIComponent(r.name)}=${encodeURIComponent(v)}`))
    .join("&");
  const full = q.length > 0 ? `${url}?${formEncode(Object.fromEntries(q))}` : url;
  let res: HttpResponseLike;
  try {
    res = await fetch(full, {
      method,
      headers: {
        authorization: basic(auth),
        accept: "application/json",
        ...(opts.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(opts.form
        ? { body: [formEncode(opts.form), repeated].filter((p) => p !== "").join("&") }
        : {}),
      redirect: "manual",
      signal: timeoutSignal(TIMEOUT_MS),
    });
  } catch (error) {
    throw new TwilioError(null, null, `could not reach Twilio: ${(error as Error).message}`);
  }
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof b.code === "number" ? b.code : null;
    const message = typeof b.message === "string" ? b.message : `Twilio answered ${res.status}`;
    throw new TwilioError(res.status, code, message);
  }
  return body;
}

export const accountUrl = (sid: string) => `${TWILIO_API}/Accounts/${sid}`;

// ── Webhook signatures ──────────────────────────────────────────────────────────────────────────

/**
 * X-Twilio-Signature: base64 of HMAC-SHA1 under the account's auth token, over the URL Twilio
 * called (as configured, with any query string) followed by each POST parameter's name and value,
 * names sorted.
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
  const sig = await subtle().sign("HMAC", await hmacKey(utf8(authToken), "SHA-1"), utf8(data));
  return toBase64(new Uint8Array(sig));
}

export async function verifyTwilioSignature(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | undefined;
}): Promise<boolean> {
  if (!input.signature) return false;
  const expected = await twilioSignature(input.authToken, input.url, input.params);
  return constantTimeEqual(input.signature.trim(), expected);
}
