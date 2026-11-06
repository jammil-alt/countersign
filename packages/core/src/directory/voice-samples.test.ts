import { describe, expect, it } from "vitest";
import {
  readVoiceSampleMeta,
  VOICE_SAMPLE_MAX,
  voiceSampleText,
  voiceTagged,
} from "./voice-samples";

describe("voice sample text", () => {
  it("keeps the person's own words and cuts quoted history", () => {
    const text = [
      "Hi Dana,",
      "",
      "Thanks for the quick turnaround. We'll pick up Friday.",
      "",
      "Best,",
      "Sam",
      "",
      "On Tue, Nov 4, 2026 at 9:12 AM Dana <dana@vendor.example> wrote:",
      "> Your order is ready.",
    ].join("\n");
    expect(voiceSampleText(text)).toBe(
      "Hi Dana,\n\nThanks for the quick turnaround. We'll pick up Friday.\n\nBest,\nSam",
    );
    expect(voiceSampleText("Sounds good.\n> earlier\n> lines")).toBe("Sounds good.");
    expect(voiceSampleText("Ok\n-----Original Message-----\nFrom: x")).toBe("Ok");
  });

  it("keeps a bare forward's message without its header lines", () => {
    const text = [
      "",
      "---------- Forwarded message ---------",
      "From: Sam Ortiz <sam@hollis.example>",
      "Date: Mon, Nov 3, 2026",
      "Subject: Delivery",
      "To: Lee <lee@builder.example>",
      "",
      "Hey Lee, the cabinets ship Thursday. Call me if the site isn't ready.",
      "",
      "Sam",
    ].join("\n");
    expect(voiceSampleText(text)).toBe(
      "Hey Lee, the cabinets ship Thursday. Call me if the site isn't ready.\n\nSam",
    );
    // Words written above a forward are the person's own: those are kept.
    expect(
      voiceSampleText(
        "FYI, this is how I write.\n\n---------- Forwarded message ---------\nFrom: a\n\nOther",
      ),
    ).toBe("FYI, this is how I write.");
  });

  it("redacts card numbers and keeps at most 4,000 characters", () => {
    expect(voiceSampleText("Card 4111 1111 1111 1111 on file")).not.toContain(
      "4111 1111 1111 1111",
    );
    expect(voiceSampleText("a".repeat(9000)).length).toBe(VOICE_SAMPLE_MAX);
  });

  it("reads the +voice tag and the meta", () => {
    expect(voiceTagged("hollis-abc-def+voice@in.mezonas.com")).toEqual({
      tagged: true,
      address: "hollis-abc-def@in.mezonas.com",
    });
    expect(voiceTagged("hollis-abc-def@in.mezonas.com").tagged).toBe(false);
    expect(voiceTagged("hollis-abc-def+rel123@in.mezonas.com").tagged).toBe(false);
    expect(voiceTagged("hollis+voice+x@in.mezonas.com").tagged).toBe(false);
    const id = "0b6f2a39-6a3e-4f8e-9a65-2f9d8a1c0d11";
    expect(readVoiceSampleMeta({ personUserId: id, channel: "sms" })).toEqual({
      personUserId: id,
      channel: "sms",
    });
    expect(readVoiceSampleMeta({ personUserId: id, channel: "voice" })).toBeNull();
    expect(readVoiceSampleMeta({})).toBeNull();
  });
});
