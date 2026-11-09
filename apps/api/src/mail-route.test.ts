// Mail for the agent domain goes on to the code service; everything else is forwarding
// (docs/operations.md, "Email Routing": one catch-all per zone).

import { describe, expect, it, vi } from "vitest";
import type { InboundEmail } from "./email";
import type { Bindings } from "./env";
import { AGENT_EMAIL_MAX_BYTES, isAgentMail, routeEmail } from "./mail-route";

const mail = (to: string, body = "Your code is 482913.", size?: number): InboundEmail => {
  const bytes = new TextEncoder().encode(`To: ${to}\r\n\r\n${body}`);
  return {
    from: "no-reply@acme.example",
    to,
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: size ?? bytes.length,
  };
};

const envWith = (codes?: Partial<NonNullable<Bindings["CODES"]>>) =>
  ({ AGENT_EMAIL_DOMAIN: "Agents.Mezonas.com", CODES: codes }) as unknown as Bindings;

describe("routeEmail", () => {
  it("knows the agent domain by the recipient's domain only, in any case", () => {
    const env = envWith();
    expect(isAgentMail("agent-abcdefghjkmn@agents.mezonas.com", env)).toBe(true);
    expect(isAgentMail("AGENT-x@AGENTS.MEZONAS.COM", env)).toBe(true);
    expect(isAgentMail("shop-01j-x@in.mezonas.com", env)).toBe(false);
    expect(isAgentMail("agents.mezonas.com@in.mezonas.com", env)).toBe(false);
    expect(isAgentMail("a@x.agents.mezonas.com", env)).toBe(false);
    expect(isAgentMail("a@agents.mezonas.com", {} as Pick<Bindings, "AGENT_EMAIL_DOMAIN">)).toBe(
      false,
    );
  });

  it("hands agent mail to the code service with its bytes, and never forwards it", async () => {
    const receiveEmail = vi.fn(async () => ({ outcome: "matched" }));
    const forward = vi.fn(async () => {});
    const r = await routeEmail(
      mail("agent-abcdefghjkmn@agents.mezonas.com"),
      envWith({ receiveEmail }),
      forward,
    );
    expect(r).toEqual({ to: "codes", outcome: "matched" });
    expect(forward).not.toHaveBeenCalled();
    const call = receiveEmail.mock.calls[0] as unknown as [{ to: string; raw: Uint8Array }];
    expect(call[0].to).toBe("agent-abcdefghjkmn@agents.mezonas.com");
    expect(new TextDecoder().decode(call[0].raw)).toContain("Your code is 482913.");
  });

  it("forwards everything else", async () => {
    const receiveEmail = vi.fn(async () => ({ outcome: "matched" }));
    const forward = vi.fn(async () => {});
    const m = mail("shop-01j-x@in.mezonas.com");
    expect(await routeEmail(m, envWith({ receiveEmail }), forward)).toEqual({
      to: "forwarding",
      outcome: "handled",
    });
    expect(forward).toHaveBeenCalledWith(m);
    expect(receiveEmail).not.toHaveBeenCalled();
  });

  it("drops agent mail when the code service isn't bound, or when it is too large", async () => {
    const forward = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await routeEmail(mail("a@agents.mezonas.com"), envWith(), forward)).toEqual({
        to: "codes",
        outcome: "not_configured",
      });
      const receiveEmail = vi.fn(async () => ({ outcome: "matched" }));
      expect(
        await routeEmail(
          mail("a@agents.mezonas.com", "x", AGENT_EMAIL_MAX_BYTES + 1),
          envWith({ receiveEmail }),
          forward,
        ),
      ).toEqual({ to: "codes", outcome: "too_large" });
      expect(receiveEmail).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
      // Logged without content.
      expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toContain("482913");
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
