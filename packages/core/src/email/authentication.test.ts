import { describe, expect, it } from "vitest";
import {
  authenticatedSenders,
  emailAutomation,
  envelopeAuthenticated,
  fromAuthenticated,
  readAuthentication,
} from "./authentication";

const h = (key: string, value: string) => ({ key, value });
const PASS =
  "mx.cloudflare.net; dkim=pass header.d=acme.example header.s=s1; spf=pass (mx.cloudflare.net: domain of bounce@acme.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@acme.example; dmarc=pass (p=reject) header.from=acme.example";

describe("readAuthentication", () => {
  it("reads Cloudflare's topmost header: SPF, DKIM, DMARC and their domains", () => {
    const auth = readAuthentication([h("authentication-results", PASS), h("subject", "x")]);
    expect(auth).toEqual({
      header: "authentication-results",
      spf: true,
      dkim: true,
      dmarc: true,
      dmarcFrom: "acme.example",
      spfDomain: "acme.example",
    });
    expect(fromAuthenticated("ap@acme.example", auth)).toBe(true);
    expect(fromAuthenticated("ap@evil.example", auth)).toBe(false);
    expect(envelopeAuthenticated("bounce@acme.example", auth)).toBe(true);
    expect(envelopeAuthenticated("bounce@evil.example", auth)).toBe(false);
  });

  it("reads Cloudflare's ARC-Authentication-Results when it is on top", () => {
    const auth = readAuthentication([h("arc-authentication-results", `i=2; ${PASS}`)]);
    expect(auth.dmarcFrom).toBe("acme.example");
    expect(auth.header).toBe("arc-authentication-results");
  });

  it("ignores a header lower down, whatever it says", () => {
    const auth = readAuthentication([
      h("authentication-results", PASS.replace("dmarc=pass", "dmarc=fail")),
      h("authentication-results", PASS),
    ]);
    expect(auth.dmarc).toBe(false);
    expect(auth.dmarcFrom).toBeNull();
  });

  it("reads nothing from a topmost header with another authserv-id", () => {
    const auth = readAuthentication([
      h("authentication-results", PASS.replace("mx.cloudflare.net;", "mx.other.example;")),
      h("authentication-results", PASS),
    ]);
    expect(auth).toMatchObject({ spf: false, dkim: false, dmarc: false, dmarcFrom: null });
  });

  it("reads an ARC-only message by its topmost ARC header, held to the same authserv-id", () => {
    expect(
      readAuthentication([h("arc-authentication-results", `i=1; mx.other.example; ${PASS}`)]).dmarc,
    ).toBe(false);
    expect(
      readAuthentication([h("arc-authentication-results", PASS)]).dmarc, // no instance
    ).toBe(false);
    expect(readAuthentication([h("arc-authentication-results", `i=1; ${PASS}`)]).dmarc).toBe(true);
  });

  it("drops comments, nested ones too, before reading", () => {
    const auth = readAuthentication([
      h(
        "authentication-results",
        "mx.cloudflare.net; spf=none (a (b); dmarc=pass header.from=evil.example) smtp.mailfrom=x@evil.example",
      ),
    ]);
    expect(auth.dmarc).toBe(false);
    expect(auth.spf).toBe(false);
  });

  it("keeps a quoted local part whole, even with `;` and dmarc=pass in it", () => {
    const value =
      'mx.cloudflare.net; spf=pass smtp.mailfrom="a;dmarc=pass header.from=evil.example"@sender.example; dmarc=fail header.from=sender.example';
    const auth = readAuthentication([h("authentication-results", value)]);
    expect(auth.dmarc).toBe(false);
    expect(auth.dmarcFrom).toBeNull();
    expect(auth.spfDomain).toBe("sender.example");
  });

  it("reads no header with an open quote or comment", () => {
    for (const bad of [
      'mx.cloudflare.net; spf=pass smtp.mailfrom="x@a.example; dmarc=pass header.from=a.example',
      "mx.cloudflare.net; spf=pass (open; dmarc=pass header.from=a.example",
    ]) {
      expect(readAuthentication([h("authentication-results", bad)]).dmarc).toBe(false);
    }
  });

  it("takes SPF's domain from smtp.mailfrom, a bare domain or an address", () => {
    const bare = readAuthentication([
      h("authentication-results", "mx.cloudflare.net; spf = pass smtp.mailfrom = Shop.Example"),
    ]);
    expect(bare.spfDomain).toBe("shop.example");
    const failed = readAuthentication([
      h("authentication-results", "mx.cloudflare.net; spf=softfail smtp.mailfrom=shop.example"),
    ]);
    expect(failed.spfDomain).toBeNull();
  });

  it("is nothing without a header", () => {
    expect(readAuthentication([]).header).toBeNull();
  });
});

describe("authenticatedSenders", () => {
  const auth = readAuthentication([h("authentication-results", PASS)]);

  it("counts the From header under DMARC and the envelope under SPF", () => {
    expect(
      authenticatedSenders({
        envelopeFrom: "Bounce@acme.example",
        from: "ap@acme.example",
        auth,
      }),
    ).toEqual(["ap@acme.example", "bounce@acme.example"]);
  });

  it("does not count an envelope sender whose domain SPF didn't check", () => {
    // smtp.mailfrom says acme.example; the envelope claims another domain.
    expect(
      authenticatedSenders({ envelopeFrom: "ap@shop.example", from: "ap@shop.example", auth }),
    ).toEqual([]);
  });

  it("counts nothing when the message is unauthenticated", () => {
    expect(
      authenticatedSenders({
        envelopeFrom: "ap@acme.example",
        from: "ap@acme.example",
        auth: readAuthentication([]),
      }),
    ).toEqual([]);
  });
});

describe("emailAutomation", () => {
  it("knows auto-replies and bounces", () => {
    for (const headers of [
      [h("auto-submitted", "auto-replied")],
      [h("auto-submitted", "Auto-Replied (vacation)")],
      [h("precedence", "auto_reply")],
      [h("x-autoreply", "yes")],
      [h("x-autorespond", "1")],
      [h("return-path", "<>")],
    ]) {
      expect(emailAutomation(headers, "a@x.example")).toBe("auto_reply");
    }
    expect(emailAutomation([], "")).toBe("auto_reply");
    expect(emailAutomation([], "<>")).toBe("auto_reply");
    // An auto-reply that also says bulk is still an auto-reply.
    expect(
      emailAutomation(
        [h("precedence", "bulk"), h("auto-submitted", "auto-replied")],
        "a@x.example",
      ),
    ).toBe("auto_reply");
  });

  it("knows mail a system wrote: ERPs, ticket systems, lists", () => {
    for (const headers of [
      [h("auto-submitted", "auto-generated")],
      [h("auto-submitted", "auto-notified")],
      [h("precedence", "bulk")],
      [h("precedence", "list")],
      [h("precedence", "junk")],
    ]) {
      expect(emailAutomation(headers, "a@x.example")).toBe("machine");
    }
  });

  it("takes a person's mail as a person's", () => {
    expect(emailAutomation([h("auto-submitted", "no")], "a@x.example")).toBeNull();
    expect(emailAutomation([h("precedence", "first-class")], "a@x.example")).toBeNull();
    expect(emailAutomation([h("x-autoreply", "no")], "a@x.example")).toBeNull();
    expect(emailAutomation([h("return-path", "<a@x.example>")], "a@x.example")).toBeNull();
    expect(emailAutomation([h("subject", "Re: quote")], "a@x.example")).toBeNull();
    expect(emailAutomation([], null)).toBeNull();
  });
});
