import { describe, expect, it } from "vitest";
import { authenticated, identityFromAddress, parseInboundEmail, readAuthentication } from "./email";

const h = (key: string, value: string) => ({ key, value });
const PASS =
  "mx.cloudflare.net; dkim=pass header.d=acme.example header.s=s1; spf=pass smtp.mailfrom=bounce@acme.example; dmarc=pass (p=reject) header.from=acme.example";

describe("email authentication", () => {
  it("passes when Cloudflare's topmost header has SPF, DKIM and DMARC for the From domain", () => {
    const auth = readAuthentication([h("authentication-results", PASS), h("subject", "x")]);
    expect(auth).toMatchObject({ spf: true, dkim: true, dmarc: true, dmarcFrom: "acme.example" });
    expect(authenticated("no-reply@acme.example", auth)).toBe(true);
    expect(authenticated("no-reply@evil.example", auth)).toBe(false);
  });

  it("reads Cloudflare's ARC-Authentication-Results when it is on top", () => {
    const auth = readAuthentication([h("arc-authentication-results", `i=2; ${PASS}`)]);
    expect(authenticated("no-reply@acme.example", auth)).toBe(true);
  });

  it("fails when DMARC, DKIM or SPF did not pass", () => {
    for (const bad of [
      PASS.replace("dmarc=pass", "dmarc=fail"),
      PASS.replace("dkim=pass", "dkim=fail"),
      PASS.replace("spf=pass", "spf=softfail"),
      "mx.cloudflare.net; spf=pass; dkim=pass (dmarc=pass header.from=acme.example)",
    ]) {
      const auth = readAuthentication([h("authentication-results", bad)]);
      expect(authenticated("no-reply@acme.example", auth)).toBe(false);
    }
  });

  it("never reads a header the sender wrote below the receiving server's", () => {
    // The topmost header failed; a forged pass further down is ignored.
    const auth = readAuthentication([
      h("authentication-results", PASS.replace("dmarc=pass", "dmarc=fail")),
      h("authentication-results", PASS),
    ]);
    expect(authenticated("no-reply@acme.example", auth)).toBe(false);
    // A topmost header from another server is not Cloudflare's.
    const other = readAuthentication([
      h("authentication-results", PASS.replace("mx.cloudflare.net", "mx.evil.example")),
    ]);
    expect(authenticated("no-reply@acme.example", other)).toBe(false);
    expect(authenticated("no-reply@acme.example", readAuthentication([]))).toBe(false);
  });
});

describe("agent addresses", () => {
  it("finds the identity in agent-<id>@<domain> only", () => {
    expect(identityFromAddress("agent-abcdefgh2345@agents.example", "agents.example")).toBe(
      "abcdefgh2345",
    );
    expect(identityFromAddress("Agent-ABCDEFGH2345+x@Agents.Example", "agents.example")).toBe(
      "abcdefgh2345",
    );
    expect(identityFromAddress("agent-abcdefgh2345@other.example", "agents.example")).toBeNull();
    expect(identityFromAddress("someone@agents.example", "agents.example")).toBeNull();
    expect(identityFromAddress("agent-abc@agents.example", "agents.example")).toBeNull();
  });
});

describe("parsing", () => {
  it("reads From, subject, text and the authentication verdicts", async () => {
    const raw = [
      `Authentication-Results: ${PASS}`,
      "From: Acme <No-Reply@Acme.example>",
      "To: agent-abcdefgh2345@agents.example",
      "Subject: Your code",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your sign-in code is 482913.",
      "",
    ].join("\r\n");
    const m = await parseInboundEmail(new TextEncoder().encode(raw));
    expect(m.from).toBe("no-reply@acme.example");
    expect(m.authenticated).toBe(true);
    expect(m.subject).toBe("Your code");
    expect(m.text).toContain("482913");
  });
});
