// Calls through the Twilio connector, against the fake Twilio and in-memory voice services: the
// checks a call makes in code before Twilio is called (calls on, a number that calls, consent,
// quiet hours), one call per idempotency key, `call.answer` refusing calls that weren't answered,
// and the voice webhooks and TwiML.

import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionRef, WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite, runReadTool } from "../invoke";
import { memoryLogger } from "../logger";
import type { CallCheck, PlacedCall, VoiceServices } from "../voice/services";
import { CALL_ANSWER_TOOL, CALL_GET_TOOL, CALL_PLACE_TOOL } from "../voice/spec";
import { FAKE_TWILIO_MAIN, fakeTwilio } from "./fake";
import { buyNumber, createSubaccount, createTwilioConnector } from "./index";
import {
  forwardTwiml,
  parseCallStatus,
  parseVoiceWebhook,
  setNumberVoice,
  voicemailTwiml,
  xmlEscape,
} from "./voice";

const NOW = new Date("2026-11-04T15:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const PAT = "+15555550100";
const ORIGIN = "https://app.mezonas.test";

function memoryVoice(over: { block?: CallCheck & { ok: false }; quiet?: boolean } = {}) {
  const placed: (PlacedCall & { key: string })[] = [];
  const checks: { ignoreQuietHours?: boolean | undefined }[] = [];
  let prepared = 0;
  const services: VoiceServices = {
    async checkCall(input) {
      checks.push({ ignoreQuietHours: input.ignoreQuietHours });
      if (over.block) return over.block;
      if (over.quiet && !input.ignoreQuietHours) {
        return { ok: false, block: "quiet_hours", message: "it is quiet hours" };
      }
      return { ok: true, contact: { id: "c1", name: "Pat Lee", language: null } };
    },
    async placedFor(key) {
      return placed.find((p) => p.key === key) ?? null;
    },
    async prepareOutbound() {
      prepared += 1;
      return {
        callId: "0190f0c8-0000-7000-8000-0000000000aa",
        answerUrl: `${ORIGIN}/api/twilio/${tenant}/voice/answer`,
        statusUrl: `${ORIGIN}/api/twilio/${tenant}/voice/status`,
        maxSeconds: 600,
      };
    },
    async recordPlaced(i) {
      placed.push({
        callSid: i.callSid,
        status: i.status,
        to: i.to,
        from: i.from,
        contactId: i.contactId,
        contactName: "Pat Lee",
        key: i.idempotencyKey,
      });
    },
    async inboundCall(callSid) {
      if (callSid.endsWith("1")) {
        return { callSid, answered: true, reason: "answered", from: PAT, contactName: "Pat Lee" };
      }
      if (callSid.endsWith("2")) {
        return {
          callSid,
          answered: false,
          reason: "the answering step needs approval, so the call went to voicemail",
          from: PAT,
          contactName: "Pat Lee",
        };
      }
      return null;
    },
    async getCall() {
      return null;
    },
  };
  return { services, placed, checks, prepared: () => prepared };
}

async function setup(opts: { callsOn?: boolean } = {}) {
  const twilio = fakeTwilio({ now: () => NOW });
  const sub = await createSubaccount(twilio.fetch, FAKE_TWILIO_MAIN, "Client A");
  const bought = await buyNumber(twilio.fetch, sub, {
    phoneNumber: "+15125550101",
    smsUrl: `${ORIGIN}/api/twilio/x/messages`,
    friendlyName: "Client A",
    now: NOW,
  });
  const config = {
    subaccountSid: sub.accountSid,
    numbers: [bought],
    webhooks: { messages: "m", status: "s" },
    provisionedAt: NOW.toISOString(),
    ...(opts.callsOn === false
      ? {}
      : {
          voice: {
            enabledAt: NOW.toISOString(),
            forwardTo: null,
            webhooks: { voice: "v", answer: "a", status: "s" },
            answering: [],
          },
        }),
  };
  const connector = createTwilioConnector({ fetch: twilio.fetch });
  const ctx = (services: VoiceServices | undefined, key = "run-1:call:0"): WriteContext => {
    const connection: ConnectionRef = {
      id: "0190f0c8-0000-7000-8000-0000000000c1",
      tenantId: tenant,
      connector: "twilio",
      status: "connected",
      externalAccountId: sub.accountSid,
      config: config as unknown as JsonObject,
      permissions: DEFAULT_PERMISSIONS,
    };
    return {
      tenantId: tenant,
      connection,
      credentials: memoryCredentials(sub as unknown as JsonObject),
      logger: memoryLogger(),
      now: () => NOW,
      idempotencyKey: key,
      ...(services ? { services: { voice: services } } : {}),
    };
  };
  return { twilio, sub, connector, ctx, bought };
}

const CALL = { to: PAT, purpose: "Confirm Friday's delivery window", tools: ["messages.search"] };

describe("calls through the twilio connector", () => {
  it("shows who, why and what the agent may do before the call, and places it once per key", async () => {
    const { twilio, connector, ctx } = await setup();
    const voice = memoryVoice();
    const before = await captureBefore(connector, CALL_PLACE_TOOL, CALL, ctx(voice.services));
    expect(before.before).toEqual({
      contact: { id: "c1", name: "Pat Lee" },
      to: PAT,
      from: "+15125550101",
      purpose: CALL.purpose,
      tools: ["messages.search"],
      maxMinutes: 10,
    });
    // The approval card is drawn at any hour.
    expect(voice.checks[0]?.ignoreQuietHours).toBe(true);
    expect(twilio.placed()).toHaveLength(0);

    const r = await executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(voice.services));
    expect(r.output).toMatchObject({ to: PAT, from: "+15125550101", contactName: "Pat Lee" });
    expect(twilio.placed()).toHaveLength(1);
    expect(twilio.placed()[0]?.form).toMatchObject({
      To: PAT,
      From: "+15125550101",
      Url: `${ORIGIN}/api/twilio/${tenant}/voice/answer?call=0190f0c8-0000-7000-8000-0000000000aa`,
      StatusCallback: `${ORIGIN}/api/twilio/${tenant}/voice/status`,
      TimeLimit: "600",
    });
    // A re-run with the same key places nothing more.
    await executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(voice.services));
    expect(twilio.placed()).toHaveLength(1);
    expect(voice.prepared()).toBe(1);
  });

  it("places nothing without consent, in quiet hours, with calls off, or without the services", async () => {
    const { twilio, connector, ctx } = await setup();
    const noConsent = memoryVoice({
      block: { ok: false, block: "no_consent", message: "hasn't agreed to calls" },
    });
    await expect(
      captureBefore(connector, CALL_PLACE_TOOL, CALL, ctx(noConsent.services)),
    ).rejects.toThrow(/agreed to calls/);
    const quiet = memoryVoice({ quiet: true });
    await expect(
      executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(quiet.services)),
    ).rejects.toThrow(/quiet hours/);
    await expect(executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(undefined))).rejects.toThrow(
      /no call is placed/,
    );
    const off = await setup({ callsOn: false });
    await expect(
      executeWrite(off.connector, CALL_PLACE_TOOL, CALL, off.ctx(memoryVoice().services)),
    ).rejects.toThrow(/aren't turned on/);
    expect(twilio.placed()).toHaveLength(0);
    expect(off.twilio.placed()).toHaveLength(0);
  });

  it("returns a call already placed on a re-run, even if the contact opted out or it's quiet hours since", async () => {
    const { twilio, connector, ctx } = await setup();
    const over: Parameters<typeof memoryVoice>[0] = {};
    const voice = memoryVoice(over);
    const first = await executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(voice.services));
    expect(twilio.placed()).toHaveLength(1);
    const checks = voice.checks.length;

    // The action was left executing and runs again, after Pat opted out.
    over.block = { ok: false, block: "opted_out", message: "opted out" };
    const again = await executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(voice.services));
    expect(again.output).toEqual(first.output);
    expect(again.output).toMatchObject({ contactName: "Pat Lee" });
    // In quiet hours too; and no check runs for a call already placed.
    delete over.block;
    over.quiet = true;
    await executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(voice.services));
    expect(voice.checks).toHaveLength(checks);
    expect(twilio.placed()).toHaveLength(1);
    expect(voice.prepared()).toBe(1);
    // A new key is a new call: checked, and refused.
    over.block = { ok: false, block: "opted_out", message: "opted out" };
    await expect(
      executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(voice.services, "run-2:call:0")),
    ).rejects.toThrow(/opted out/);
    expect(twilio.placed()).toHaveLength(1);
  });

  it("marks purpose and opening as fixed inputs on the call tools", () => {
    const connector = createTwilioConnector({ fetch: fakeTwilio().fetch });
    const specs = Object.fromEntries(connector.manifest.tools.map((t) => [t.id, t]));
    expect(specs[CALL_PLACE_TOOL]?.fixedInputs).toEqual(["purpose", "firstMessage"]);
    expect(specs[CALL_ANSWER_TOOL]?.fixedInputs).toEqual(["purpose", "firstMessage"]);
    expect(specs[CALL_GET_TOOL]?.fixedInputs).toBeUndefined();
  });

  it("records an inbound call the agent answered, and refuses one it didn't before any approval", async () => {
    const { connector, ctx } = await setup();
    const voice = memoryVoice();
    const settings = { purpose: "Answer questions about orders" };
    const ok = { ...settings, callSid: `CA${"0".repeat(31)}1` };
    const r = await executeWrite(connector, CALL_ANSWER_TOOL, ok, ctx(voice.services));
    expect(r.output).toMatchObject({ answered: true, contactName: "Pat Lee" });
    const missed = { ...settings, callSid: `CA${"0".repeat(31)}2` };
    await expect(
      captureBefore(connector, CALL_ANSWER_TOOL, missed, ctx(voice.services)),
    ).rejects.toThrow(/went to voicemail/);
    await expect(
      runReadTool(
        connector,
        CALL_GET_TOOL,
        { callSid: `CA${"0".repeat(32)}` },
        ctx(voice.services),
      ),
    ).rejects.toThrow(/no such call/);
  });

  it("points a number's calls at us and reads Twilio's voice webhooks", async () => {
    const { twilio, sub, bought } = await setup();
    await setNumberVoice(twilio.fetch, sub, bought.sid, {
      voice: "https://x/voice",
      status: "https://x/st",
    });
    expect(twilio.numbers.get(bought.sid)).toMatchObject({
      voice_url: "https://x/voice",
      status_callback: "https://x/st",
    });
    const call = await twilio.voiceIn({
      account: sub.accountSid,
      from: PAT,
      to: bought.phoneNumber,
      url: "https://x/voice",
    });
    expect(parseVoiceWebhook(call.params)).toMatchObject({
      callSid: call.sid,
      from: PAT,
      direction: "inbound",
    });
    const st = await twilio.callStatus({
      sid: call.sid,
      status: "completed",
      durationSecs: 42,
      url: "u",
    });
    expect(parseCallStatus(st.params)).toEqual({
      kind: "status",
      callSid: call.sid,
      accountSid: sub.accountSid,
      status: "completed",
      durationSecs: 42,
    });
    const rec = await twilio.recording({ callSid: call.sid, durationSecs: 12, url: "u" });
    expect(parseCallStatus(rec.params)).toMatchObject({ kind: "recording", recordingSid: rec.sid });
    expect(parseVoiceWebhook({ ...call.params, CallSid: "nope" })).toBeNull();
  });

  it("writes TwiML with every value escaped", () => {
    expect(xmlEscape(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
    const vm = voicemailTwiml({
      greeting: "Thanks for calling <Shop & Co>.",
      goodbye: "Bye.",
      language: "es",
      recordingCallback: "https://x/status?a=1&b=2",
    });
    expect(vm).toContain('<Say language="es-US">Thanks for calling &lt;Shop &amp; Co&gt;.</Say>');
    expect(vm).toContain('recordingStatusCallback="https://x/status?a=1&amp;b=2"');
    expect(forwardTwiml({ to: "+15555550199", callerId: PAT })).toContain(
      "<Number>+15555550199</Number>",
    );
  });
});
