import { describe, expect, it } from "vitest";
import { classifyUnmatched, extractCode, matchableText, senderMatches } from "./match";

describe("senders", () => {
  it("matches texts by number, ignoring formatting", () => {
    expect(senderMatches("sms", "+1 (415) 555-0100", "+14155550100")).toBe(true);
    expect(senderMatches("sms", "22395", "22395")).toBe(true);
    expect(senderMatches("sms", "+14155550100", "+14155550101")).toBe(false);
    expect(senderMatches("sms", "+14155550100", null)).toBe(false);
  });

  it("matches email by address, or by domain and its subdomains for @domain", () => {
    expect(senderMatches("email", "no-reply@acme.example", "No-Reply@acme.example")).toBe(true);
    expect(senderMatches("email", "no-reply@acme.example", "other@acme.example")).toBe(false);
    expect(senderMatches("email", "@acme.example", "x@mail.acme.example")).toBe(true);
    expect(senderMatches("email", "@acme.example", "x@acme.example.evil")).toBe(false);
    expect(senderMatches("email", "@acme.example", "x@notacme.example")).toBe(false);
  });
});

describe("codes", () => {
  it("takes the first capture group, or the whole match", () => {
    expect(extractCode("code is (\\d{6})", "Your code is 482913.")).toBe("482913");
    expect(extractCode("\\d{6}", "Your code is 482913.")).toBe("482913");
    expect(extractCode("code is (\\d{6})", "Welcome aboard")).toBeNull();
    expect(extractCode("(.*)", "x".repeat(40))).toBeNull();
    expect(extractCode("(", "x")).toBeNull();
  });

  it("never takes a code from a link", () => {
    const text = matchableText(["Sign in", "https://acme.example/login?token=482913 now"]);
    expect(extractCode("(\\d{6})", text)).toBeNull();
  });
});

describe("unmatched messages", () => {
  it("names resets, codes and anything else", () => {
    expect(classifyUnmatched("Reset your password\nClick the link")).toBe("reset_attempt");
    expect(classifyUnmatched("Someone asked for a password reset")).toBe("reset_attempt");
    expect(classifyUnmatched("Your verification code is 1234")).toBe("unsolicited_code");
    expect(classifyUnmatched("482913 is your Acme code")).toBe("unsolicited_code");
    expect(classifyUnmatched("Welcome to the Acme newsletter")).toBe("unexpected_message");
  });
});
