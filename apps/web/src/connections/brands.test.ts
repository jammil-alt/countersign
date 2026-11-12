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
  "billcom",
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

  it("uses the owner's logo files, keeps paths for the rest and leaves unknown ids to the initials", () => {
    // The owner's logo files (2026-11-11, every third-party connector that has one, 2026-11-12).
    for (const id of [
      "qbo",
      "gmail",
      "gdrive",
      "gsheets",
      "gchat",
      "gsc",
      "gsc_oauth",
      "hubspot",
      "whatsapp_meta",
      "stripe",
      "slack",
      "outlook",
      "zoho_crm",
      "linkedin",
      "bing_webmaster",
      "ramp",
      "billcom",
      "podio",
    ]) {
      expect(connectorBrand(id)?.kind, id).toBe("image");
    }
    // No file yet: the one-colour path on the 24px grid.
    const hn = connectorBrand("hackernews");
    expect(hn?.kind).toBe("logo");
    if (hn?.kind === "logo") expect(hn.path).toMatch(/^M/);
    expect(connectorBrand("bankfeed")).toEqual({ kind: "icon", icon: "bank" });
    expect(connectorBrand("nope")).toBeNull();
    expect(connectorBrand(undefined)).toBeNull();
  });
});
