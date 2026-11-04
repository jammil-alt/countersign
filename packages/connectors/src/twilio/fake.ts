// A fake Twilio for tests (re-exported by @countersign/connectors/testing; never imported by the
// Worker): Mezonas' main account, subaccounts, numbers for sale and bought, messages sent and
// received, A2P 10DLC brand and campaign status. Answers are shaped like Twilio's as far as we know
// them (NOTES.md lists what is unverified). Basic auth is checked: an account may act only on itself,
// and the main account on its subaccounts.

import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { fromBase64, fromUtf8 } from "../runtime";
import { TWILIO_API, TWILIO_MESSAGING_API, twilioSignature } from "./api";

export interface FakeTwilioRequest {
  url: string;
  method: string;
  account: string | null;
  form: Record<string, string>;
}

interface FakeMessage {
  sid: string;
  account_sid: string;
  from: string;
  to: string;
  body: string;
  status: string;
  direction: string;
  date_sent: string;
  date_created: string;
  num_segments: string;
  num_media: string;
  error_code: number | null;
  content_sid?: string;
}

interface FakeNumber {
  sid: string;
  account_sid: string;
  phone_number: string;
  friendly_name: string;
  sms_url: string;
  voice_url?: string;
  status_callback?: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
}

interface FakeCall {
  sid: string;
  account_sid: string;
  from: string;
  to: string;
  url: string;
  status_callback: string;
  time_limit: string;
  status: string;
  direction: string;
}

const hex32 = (n: number) => n.toString(16).padStart(32, "0");

function json(status: number, body?: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}

/** RFC 2822, as Twilio writes dates. */
function rfc2822(d: Date): string {
  return d.toUTCString().replace("GMT", "+0000");
}

export const FAKE_TWILIO_MAIN = {
  accountSid: `AC${"a".repeat(32)}`,
  authToken: "main-auth-token-0000000000000000",
};

