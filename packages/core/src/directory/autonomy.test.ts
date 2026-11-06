import { describe, expect, it } from "vitest";
import { decideToolCall } from "../permissions/decide";
import { planReachOut, type ReachContact } from "../reach/rules";
import type { ApprovalRequirement, PermissionLevel } from "../schemas/permissions";
import { ToolSpec } from "../schemas/tool";
import {
  autonomyFor,
  autonomyMessage,
  ContactAutonomy,
  clientAutonomyProblem,
  readAutonomy,
  recipientOf,
  strictestLevel,
} from "./autonomy";
import { rowFromQbo } from "./rows";

describe("contact autonomy", () => {
  it("takes the strictest level and reads stored values leniently", () => {
    expect(strictestLevel()).toBe("auto");
    expect(strictestLevel("auto", null, "approval")).toBe("approval");
    expect(strictestLevel("approval", "off", "auto")).toBe("off");
    expect(readAutonomy({ email: "off", sms: "bogus", voice: "approval", fax: "auto" })).toEqual({
      email: "off",
      voice: "approval",
    });
    expect(readAutonomy(null)).toEqual({});
    expect(autonomyFor({ email: "off" }, "sms")).toBeNull();
    expect(ContactAutonomy.safeParse({ fax: "off" }).success).toBe(false);
    expect(ContactAutonomy.safeParse({ email: "approval" }).success).toBe(true);
  });

  it("lets the client admin tighten only, and never set `auto`", () => {
    expect(clientAutonomyProblem({}, { email: "off", sms: "approval" })).toBeNull();
    expect(clientAutonomyProblem({ email: "approval" }, { email: "off" })).toBeNull();
    // Loosening: off → approval, approval → not set.
    expect(clientAutonomyProblem({ email: "off" }, { email: "approval" })).toMatch(/stricter/);
    expect(clientAutonomyProblem({ sms: "approval" }, {})).toMatch(/stricter/);
    // `auto` is the operator's alone, even on a channel not set.
    expect(clientAutonomyProblem({}, { voice: "auto" })).toMatch(/only Mezonas/);
    // Keeping the operator's `auto` as it is changes nothing.
    expect(clientAutonomyProblem({ voice: "auto" }, { voice: "auto", sms: "off" })).toBeNull();
  });

  it("finds a send's recipient through its spec", () => {
    const spec = { recipient: { path: "to", channel: "email" as const } };
    expect(recipientOf(spec, { to: " Pat@Shop.COM " })).toEqual({
      channel: "email",
      to: "pat@shop.com",
    });
    expect(
      recipientOf({ recipient: { path: "to", channel: "whatsapp" } }, { to: "whatsapp:+1555" }),
    ).toEqual({ channel: "whatsapp", to: "+1555" });
    expect(recipientOf({}, { to: "pat@shop.com" })).toBeNull();
    expect(recipientOf(spec, { to: 5 })).toBeNull();
    expect(
      ToolSpec.safeParse({
        id: "sms.send",
        description: "Text",
        input: {},
        output: {},
        sideEffect: "external",
        verb: "create",
        source: "twilio",
        connector: "twilio",
        recipient: { path: "to", channel: "sms" },
      }).success,
    ).toBe(true);
    expect(autonomyMessage("email", "off")).toBe("agents' emails to this person are turned off");
  });
});

describe("autonomy at the gate: the strictest of matrix, step, mode and the person wins", () => {
  const levels: (PermissionLevel | null)[] = [null, "auto", "approval", "off"];
  const steps: ApprovalRequirement[] = ["required", "not_required"];
  const matrices: PermissionLevel[] = ["auto", "approval", "off"];
  for (const person of levels) {
    for (const step of steps) {
      for (const create of matrices) {
        for (const mode of ["act", "suggest_only"] as const) {
          const expected =
            person === "off" || create === "off"
              ? "refused"
              : person !== "approval" &&
                  create === "auto" &&
                  step === "not_required" &&
                  mode === "act"
                ? "run"
                : "approval";
          it(`person ${person ?? "unset"}, step ${step}, matrix ${create}, mode ${mode} → ${expected}`, () => {
            expect(
              decideToolCall({
                sideEffect: "external",
                verb: "create",
                matrix: { create },
                stepApproval: step,
                agentMode: mode,
                ceilings: person ? [person] : undefined,
              }),
            ).toBe(expected);
          });
        }
      }
    }
  }

  it("never loosens: `auto` on the person leaves an approval matrix waiting", () => {
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix: { create: "approval" },
        stepApproval: "not_required",
        agentMode: "act",
        ceilings: ["auto"],
      }),
    ).toBe("approval");
  });
});

describe("autonomy in the reach-out evaluator", () => {
  const now = new Date("2026-11-06T15:00:00Z");
  const granted = { grantedAt: "2026-11-01T00:00:00Z", source: "web form" };
  const pat = (autonomy: ReachContact["autonomy"]): ReachContact => ({
    id: "c1",
    name: "Pat",
    email: "pat@shop.example",
    phone: "+15551230000",
    whatsapp: null,
    language: null,
    preferredChannels: ["email", "sms"],
    timezone: "UTC",
    quietHours: { start: "22:00", end: "07:00" },
    consent: { email: granted, sms: granted },
    optedOutAt: null,
    autonomy,
  });
  const plan = (autonomy: ReachContact["autonomy"]) =>
    planReachOut({
      contact: pat(autonomy),
      conditions: {},
      urgency: "normal",
      boundChannels: new Set(["email", "sms"]),
      client: {},
      facts: {},
      openForSubject: false,
      sentToday: 0,
      now,
    });

  it("takes a channel set to off out of the plan, and the text still goes", () => {
    const p = plan({ email: "off" });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.channels).toEqual(["sms"]);
    expect(p.checks).toContainEqual({ channel: "email", block: "autonomy_off" });
    expect(p.needsSignature).toBe(false);
  });

  it("is not_allowed when every channel is off for the person", () => {
    const p = plan({ email: "off", sms: "off" });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.outcome).toBe("not_allowed");
    expect(p.reason).toMatch(/email: turned off for this person/);
  });

  it("asks for a sign when a planned channel needs one, and not otherwise", () => {
    const p = plan({ sms: "approval" });
    expect(p.ok && p.needsSignature).toBe(true);
    const q = plan({});
    expect(q.ok && q.needsSignature).toBe(false);
  });
});

describe("QuickBooks vendors and customers as directory rows", () => {
  it("maps a vendor to an organization of kind vendor, keyed by its QuickBooks id", () => {
    const r = rowFromQbo(
      "Vendor",
      {
        Id: "56",
        DisplayName: "Northwest Plywood Supply",
        CompanyName: "Northwest Plywood Supply, Inc.",
        PrimaryEmailAddr: { Address: "AR@nwplywood.example" },
        PrimaryPhone: { FreeFormNumber: "(503) 555-0100" },
        BillAddr: { Line1: "1 Mill Rd", City: "Portland", CountrySubDivisionCode: "OR" },
      },
      1,
    );
    expect(r.problems).toEqual([]);
    expect(r.data).toMatchObject({
      name: "Northwest Plywood Supply",
      kinds: ["vendor"],
      email: "ar@nwplywood.example",
      externalId: "56",
      address: { line1: "1 Mill Rd", city: "Portland", region: "OR" },
    });
    const c = rowFromQbo("Customer", { Id: "7", DisplayName: "Cedar Homes" }, 2);
    expect(c.data?.kinds).toEqual(["customer"]);
    expect(rowFromQbo("Vendor", { Id: "8" }, 3).data).toBeNull();
  });
});
