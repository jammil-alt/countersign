import { describe, expect, it } from "vitest";
import {
  isMadeUpAddress,
  isMadeUpEmail,
  isMadeUpPhone,
  readSandboxDelivery,
  readTestPeople,
  redirectedSubject,
  redirectedText,
  sandboxRedirect,
  testPersonAddress,
  testPersonSubject,
  testPersonText,
} from "./made-up";

describe("the test person (owner, 2026-11-27)", () => {
  const people = { by: "u-1", email: "me@realmail.co", phone: "+15125551234" };

  it("is read from a run's trigger, or not at all", () => {
    expect(readTestPeople({ type: "manual", testPeople: people })).toEqual(people);
    expect(readTestPeople({ type: "manual" })).toBeNull();
    expect(readTestPeople({ testPeople: { by: "", email: null, phone: null } })).toBeNull();
    expect(readTestPeople({ testPeople: { ...people, phone: "not a phone" } })).toBeNull();
  });

  it("is reached at the operator's own address, unless the Sandbox's setting says where", () => {
    expect(testPersonAddress({}, people, "email")).toBe("me@realmail.co");
    expect(testPersonAddress({}, people, "sms")).toBe("+15125551234");
    expect(testPersonAddress({}, { email: null, phone: null }, "whatsapp")).toBeNull();
    const settings = { sandboxDelivery: { email: "Desk@RealMail.co", phone: null } };
    expect(testPersonAddress(settings, people, "email")).toBe("desk@realmail.co");
    expect(testPersonAddress(settings, people, "sms")).toBe("+15125551234");
  });

  it("marks what it gets as the test's, for whom", () => {
    expect(testPersonSubject("Friday's delivery", "Dana Whitfield")).toBe(
      "[Test · For Dana Whitfield] Friday's delivery",
    );
    expect(testPersonText("Can you confirm?", "Dana Whitfield")).toBe(
      "Test · For Dana Whitfield: Can you confirm?",
    );
  });
});

describe("made-up addresses", () => {
  it("knows reserved email domains", () => {
    for (const a of [
      "dana@ridgeline.example.com",
      "gail@example.com",
      "x@EXAMPLE.ORG",
      "x@sub.example.net",
      "x@shop.example",
      "x@vendor.test",
      "x@nowhere.invalid",
      "x@host.localhost",
      "x@example.com.",
    ]) {
      expect(isMadeUpEmail(a), a).toBe(true);
    }
    for (const a of [
      "dana@ridgeline.com",
      "x@example.co",
      "x@notexample.com",
      "x@example.com.au",
      "x@testing.io",
      "not an address",
      "x@",
    ]) {
      expect(isMadeUpEmail(a), a).toBe(false);
    }
  });

  it("knows the fictional 555-0100 to 0199 numbers", () => {
    for (const n of [
      "+15125550100",
      "+15125550199",
      "+1 (512) 555-0142",
      "512-555-0101",
      "whatsapp:+12125550150",
    ]) {
      expect(isMadeUpPhone(n), n).toBe(true);
    }
    for (const n of [
      "+15125550200",
      "+15125550099",
      "+15125551234",
      "+445125550100",
      "+11125550100",
      "+15125550100x",
      "",
    ]) {
      expect(isMadeUpPhone(n), n).toBe(false);
    }
  });

  it("checks the address the channel uses", () => {
    expect(isMadeUpAddress("email", "a@b.example.com")).toBe(true);
    expect(isMadeUpAddress("sms", "+15125550100")).toBe(true);
    expect(isMadeUpAddress("whatsapp", "+15125550100")).toBe(true);
    expect(isMadeUpAddress("voice", "+15125559876")).toBe(false);
    expect(isMadeUpAddress("email", "+15125550100")).toBe(false);
  });
});

describe("the Sandbox's delivery", () => {
  const settings = { sandboxDelivery: { email: "Me@Real.co", phone: "+15125551234" } };
  const dana = { name: "Dana Whitfield", sandbox: true };

  it("reads the setting, leaving anything not valid unset", () => {
    expect(readSandboxDelivery(settings)).toEqual({ email: "me@real.co", phone: "+15125551234" });
    expect(readSandboxDelivery({})).toEqual({ email: null, phone: null });
    expect(readSandboxDelivery(null)).toEqual({ email: null, phone: null });
    expect(
      readSandboxDelivery({ sandboxDelivery: { email: "nope", phone: "5125551234" } }),
    ).toEqual({ email: null, phone: null });
  });

  it("redirects a made-up person in the Sandbox only", () => {
    expect(
      sandboxRedirect({ ...dana, settings, channel: "email", address: "dana@r.example.com" }),
    ).toEqual({ kind: "redirect", to: "me@real.co" });
    expect(sandboxRedirect({ ...dana, settings, channel: "sms", address: "+15125550102" })).toEqual(
      { kind: "redirect", to: "+15125551234" },
    );
    // A real person, or any client but the Sandbox: as addressed.
    expect(
      sandboxRedirect({ ...dana, settings, channel: "email", address: "dana@ridgeline.com" }),
    ).toEqual({ kind: "as_is" });
    expect(
      sandboxRedirect({
        ...dana,
        sandbox: false,
        settings,
        channel: "email",
        address: "dana@r.example.com",
      }),
    ).toEqual({ kind: "as_is" });
  });

  it("refuses in words when nothing is set", () => {
    expect(
      sandboxRedirect({ ...dana, settings: {}, channel: "email", address: "dana@r.example.com" }),
    ).toEqual({
      kind: "refused",
      reason:
        "Dana Whitfield's address is made up: set where the Sandbox's messages to made-up people go",
    });
    expect(
      sandboxRedirect({
        ...dana,
        settings: { sandboxDelivery: { email: "me@real.co" } },
        channel: "sms",
        address: "+15125550102",
      }),
    ).toMatchObject({ kind: "refused", reason: expect.stringMatching(/'s number is made up/) });
  });

  it("names the person it was for", () => {
    expect(redirectedSubject("Friday's delivery", "Dana Whitfield")).toBe(
      "[For Dana Whitfield] Friday's delivery",
    );
    expect(redirectedText("Can you confirm?", "Dana Whitfield")).toBe(
      "For Dana Whitfield: Can you confirm?",
    );
  });
});
