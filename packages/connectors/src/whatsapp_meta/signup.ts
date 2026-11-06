// v0.14 W4-A: Meta's Embedded Signup, finished on our server (docs/plan.md §1.57). The client admin
// completes Meta's flow in a pop-up opened by Meta's JS SDK on the portal's signup page; the page
// gets a short-lived code (and, from Meta's session-info message, the WhatsApp Business Account and
// number the admin chose). Here:
//   1. the code is exchanged for a business token (our app's id and secret, never the browser);
//   2. `debug_token` (with our app's token) proves the token is ours and names the accounts it
//      may manage: the account the page named must be one of them (the page is only a hint);
//   3. the account's numbers are listed with the token: the number the page named must be one;
//   4. a number another client has connected is refused before anything changes at Meta;
//   5. our app is subscribed to the account's webhooks, and the number registered for Cloud API
//      with a new six-digit PIN.
// The token, the account's id, the number's id and the PIN go to the client's vault only; the
// number's id is also the connection's account id (inbound messages are routed by it). The
// operator never holds them. Unchecked facts (the exchange's parameters, the PIN): ./NOTES.md.

import { type JsonObject, normalizePhone } from "@countersign/core";
import { z } from "zod";
import type { ConnectionGrant } from "../connector";
import type { FetchLike } from "../http";
import { SignInRefusedError } from "../oauth/tokens";
import { randomBytes } from "../runtime";
import { GRAPH_VERSION, graphCall, isGraphId, MetaGraphError } from "./graph";

export interface MetaApp {
  appId: string;
  appSecret: string;
  configId: string;
}

/** The two permissions Embedded Signup must grant (messaging, and managing the account). */
export const META_SCOPES = ["whatsapp_business_messaging", "whatsapp_business_management"];

/** The encrypted credentials (the client's vault): never in config, a response, a log or a step. */
export const MetaCredentials = z.object({
  accessToken: z.string().min(16).max(4096),
  wabaId: z.string().refine(isGraphId, "not a Graph id"),
  phoneNumberId: z.string().refine(isGraphId, "not a Graph id"),
  /** The two-step verification PIN the number was registered with. */
  pin: z.string().length(6),
  appId: z.string().refine(isGraphId, "not a Graph id"),
});
export type MetaCredentials = z.infer<typeof MetaCredentials>;

const Exchange = z.object({ access_token: z.string().min(16).max(4096) });

const Debug = z.object({
  data: z.object({
    app_id: z.string(),
    is_valid: z.boolean(),
    scopes: z.array(z.string()).default([]),
    granular_scopes: z
      .array(z.object({ scope: z.string(), target_ids: z.array(z.string()).optional() }))
      .default([]),
  }),
});

const Numbers = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        display_phone_number: z.string().max(40).optional(),
        verified_name: z.string().max(200).optional(),
      }),
    )
    .max(100),
});

/** A display number as Meta writes it (`+1 555-010-0199`, `15550100199`) in E.164, or null. */
export function displayE164(raw: string | undefined): string | null {
  if (!raw) return null;
  return normalizePhone(raw) ?? normalizePhone(`+${raw.trim()}`);
}

/**
 * A six-digit PIN from the CSPRNG. Each digit is a byte's low four bits, drawn again when 10–15,
 * so every digit is as likely; no modulo (CodeQL js/biased-cryptographic-random).
 */
export function newPin(): string {
  let pin = "";
  while (pin.length < 6) {
    for (const byte of randomBytes(8)) {
      const digit = byte & 0x0f;
      if (digit < 10 && pin.length < 6) pin += String(digit);
    }
  }
  return pin;
}

function refuse(message: string): never {
  throw new SignInRefusedError(message);
}

