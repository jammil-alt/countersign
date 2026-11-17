import { ConnectorManifest } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "../registry";
import { parseCsv } from "./csv";
import {
  addressLabel,
  dmarcPassDomain,
  documentMimeType,
  forwardingAddress,
  newForwardingSecret,
  newReplyTag,
  normalizeSender,
  parseForwardingAddress,
  parseReplyAddress,
  reachReplyTo,
  replyBaseFor,
  replyTagReachOutId,
  sameAddress,
  senderAllowed,
  trustedFromHeader,
} from "./forwarding";
import { createUploadConnector } from "./manifest";

const TENANT = "0192f7a0-1234-7abc-8def-0123456789ab";

describe("upload connector", () => {
  it("has a valid manifest and registers", () => {
    const c = createUploadConnector();
    expect(ConnectorManifest.safeParse(c.manifest).success).toBe(true);
    expect(c.manifest.auth).toBe("none");
    expect(new ConnectorRegistry([c]).has("upload")).toBe(true);
  });
});

describe("parseCsv", () => {
  it("reads quotes, doubled quotes, commas, CRLF and a BOM, and drops blank lines", () => {
    const text =
      '﻿Date,Vendor,Amount,Memo\r\n11/02/2026,"Acme, Inc.",$1250.00,"said ""rush"""\r\n\r\n2026-11-03,B,2,\n';
    expect(parseCsv(text)).toEqual([
      ["Date", "Vendor", "Amount", "Memo"],
      ["11/02/2026", "Acme, Inc.", "$1250.00", 'said "rush"'],
      ["2026-11-03", "B", "2", ""],
    ]);
  });

  it("refuses an unclosed quote", () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/never closed/);
  });
});

describe("forwarding addresses", () => {
  it("round-trips the client id and secret, case-insensitively", () => {
    const secret = newForwardingSecret();
    const a = forwardingAddress({
      tenantId: TENANT,
      clientName: "Hollis Millwork Co.",
      secret,
      domain: "In.Mezonas.com",
    });
    expect(a).toMatch(/^hollis-millwork-[a-z2-7]{26}-[a-z2-7]{8}@in\.mezonas\.com$/);
    expect(a.split("@")[0]?.length).toBeLessThanOrEqual(64);
    expect(parseForwardingAddress(a.toUpperCase(), "in.mezonas.com")).toEqual({
      tenantId: TENANT,
      secret,
    });
    expect(parseForwardingAddress(a, "other.example")).toBeNull();
    expect(parseForwardingAddress("someone@in.mezonas.com", "in.mezonas.com")).toBeNull();
    expect(sameAddress(a, a.toUpperCase())).toBe(true);
    expect(sameAddress(a, a.replace(secret, "aaaaaaaa"))).toBe(false);
  });

  it("makes a short readable label from any client name", () => {
    expect(addressLabel("Café Böhm & Söhne Cabinetry")).toBe("cafe-bohm-sohne");
    expect(addressLabel("!!!")).toBe("client");
  });
});

describe("allowed senders", () => {
  it("matches an exact address, or a domain and its subdomains", () => {
    const list = ["ap@shop.example", "keystone.example"];
    expect(senderAllowed(list, ["AP@Shop.example"])).toBe(true);
    expect(senderAllowed(list, ["other@shop.example"])).toBe(false);
    expect(senderAllowed(list, ["billing@keystone.example"])).toBe(true);
    expect(senderAllowed(list, ["bounce@mail.keystone.example"])).toBe(true);
    expect(senderAllowed(list, ["x@notkeystone.example"])).toBe(false);
    expect(senderAllowed(list, ["x@unknown.example", "billing@keystone.example"])).toBe(true);
    expect(senderAllowed([], ["ap@shop.example"])).toBe(false);
  });

  it("cleans entries and refuses junk", () => {
    expect(normalizeSender(" @Shop.Example ")).toBe("shop.example");
    expect(normalizeSender("AP@shop.example")).toBe("ap@shop.example");
    expect(normalizeSender("not a sender")).toBeNull();
  });
});

describe("documentMimeType", () => {
  it("trusts a document type, else the extension", () => {
    expect(documentMimeType("application/octet-stream", "Invoice.PDF")).toBe("application/pdf");
    expect(documentMimeType("image/png; name=x", "x")).toBe("image/png");
    expect(documentMimeType("application/zip", "x.zip")).toBe("application/zip");
  });
});

