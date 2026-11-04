import { ConnectorManifest } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "../registry";
import { parseCsv } from "./csv";
import {
  addressLabel,
  documentMimeType,
  forwardingAddress,
  newForwardingSecret,
  normalizeSender,
  parseForwardingAddress,
  sameAddress,
  senderAllowed,
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