export function fakeTwilio(opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  let counter = 1;
  const next = () => counter++;
  const accounts = new Map<string, { token: string; parent: string | null; name: string }>([
    [
      FAKE_TWILIO_MAIN.accountSid,
      { token: FAKE_TWILIO_MAIN.authToken, parent: null, name: "Mezonas" },
    ],
  ]);
  const numbers = new Map<string, FakeNumber>();
  const messages = new Map<string, FakeMessage>();
  const calls = new Map<string, FakeCall>();
  const brands = new Map<string, string>();
  const campaigns = new Map<string, string>();
  const requests: FakeTwilioRequest[] = [];
  const forSale = ["+15125550101", "+15125550102", "+17375550103"];

  function authAccount(init: HttpRequestInit): string | null {
    const h = init.headers?.authorization ?? "";
    if (!h.startsWith("Basic ")) return null;
    let decoded = "";
    try {
      decoded = fromUtf8(fromBase64(h.slice(6)));
    } catch {
      return null;
    }
    const [sid, token] = [
      decoded.slice(0, decoded.indexOf(":")),
      decoded.slice(decoded.indexOf(":") + 1),
    ];
    return accounts.get(sid)?.token === token ? sid : null;
  }

  const mayActOn = (caller: string, target: string) =>
    caller === target || accounts.get(target)?.parent === caller;

  function addMessage(
    m: Omit<
      FakeMessage,
      "sid" | "date_sent" | "date_created" | "num_media" | "error_code" | "num_segments"
    > &
      Partial<FakeMessage>,
  ) {
    const at = rfc2822(now());
    const msg: FakeMessage = {
      sid: m.sid ?? `SM${hex32(next())}`,
      date_sent: at,
      date_created: at,
      num_media: "0",
      error_code: null,
      num_segments: String(Math.max(1, Math.ceil(m.body.length / 160))),
      ...m,
    } as FakeMessage;
    messages.set(msg.sid, msg);
    return msg;
  }

  const fetch: FetchLike = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const caller = authAccount(init);
    const form = init.body ? formDecode(init.body) : {};
    requests.push({ url, method, account: caller, form });
    const u = parseUrl(url);
    if (!u) return json(400, { code: 20001, message: "bad url" });
    if (!caller) return json(401, { code: 20003, message: "Authenticate", status: 401 });
    const query = Object.fromEntries(
      (url.split("?")[1] ?? "")
        .split("&")
        .filter(Boolean)
        .map(
          (p) =>
            p.split("=").map((s) => decodeURIComponent(s.replace(/\+/g, " "))) as [string, string],
        ),
    );

    if (url.startsWith(TWILIO_MESSAGING_API)) {
      const path = u.pathname.replace(/^\/v1/, "");
      const brand = path.match(/^\/a2p\/BrandRegistrations\/(BN[0-9a-f]{32})$/);
      if (brand?.[1] && method === "GET") {
        const status = brands.get(brand[1]);
        return status
          ? json(200, { sid: brand[1], status })
          : json(404, { code: 20404, message: "not found" });
      }
      const svc = path.match(/^\/Services\/(MG[0-9a-f]{32})\/Compliance\/Usa2p$/);
      if (svc?.[1] && method === "GET") {
        const status = campaigns.get(svc[1]);
        return json(200, {
          compliance: status ? [{ sid: `QE${hex32(1)}`, campaign_status: status }] : [],
        });
      }
      return json(404, { code: 20404, message: "not found" });
    }

    if (!url.startsWith(TWILIO_API)) return json(404, { code: 20404, message: "unknown host" });
    const path = u.pathname.replace(/^\/2010-04-01/, "");
    if (path === "/Accounts.json" && method === "POST") {
      const sid = `AC${hex32(next())}`;
      const token = `sub-token-${hex32(next()).slice(-22)}`;
      accounts.set(sid, { token, parent: caller, name: form.FriendlyName ?? "" });
      return json(201, {
        sid,
        auth_token: token,
        friendly_name: form.FriendlyName,
        status: "active",
        owner_account_sid: caller,
      });
    }
    const acc = path.match(/^\/Accounts\/(AC[0-9a-f]{32})\.json$/);
    if (acc?.[1] && method === "GET") {
      const a = accounts.get(acc[1]);
      if (!a || !mayActOn(caller, acc[1])) return json(404, { code: 20404, message: "not found" });
      return json(200, {
        sid: acc[1],
        auth_token: a.token,
        friendly_name: a.name,
        status: "active",
      });
    }
    const m = path.match(/^\/Accounts\/(AC[0-9a-f]{32})(\/.*)$/);
    if (!m?.[1] || !m[2]) return json(404, { code: 20404, message: "not found" });
    const [, account, rest] = m;
    if (!mayActOn(caller, account)) return json(403, { code: 20003, message: "forbidden" });

    const avail = rest.match(/^\/AvailablePhoneNumbers\/([A-Z]{2})\/Local\.json$/);
    if (avail && method === "GET") {
      const list = forSale
        .filter((n) => !query.AreaCode || n.startsWith(`+1${query.AreaCode}`))
        .map((n) => ({
          phone_number: n,
          friendly_name: `(${n.slice(2, 5)}) ${n.slice(5, 8)}-${n.slice(8)}`,
          locality: "Austin",
          region: "TX",
          iso_country: avail[1],
          capabilities: { voice: true, SMS: true, MMS: true },
        }));
      return json(200, { available_phone_numbers: list });
    }
    if (rest === "/IncomingPhoneNumbers.json" && method === "POST") {
      const phone = form.PhoneNumber ?? "";
      if (!forSale.includes(phone))
        return json(400, { code: 21422, message: "PhoneNumber is not available" });
      forSale.splice(forSale.indexOf(phone), 1);
      const n: FakeNumber = {
        sid: `PN${hex32(next())}`,
        account_sid: account,
        phone_number: phone,
        friendly_name: form.FriendlyName ?? phone,
        sms_url: form.SmsUrl ?? "",
        capabilities: { voice: true, sms: true, mms: true },
      };
      numbers.set(n.sid, n);
      return json(201, n);
    }
    const release = rest.match(/^\/IncomingPhoneNumbers\/(PN[0-9a-f]{32})\.json$/);
    if (release?.[1] && method === "POST") {
      const n = numbers.get(release[1]);
      if (!n || n.account_sid !== account) return json(404, { code: 20404, message: "not found" });
      if (form.VoiceUrl !== undefined) n.voice_url = form.VoiceUrl;
      if (form.StatusCallback !== undefined) n.status_callback = form.StatusCallback;
      return json(200, n);
    }
    if (rest === "/Calls.json" && method === "POST") {
      const to = form.To ?? "";
      if (!/^\+[1-9]\d{6,14}$/.test(to)) {
        return json(400, {
          code: 21211,
          message: `The 'To' number ${to} is not a valid phone number.`,
        });
      }
      const from = [...numbers.values()].find(
        (n) => n.account_sid === account && n.phone_number === form.From,
      );
      if (!from)
        return json(400, { code: 21210, message: "The source phone number is not verified" });
      const call: FakeCall = {
        sid: `CA${hex32(next())}`,
        account_sid: account,
        from: form.From ?? "",
        to,
        url: form.Url ?? "",
        status_callback: form.StatusCallback ?? "",
        time_limit: form.TimeLimit ?? "",
        status: "queued",
        direction: "outbound-api",
      };
      calls.set(call.sid, call);
      return json(201, call);
    }
    if (release?.[1] && method === "DELETE") {
      const n = numbers.get(release[1]);
      if (!n || n.account_sid !== account) return json(404, { code: 20404, message: "not found" });
      numbers.delete(release[1]);
      return json(204);
    }
    if (rest === "/Messages.json" && method === "POST") {
      const to = form.To ?? "";
      if (!/^(whatsapp:)?\+[1-9]\d{6,14}$/.test(to)) {
        return json(400, {
          code: 21211,
          message: `The 'To' number ${to} is not a valid phone number.`,
        });
      }
      const msg = addMessage({
        account_sid: account,
        from: form.From ?? "",
        to,
        body: form.Body ?? "",
        status: "queued",
        direction: "outbound-api",
        ...(form.ContentSid ? { content_sid: form.ContentSid } : {}),
      });
      return json(201, msg);
    }
    if (rest === "/Messages.json" && method === "GET") {
      const list = [...messages.values()]
        .filter((x) => x.account_sid === account)
        .filter((x) => !query.To || x.to === query.To)
        .filter((x) => !query.From || x.from === query.From)
        .reverse()
        .slice(0, Number(query.PageSize ?? 50));
      return json(200, { messages: list, next_page_uri: null });
    }
    const one = rest.match(/^\/Messages\/((?:SM|MM)[0-9a-f]{32})\.json$/);
    if (one?.[1] && method === "GET") {
      const msg = messages.get(one[1]);
      return msg && msg.account_sid === account
        ? json(200, msg)
        : json(404, { code: 20404, message: "not found" });
    }
    return json(404, { code: 20404, message: "not found" });
  };

  return {
    fetch,
    requests,
    accounts,
    numbers,
    messages,
    calls,
    /** Requests that placed a call. */
    placed: () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/Calls.json")),
    /** Someone calls one of the account's numbers: the form Twilio posts to its VoiceUrl, signed. */
    async voiceIn(input: { account: string; from: string; to: string; url: string; sid?: string }) {
      const sid = input.sid ?? `CA${hex32(next())}`;
      calls.set(sid, {
        sid,
        account_sid: input.account,
        from: input.from,
        to: input.to,
        url: input.url,
        status_callback: "",
        time_limit: "",
        status: "ringing",
        direction: "inbound",
      });
      const params: Record<string, string> = {
        CallSid: sid,
        AccountSid: input.account,
        From: input.from,
        To: input.to,
        Caller: input.from,
        Called: input.to,
        CallStatus: "ringing",
        Direction: "inbound",
        ApiVersion: "2010-04-01",
      };
      const token = accounts.get(input.account)?.token ?? "";
      return { sid, params, signature: await twilioSignature(token, input.url, params) };
    },
    /** A call we placed was picked up: Twilio requests its Url (as given, query and all), signed. */
    async pickUp(sid: string) {
      const call = calls.get(sid);
      if (!call) throw new Error(`no call ${sid}`);
      call.status = "in-progress";
      const params: Record<string, string> = {
        CallSid: sid,
        AccountSid: call.account_sid,
        From: call.from,
        To: call.to,
        CallStatus: "in-progress",
        Direction: "outbound-api",
        ApiVersion: "2010-04-01",
      };
      const token = accounts.get(call.account_sid)?.token ?? "";
      return { url: call.url, params, signature: await twilioSignature(token, call.url, params) };
    },
    /** A call's final status, posted to `url`, signed. */
    async callStatus(input: { sid: string; status: string; durationSecs?: number; url: string }) {
      const call = calls.get(input.sid);
      if (!call) throw new Error(`no call ${input.sid}`);
      call.status = input.status;
      const params: Record<string, string> = {
        CallSid: call.sid,
        AccountSid: call.account_sid,
        From: call.from,
        To: call.to,
        CallStatus: input.status,
        Direction: call.direction,
        ApiVersion: "2010-04-01",
        ...(input.durationSecs === undefined ? {} : { CallDuration: String(input.durationSecs) }),
      };
      const token = accounts.get(call.account_sid)?.token ?? "";
      return { params, signature: await twilioSignature(token, input.url, params) };
    },
    /** A voicemail's recording callback, signed for `url`. */
    async recording(input: { callSid: string; durationSecs: number; url: string }) {
      const call = calls.get(input.callSid);
      if (!call) throw new Error(`no call ${input.callSid}`);
      const rsid = `RE${hex32(next())}`;
      const params: Record<string, string> = {
        AccountSid: call.account_sid,
        CallSid: call.sid,
        RecordingSid: rsid,
        RecordingUrl: `${TWILIO_API}/Accounts/${call.account_sid}/Recordings/${rsid}`,
        RecordingStatus: "completed",
        RecordingDuration: String(input.durationSecs),
        RecordingChannels: "1",
        RecordingSource: "RecordVerb",
      };
      const token = accounts.get(call.account_sid)?.token ?? "";
      return { sid: rsid, params, signature: await twilioSignature(token, input.url, params) };
    },
    /** Calls that sent a message. */
    sends: () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/Messages.json")),
    setBrand(sid: string, status: string) {
      brands.set(sid, status);
    },
    setCampaign(serviceSid: string, status: string) {
      campaigns.set(serviceSid, status);
    },
    /**
     * A message from `from` to one of the account's numbers, as Twilio would POST it to the
     * number's SmsUrl: the form fields and their X-Twilio-Signature for `url`.
     */
    async inbound(input: {
      account: string;
      from: string;
      to: string;
      body: string;
      url: string;
      channel?: "sms" | "whatsapp";
      sid?: string;
    }) {
      const prefix = input.channel === "whatsapp" ? "whatsapp:" : "";
      const msg = addMessage({
        ...(input.sid ? { sid: input.sid } : {}),
        account_sid: input.account,
        from: `${prefix}${input.from}`,
        to: `${prefix}${input.to}`,
        body: input.body,
        status: "received",
        direction: "inbound",
      });
      const params: Record<string, string> = {
        MessageSid: msg.sid,
        SmsMessageSid: msg.sid,
        AccountSid: input.account,
        From: msg.from,
        To: msg.to,
        Body: input.body,
        NumMedia: "0",
        ApiVersion: "2010-04-01",
      };
      const token = accounts.get(input.account)?.token ?? "";
      return { params, signature: await twilioSignature(token, input.url, params), sid: msg.sid };
    },
    /** A status callback for a message we sent, signed for `url`. */
    async status(input: { sid: string; status: string; url: string; errorCode?: string }) {
      const msg = messages.get(input.sid);
      if (!msg) throw new Error(`no message ${input.sid}`);
      msg.status = input.status;
      const params: Record<string, string> = {
        MessageSid: msg.sid,
        SmsSid: msg.sid,
        AccountSid: msg.account_sid,
        From: msg.from,
        To: msg.to,
        MessageStatus: input.status,
        SmsStatus: input.status,
        ApiVersion: "2010-04-01",
        ...(input.errorCode ? { ErrorCode: input.errorCode } : {}),
      };
      const token = accounts.get(msg.account_sid)?.token ?? "";
      return { params, signature: await twilioSignature(token, input.url, params) };
    },
  };
}
export type FakeTwilio = ReturnType<typeof fakeTwilio>;
