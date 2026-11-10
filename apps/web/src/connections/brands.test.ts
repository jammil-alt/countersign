import { describe, expect, it } from "vitest";
import { connectorBrand } from "./brands";

// Every connector in packages/connectors (its *_CONNECTOR_ID) has a mark; testkit included.
const CONNECTORS = [
  "qbo",
  "gmail",
  "gdrive",
  "gsheets",
  "gchat",
  "gsc",
  "gsc_oauth",
  "hubspot",
  "zoho_crm",
  "whatsapp_meta",
  "hackernews",
  "elevenlabs",
  "stripe",
  "slack",
  "linkedin",
  "outlook",
  "bing_webmaster",
  "ramp",
  "podio",
  "bankfeed",
  "upload",
  "resend",
  "twilio",
  "webhook",
  "website",
  "browser",
  "testkit",
];

describe("connectorBrand", () => {
  it("gives every connector a mark", () => {
    for (const id of CONNECTORS) expect(connectorBrand(id), id).not.toBeNull();
  });

  it("draws logos on the 24px grid and leaves unknown ids to the initials", () => {
    const qbo = connectorBrand("qbo");
    expect(qbo?.kind).toBe("logo");
    if (qbo?.kind === "logo") expect(qbo.path).toMatch(/^M/);
    // Zoho's logo is a wordmark, unreadable on a tile: its letter instead.
    expect(connectorBrand("zoho_crm")).toEqual({ kind: "monogram", fill: "#E42527", letters: "Z" });
    expect(connectorBrand("bankfeed")).toEqual({ kind: "icon", icon: "bank" });
    expect(connectorBrand("nope")).toBeNull();
    expect(connectorBrand(undefined)).toBeNull();
  });
});
