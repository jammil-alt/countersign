import { describe, expect, it } from "vitest";
import { AgentDefinition } from "../schemas/agent";
import { EmailIntake, emailIntakeAdmits, emailIntakeWords } from "./intake";

describe("email intake", () => {
  it("leaves the People filters to decide by default", () => {
    expect(emailIntakeAdmits(undefined, ["a@b.com"])).toBeNull();
    expect(emailIntakeAdmits({ mode: "people" }, ["a@b.com"])).toBeNull();
  });

  it("takes only proven mail from the domain or its subdomains", () => {
    const only = EmailIntake.parse({ mode: "domain", domain: " Client.COM " });
    expect(only).toEqual({ mode: "domain", domain: "client.com" });
    expect(emailIntakeAdmits(only, ["ap@client.com"])).toBe(true);
    expect(emailIntakeAdmits(only, ["ap@mail.client.com"])).toBe(true);
    // A lookalike, a domain that merely ends the same, and nothing proven.
    expect(emailIntakeAdmits(only, ["ap@client.com.evil.io"])).toBe(false);
    expect(emailIntakeAdmits(only, ["ap@notclient.com"])).toBe(false);
    expect(emailIntakeAdmits(only, [])).toBe(false);
    expect(EmailIntake.safeParse({ mode: "domain", domain: "not a domain" }).success).toBe(false);
  });

  it("takes only proven mail from a listed address or domain", () => {
    const list = EmailIntake.parse({
      mode: "list",
      senders: ["AP@Vendor.com", "supplier.example"],
    });
    expect(emailIntakeAdmits(list, ["ap@vendor.com"])).toBe(true);
    expect(emailIntakeAdmits(list, ["billing@vendor.com"])).toBe(false);
    expect(emailIntakeAdmits(list, ["x@supplier.example"])).toBe(true);
    expect(EmailIntake.safeParse({ mode: "list", senders: [] }).success).toBe(false);
    expect(EmailIntake.safeParse({ mode: "list", senders: ["nope"] }).success).toBe(false);
  });

  it("takes anyone when open, proven or not", () => {
    expect(emailIntakeAdmits({ mode: "open" }, [])).toBe(true);
    expect(emailIntakeWords({ mode: "open" })).toBe("From anyone");
  });

  it("is optional on the agent, so stored definitions parse as they were", () => {
    const base = {
      schemaVersion: 2,
      identity: { name: "Ivy", role: "reviews invoices", mission: "check prices" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Review.",
      skills: [],
    };
    expect(AgentDefinition.parse(base).emailIntake).toBeUndefined();
    expect(
      AgentDefinition.parse({ ...base, emailIntake: { mode: "domain", domain: "client.com" } })
        .emailIntake,
    ).toEqual({ mode: "domain", domain: "client.com" });
  });
});
