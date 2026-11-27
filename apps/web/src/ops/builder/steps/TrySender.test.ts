import { describe, expect, it } from "vitest";
import { messageOn, senderChannel, takesPerson } from "./TrySender";
import type { Workflow } from "./types";

const wf = (on: unknown) =>
  ({
    schemaVersion: 5,
    triggers: [{ id: "t", on }],
    outputs: [],
    steps: [],
  }) as unknown as Workflow;

describe("messageOn", () => {
  it("reads a message trigger's channels a test message can come by, and whom it takes", () => {
    expect(
      messageOn(
        wf({
          type: "message",
          channels: ["command", "sms", "email"],
          from: { relationships: ["employee"] },
        }),
      ),
    ).toEqual({ channels: ["email", "sms"], from: { relationships: ["employee"] } });
    expect(messageOn(wf({ type: "manual" }))).toBeNull();
  });
});

describe("takesPerson", () => {
  const p = { id: "c1", relationship: "employee" as const, roles: ["Cardholder"] };
  it("takes a person by relationship, label or id, and nobody without a filter", () => {
    expect(takesPerson({ relationships: ["employee"] }, p)).toBe(true);
    expect(takesPerson({ tags: ["cardholder"] }, p)).toBe(true);
    expect(takesPerson({ contactIds: ["c1"] }, { ...p, relationship: null, roles: [] })).toBe(true);
    expect(takesPerson({ relationships: ["vendor"] }, p)).toBe(false);
    expect(takesPerson(null, p)).toBe(false);
  });
});

describe("senderChannel", () => {
  it("is their email where the trigger takes email, else a text, else WhatsApp", () => {
    const both = { email: "sam@x.example", phone: "+15550100000" };
    expect(senderChannel(both, ["email", "sms"])).toBe("email");
    expect(senderChannel(both, ["sms"])).toBe("sms");
    expect(senderChannel({ phone: "+15550100000" }, ["email", "sms"])).toBe("sms");
    expect(senderChannel({ phone: "+15550100000" }, ["email", "whatsapp"])).toBe("whatsapp");
    // Nothing the trigger takes: what they have, and the live run says why it's refused.
    expect(senderChannel({ phone: "+15550100000" }, ["email"])).toBe("sms");
  });
});