/** Embedded Signup's result → the connection's grant. Throws SignInRefusedError for a refusal. */
export async function completeEmbeddedSignup(
  fetch: FetchLike,
  app: MetaApp,
  params: Record<string, string>,
  accountTaken?: (phoneNumberId: string) => Promise<boolean>,
): Promise<ConnectionGrant> {
  const code = params.code;
  if (!code || code.length > 2048) refuse("Meta didn't send the sign-up's code; try again");
  const hintedWaba = params.waba_id ? params.waba_id : null;
  const hintedNumber = params.phone_number_id ? params.phone_number_id : null;
  if ((hintedWaba && !isGraphId(hintedWaba)) || (hintedNumber && !isGraphId(hintedNumber))) {
    refuse("Meta's sign-up named an account we can't read; try again");
  }

  // 1. The code, for a business token (no redirect URI: the SDK's pop-up flow).
  const exchanged = Exchange.safeParse(
    await graphCall(fetch, {
      method: "GET",
      segments: ["oauth", "access_token"],
      query: { client_id: app.appId, client_secret: app.appSecret, code },
    }),
  );
  if (!exchanged.success) refuse("Meta didn't give us a token for your account; try again");
  const token = exchanged.data.access_token;

  // 2. The token is ours, valid, with both permissions; the accounts it may manage.
  const debug = Debug.safeParse(
    await graphCall(fetch, {
      method: "GET",
      segments: ["debug_token"],
      query: { input_token: token, access_token: `${app.appId}|${app.appSecret}` },
    }),
  );
  if (!debug.success || !debug.data.data.is_valid || debug.data.data.app_id !== app.appId) {
    refuse("Meta's token isn't one for Mezonas; try again");
  }
  const scopes = new Set(debug.data.data.scopes);
  if (!META_SCOPES.every((s) => scopes.has(s))) {
    refuse("Meta didn't give us permission to message and manage your WhatsApp; connect again");
  }
  const managed = new Set(
    debug.data.data.granular_scopes
      .filter((g) => g.scope === "whatsapp_business_management")
      .flatMap((g) => g.target_ids ?? [])
      .filter(isGraphId),
  );
  const wabaId = hintedWaba ?? (managed.size === 1 ? [...managed][0] : undefined);
  if (!wabaId || !managed.has(wabaId)) {
    refuse("Pick one WhatsApp Business Account in Meta's window and connect again");
  }

  // 3. The account's numbers: the one chosen must be among them.
  const numbers = Numbers.safeParse(
    await graphCall(fetch, {
      method: "GET",
      segments: [wabaId, "phone_numbers"],
      query: { fields: "id,display_phone_number,verified_name" },
      token,
    }),
  );
  if (!numbers.success) refuse("Meta didn't list your account's numbers; try again");
  const listed = numbers.data.data.filter((n) => isGraphId(n.id));
  const number = hintedNumber
    ? listed.find((n) => n.id === hintedNumber)
    : listed.length === 1
      ? listed[0]
      : undefined;
  if (!number) refuse("Pick one phone number in Meta's window and connect again");
  const display = displayE164(number.display_phone_number);
  if (!display) refuse("Meta's number isn't one we can read; ask us to check");

  // 4. One client per number: its messages are routed to whoever has it.
  if (accountTaken && (await accountTaken(number.id))) {
    refuse("This WhatsApp number is already connected to another Mezonas account");
  }

  // 5. Our webhooks on the account, and the number on Cloud API.
  await graphCall(fetch, {
    method: "POST",
    segments: [wabaId, "subscribed_apps"],
    token,
  });
  const pin = newPin();
  try {
    await graphCall(fetch, {
      method: "POST",
      segments: [number.id, "register"],
      token,
      json: { messaging_product: "whatsapp", pin },
    });
  } catch (error) {
    // Nothing is kept: our subscription to the account is undone, best effort.
    await graphCall(fetch, {
      method: "DELETE",
      segments: [wabaId, "subscribed_apps"],
      token,
    }).catch(() => {});
    if (error instanceof MetaGraphError) {
      refuse(
        `Meta didn't let us register the number (${error.code ?? error.status}); ask us to check`,
      );
    }
    throw error;
  }

  const name = number.verified_name?.trim().slice(0, 120) || null;
  const credentials: MetaCredentials = {
    accessToken: token,
    wabaId,
    phoneNumberId: number.id,
    pin,
    appId: app.appId,
  };
  return {
    externalAccountId: number.id,
    credentials: credentials as unknown as JsonObject,
    config: {
      phoneNumber: display,
      ...(name ? { verifiedName: name } : {}),
      accountName: name ? `${name} (${display})` : display,
      graphVersion: GRAPH_VERSION,
    },
  };
}
