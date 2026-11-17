import { describe, expect, it } from "vitest";
import {
  isSloanAddress,
  SLOAN_TEXT_MAX,
  sloanAddress,
  sloanReplySubject,
  sloanTextBody,
} from "./reach";

const TENANT = "0b9d2f3e-1c4a-4b7e-9f00-123456789abc";

describe("Sloan by email and text (§1.124)", () => {
  it("names the client's Sloan on the forwarding domain, and knows its own shape", () => {
    const a = sloanAddress({
      clientName: "Ana's Millwork",
      tenantId: TENANT,
      domain: "in.mezonas.com",
    });
    expect(a).toMatch(/^sloan\.anas-millwork-[a-z2-7]{26}@in\.mezonas\.com$/);
    expect(isSloanAddress(a, "in.mezonas.com")).toBe(true);
    expect(isSloanAddress(a.replace("sloan.", "remy."), "in.mezonas.com")).toBe(false);
    expect(isSloanAddress(a, "in.other.com")).toBe(false);
  });

  it("keeps a short answer whole and cuts a long one at a word, with the link", () => {
    expect(sloanTextBody("  Paid on Friday.  ", "https://x/s/1", "en")).toBe("Paid on Friday.");
    const long = "word ".repeat(400);
    const body = sloanTextBody(long, "https://app.mezonas.com/sloan/abc", "es");
    expect(body.length).toBeLessThanOrEqual(SLOAN_TEXT_MAX);
    expect(body).toMatch(
      /word… El resto está en Mezonas: https:\/\/app\.mezonas\.com\/sloan\/abc$/,
    );
  });

  it("answers under the person's subject", () => {
    expect(sloanReplySubject("Invoices")).toBe("Re: Invoices");
    expect(sloanReplySubject("RE: Invoices")).toBe("RE: Invoices");
    expect(sloanReplySubject("a\r\nBcc: x")).toBe("Re: a Bcc: x");
    expect(sloanReplySubject(null)).toBe("Your message to Sloan");
  });
});