describe("DMARC on the From header", () => {
  it("reads the From domain that passed from the receiving server's Authentication-Results", () => {
    const top = (value: string) => [{ key: "authentication-results", value }];
    expect(
      dmarcPassDomain(
        top(
          "mx.cloudflare.net; dkim=pass header.d=keystone.example; spf=pass smtp.mailfrom=x@y.example; dmarc=pass (p=reject) header.from=Keystone.example",
        ),
      ),
    ).toBe("keystone.example");
    expect(
      dmarcPassDomain(top("mx.cloudflare.net; dmarc=fail header.from=keystone.example")),
    ).toBeNull();
    expect(
      dmarcPassDomain(top("mx.cloudflare.net; dmarc=none header.from=keystone.example")),
    ).toBeNull();
    expect(
      dmarcPassDomain(top("mx.cloudflare.net; spf=pass (dmarc=pass header.from=x.example)")),
    ).toBeNull();
    // Another server's header on top, a forged one lower down, a quoted `;`: none passes.
    expect(
      dmarcPassDomain(top("mx.other.example; dmarc=pass header.from=keystone.example")),
    ).toBeNull();
    expect(
      dmarcPassDomain([
        {
          key: "arc-authentication-results",
          value: "i=1; mx.cloudflare.net; dmarc=fail header.from=keystone.example",
        },
        ...top("mx.cloudflare.net; dmarc=pass header.from=keystone.example"),
      ]),
    ).toBeNull();
    expect(
      dmarcPassDomain(
        top(
          'mx.cloudflare.net; spf=pass smtp.mailfrom="a;dmarc=pass header.from=keystone.example"@x.example',
        ),
      ),
    ).toBeNull();
    expect(dmarcPassDomain([])).toBeNull();
  });

  it("trusts a From address only on the exact domain that passed", () => {
    expect(trustedFromHeader("billing@keystone.example", "keystone.example")).toBe(true);
    expect(trustedFromHeader("billing@keystone.example", "evil.example")).toBe(false);
    expect(trustedFromHeader("billing@mail.keystone.example", "keystone.example")).toBe(false);
    expect(trustedFromHeader("billing@keystone.example", null)).toBe(false);
    expect(trustedFromHeader(null, "keystone.example")).toBe(false);
  });
});

describe("reply addresses", () => {
  const REACH = "0192f7a0-5678-7abc-8def-0123456789ab";
  const forwarding = forwardingAddress({
    tenantId: TENANT,
    clientName: "Hollis Millwork",
    secret: "abcdefgh",
    domain: "in.mezonas.test",
  });

  it("tags replies with the reach-out and a secret of their own, never the forwarding secret", () => {
    const tag = newReplyTag(REACH);
    expect(tag).toMatch(/^[a-z2-7]{34}$/);
    expect(newReplyTag(REACH)).not.toBe(tag);
    expect(replyTagReachOutId(tag)).toBe(REACH);
    // An earlier tag: the id in hex.
    expect(replyTagReachOutId(REACH.replace(/-/g, ""))).toBe(REACH);
    expect(replyTagReachOutId("short")).toBeNull();

    const replyTo = reachReplyTo(forwarding, tag) as string;
    expect(replyTo).not.toContain("abcdefgh");
    expect(replyTo.split("@")[0]?.length).toBeLessThanOrEqual(64);
    expect(replyTo.startsWith(`${replyBaseFor(forwarding)?.split("@")[0]}+`)).toBe(true);
    expect(parseReplyAddress(replyTo, "in.mezonas.test")).toEqual({ tenantId: TENANT, tag });
    // The reply form is no forwarding address, and a forwarding address no reply address.
    expect(parseForwardingAddress(replyTo, "in.mezonas.test")).toBeNull();
    expect(parseReplyAddress(forwarding, "in.mezonas.test")).toBeNull();
    expect(parseReplyAddress(replyTo, "elsewhere.example")).toBeNull();
  });

  it("gives an untagged email no Reply-To, and reads a reply address without a tag as untagged", () => {
    expect(reachReplyTo(forwarding, undefined)).toBeNull();
    expect(reachReplyTo(null, "abcdef")).toBeNull();
    const base = replyBaseFor(forwarding) as string;
    expect(parseReplyAddress(base, "in.mezonas.test")).toEqual({ tenantId: TENANT, tag: null });
    expect(parseReplyAddress(base.replace("@", "+not-a-tag@"), "in.mezonas.test")?.tag).toBeNull();
  });
});
