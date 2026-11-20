// An agent's own phone line (docs/plan.md §1.160): which of a client's numbers an agent, or the
// account, texts and calls from.
import { describe, expect, it } from "vitest";
import { numberFor, numberOwner } from "./messaging";

const n = (phoneNumber: string, over: Record<string, unknown> = {}) => ({
  phoneNumber,
  capabilities: { sms: true, voice: true },
  whatsapp: false,
  ...over,
});

describe("numberFor", () => {
  const account = n("+15550000001");
  const ordersLine = n("+15550000002", { agentId: "agent-orders" });
  const numbers = [ordersLine, account];

  it("gives an agent its own line, and the account the first number nobody owns", () => {
    expect(numberFor(numbers, "sms", "agent-orders")?.phoneNumber).toBe("+15550000002");
    expect(numberFor(numbers, "voice", "agent-orders")?.phoneNumber).toBe("+15550000002");
    expect(numberFor(numbers, "sms")?.phoneNumber).toBe("+15550000001");
    expect(numberFor(numbers, "sms", null)?.phoneNumber).toBe("+15550000001");
  });

  it("never lets an agent's line speak for another agent", () => {
    expect(numberFor(numbers, "sms", "agent-invoices")?.phoneNumber).toBe("+15550000001");
    expect(numberFor([ordersLine], "sms")).toBeNull();
    expect(numberFor([ordersLine], "sms", "agent-invoices")).toBeNull();
  });

  it("falls back to the account's number for what the agent's line can't carry", () => {
    const sender = n("+15550000003", { whatsapp: true });
    expect(numberFor([ordersLine, sender], "whatsapp", "agent-orders")?.phoneNumber).toBe(
      "+15550000003",
    );
  });

  it("names a number's owner", () => {
    expect(numberOwner(numbers, "+15550000002")).toBe("agent-orders");
    expect(numberOwner(numbers, "+15550000001")).toBeNull();
    expect(numberOwner(numbers, "+15559999999")).toBeNull();
  });
});
