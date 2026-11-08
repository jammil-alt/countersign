// A fake Resend for tests (re-exported by @countersign/connectors/testing; never imported by the
// Worker): domains with DNS records, verification, sending-only keys per domain, and emails sent
// once per Idempotency-Key. Shaped like Resend's answers as far as we know them (NOTES.md).

import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { RESEND_API } from "./index";

export const FAKE_RESEND_MAIN = { apiKey: "re_main_0000000000000000" };

export interface FakeResendEmail {
  id: string;
  apiKey: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  reply_to?: string;
  headers?: Record<string, string>;
  idempotencyKey: string | null;
  // P-3
  attachments?: { filename: string; content: string; content_type?: string }[];
}

interface FakeDomain {
  id: string;
  name: string;
  status: string;
  records: Record<string, unknown>[];
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}

export interface FakeResend {
  fetch: FetchLike;
  emails: FakeResendEmail[];
  domains: Map<string, FakeDomain>;
  /** key → the domain it may send from (null: any of ours). */
  keys: Map<string, string | null>;
  /** Marks a domain's records verified, as DNS would once the client adds them. */
  dnsAdded(domainId: string): void;
  /** The next this-many sends fail with a 500. */
  failSends: number;
}

export function fakeResend(): FakeResend {
  let n = 0;
  const emails: FakeResendEmail[] = [];
  const domains = new Map<string, FakeDomain>();
  const keys = new Map<string, string | null>([[FAKE_RESEND_MAIN.apiKey, null]]);
  const dnsReady = new Set<string>();
  const byIdempotency = new Map<string, string>();
  const fake: FakeResend = {
    emails,
    domains,
    keys,
    failSends: 0,
    dnsAdded(id) {
      dnsReady.add(id);
    },
    async fetch(url: string, init: HttpRequestInit = {}) {
      if (!url.startsWith(RESEND_API)) return respond(404, { message: "not resend" });
      const path = url.slice(RESEND_API.length);
      const method = init.method ?? "GET";
      const auth = init.headers?.authorization ?? init.headers?.Authorization ?? "";
      const key = auth.replace(/^Bearer /, "");
      if (!keys.has(key)) return respond(401, { message: "API key is invalid" });
      const main = key === FAKE_RESEND_MAIN.apiKey;
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};

      if (method === "POST" && path === "/emails") {
        const from = String(body.from ?? "");
        const fromDomain = /@([^>\s]+)>?$/.exec(from)?.[1] ?? "";
        const allowed = keys.get(key);
        if (allowed && allowed !== fromDomain) {
          return respond(403, { message: `this key can't send from ${fromDomain}` });
        }
        const idem = init.headers?.["Idempotency-Key"] ?? null;
        if (idem && byIdempotency.has(idem)) return respond(200, { id: byIdempotency.get(idem) });
        if (fake.failSends > 0) {
          fake.failSends--;
          return respond(500, { message: "internal error" });
        }
        const id = `re-email-${++n}`;
        emails.push({
          id,
          apiKey: key,
          from,
          to: body.to as string[],
          subject: String(body.subject),
          text: String(body.text),
          ...(typeof body.reply_to === "string" ? { reply_to: body.reply_to } : {}),
          ...(body.headers ? { headers: body.headers as Record<string, string> } : {}),
          idempotencyKey: idem,
          ...(Array.isArray(body.attachments)
            ? { attachments: body.attachments as NonNullable<FakeResendEmail["attachments"]> }
            : {}),
        });
        if (idem) byIdempotency.set(idem, id);
        return respond(200, { id });
      }
      if (!main) return respond(403, { message: "a sending key can only send" });
      if (method === "POST" && path === "/domains") {
        const id = `dom-${++n}`;
        const name = String(body.name);
        const d: FakeDomain = {
          id,
          name,
          status: "not_started",
          records: [
            {
              record: "SPF",
              name: `send.${name}`,
              type: "MX",
              ttl: "Auto",
              status: "not_started",
              value: "feedback-smtp.us-east-1.amazonses.com",
              priority: 10,
            },
            {
              record: "DKIM",
              name: `resend._domainkey.${name}`,
              type: "TXT",
              ttl: "Auto",
              status: "not_started",
              value: "p=MIGfMA0fake",
            },
          ],
        };
        domains.set(id, d);
        return respond(200, { ...d, object: "domain" });
      }
      const verify = /^\/domains\/([^/]+)\/verify$/.exec(path);
      if (method === "POST" && verify) {
        const d = domains.get(verify[1] as string);
        if (!d) return respond(404, { message: "domain not found" });
        const ok = dnsReady.has(d.id);
        d.status = ok ? "verified" : "pending";
        d.records = d.records.map((r) => ({ ...r, status: ok ? "verified" : "pending" }));
        return respond(200, { object: "domain", id: d.id });
      }
      const get = /^\/domains\/([^/]+)$/.exec(path);
      if (method === "GET" && get) {
        const d = domains.get(get[1] as string);
        return d
          ? respond(200, { ...d, object: "domain" })
          : respond(404, { message: "not found" });
      }
      if (method === "POST" && path === "/api-keys") {
        const token = `re_send_${++n}_${"x".repeat(12)}`;
        const domainId = typeof body.domain_id === "string" ? body.domain_id : null;
        keys.set(token, domainId ? (domains.get(domainId)?.name ?? null) : null);
        return respond(201, { id: `key-${n}`, token });
      }
      return respond(404, { message: `no route ${method} ${path}` });
    },
  };
  return fake;
}
