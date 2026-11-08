// P-3: attachments both ways (docs/plan.md §1.65): which channels carry a reach-out's documents,
// the inputs' limits, and the reply's documents as a step output.
import { describe, expect, it } from "vitest";
import {
  CHANNEL_ATTACHMENTS_MAX,
  describeAttachments,
  isSendableType,
  OutboundAttachments,
} from "./attachments";
import {
  describeChecks,
  planReachOut,
  type ReachChannel,
  ReachOutInput,
  ReachOutOutput,
  ReachReply,
} from "./reach/rules";

const GRANTED = { grantedAt: "2026-11-01T00:00:00.000Z", source: "signed form" };
const DAY = new Date("2026-11-04T15:00:00.000Z");
const DOC = "0192f7a0-0000-7000-8000-00000000d001";
const DOC2 = "0192f7a0-0000-7000-8000-00000000d002";

function plan(attachments: number, preferred: ReachChannel[]) {
  return planReachOut({
    contact: {
      id: "0192f7a0-0000-7000-8000-000000000001",
      name: "Pat Lee",
      email: "pat@shop.com",
      phone: "+15555550100",
      whatsapp: "+15555550100",
      language: null,
      preferredChannels: preferred,
      timezone: "America/Chicago",
      quietHours: null,
      consent: { email: GRANTED, sms: GRANTED, whatsapp: GRANTED, voice: GRANTED },
      optedOutAt: null,
    },
    conditions: {},
    urgency: "normal",
    boundChannels: new Set<ReachChannel>(["email", "sms", "whatsapp", "voice"]),
    client: { timezone: "America/Chicago" },
    facts: {},
    openForSubject: false,
    sentToday: 0,
    now: DAY,
    attachments,
  });
}

describe("a reach-out's attachments and its channels", () => {
  it("leaves out a call, which can't carry a file, with the reason", () => {
    const p = plan(1, ["voice", "whatsapp", "email"]);
    expect(p.ok && p.channels).toEqual(["whatsapp", "email"]);
    expect(p.checks.find((c) => c.channel === "voice")?.block).toBe("cannot_carry_attachments");
  });

  it("leaves out WhatsApp for two files (one per message); email and MMS take five", () => {
    const p = plan(2, ["whatsapp", "sms", "email"]);
    expect(p.ok && p.channels).toEqual(["sms", "email"]);
    expect(CHANNEL_ATTACHMENTS_MAX).toEqual({ email: 5, sms: 5, whatsapp: 1, voice: 0 });
  });

  it("is not_allowed, with the words, when no channel can carry them", () => {
    const p = plan(1, ["voice"]);
    expect(p.ok).toBe(false);
    expect(describeChecks(p.checks)).toBe("voice: can't carry the attachments");
  });

  it("changes nothing without attachments", () => {
    expect(plan(0, ["voice", "email"])).toMatchObject({ ok: true, channels: ["voice", "email"] });
  });
});

describe("the inputs", () => {
  it("takes at most five document ids, each once", () => {
    const base = {
      to: { role: "purchaser" },
      purpose: "Send the purchase order",
      message: { template: { en: "Our order is attached." } },
    };
    expect(ReachOutInput.parse({ ...base, attachments: [DOC] }).attachments).toEqual([DOC]);
    expect(ReachOutInput.parse(base).attachments).toBeUndefined();
    expect(ReachOutInput.safeParse({ ...base, attachments: [DOC, DOC] }).success).toBe(false);
    expect(ReachOutInput.safeParse({ ...base, attachments: ["not-an-id"] }).success).toBe(false);
    expect(ReachOutInput.safeParse({ ...base, attachments: Array(6).fill(DOC) }).success).toBe(
      false,
    );
    expect(OutboundAttachments.safeParse([{ documentId: DOC }, { documentId: DOC2 }]).success).toBe(
      true,
    );
    expect(OutboundAttachments.safeParse([{ documentId: DOC, extra: 1 }]).success).toBe(false);
  });

  it("sends PDFs and images only", () => {
    expect(
      ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].every(
        isSendableType,
      ),
    ).toBe(true);
    expect(isSendableType("text/html")).toBe(false);
    expect(isSendableType("application/zip")).toBe(false);
    expect(describeAttachments([{ filename: "PO.pdf", sizeBytes: 120 * 1024 }])).toBe(
      "PO.pdf (120 KB)",
    );
  });
});

describe("the reply's documents in the step's output", () => {
  it("carries the ids (an empty list on replies stored before them) and the refusals", () => {
    const old = ReachReply.parse({
      channel: "sms",
      text: "Yes",
      untrusted: true,
      rawRecordId: null,
      at: DAY.toISOString(),
    });
    expect(old.documents).toEqual([]);
    const out = ReachOutOutput.parse({
      outcome: "replied",
      channel: "email",
      reply: {
        ...old,
        channel: "email",
        documents: [DOC],
        refused: [{ contentType: "application/zip", reason: "type_not_allowed" }],
      },
      contact: null,
      reason: null,
      attempts: 1,
      sources: [],
      reachOutId: null,
    });
    expect(out.reply?.documents).toEqual([DOC]);
    expect(out.reply?.refused).toHaveLength(1);
  });
});
