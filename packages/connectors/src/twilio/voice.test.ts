// Calls through the Twilio connector, against the fake Twilio and in-memory voice services: the
// checks a call makes in code before Twilio is called (calls on, a number that calls, consent,
// quiet hours), one call per idempotency key (a call started but never recorded is found, never
// placed again), `call.answer` refusing calls that weren't answered, and the voice webhooks and TwiML.

import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { type ConnectionRef, UnconfirmedWriteError, type WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite, runReadTool } from "../invoke";
import { memoryLogger } from "../logger";
import type { CallAttempt, CallCheck, PlacedCall, VoiceServices } from "../voice/services";
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
  const attempts: (CallAttempt & { key: string })[] = [];
  const checks: { ignoreQuietHours?: boolean | undefined }[] = [];
  /** Throws once from recordPlaced: a crash after Twilio placed the call. */
  const crash = { onRecord: false };
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
    async attemptFor(key) {
      return attempts.find((a) => a.key === key) ?? null;
    },
    async recordedCallSids(sids) {
      return sids.filter((sid) => placed.some((p) => p.callSid === sid));
    },
    async prepareOutbound(r) {
      prepared += 1;
      attempts.push({
        key: r.idempotencyKey,
        callId: "0190f0c8-0000-7000-8000-0000000000aa",
        contactId: r.contactId,
        contactName: "Pat Lee",
        to: r.to,
        from: r.from,
        startedAt: r.now,
      });
      return {
        callId: "0190f0c8-0000-7000-8000-0000000000aa",
        answerUrl: `${ORIGIN}/api/twilio/${tenant}/voice/answer`,
        statusUrl: `${ORIGIN}/api/twilio/${tenant}/voice/status`,
        maxSeconds: 600,
      };
    },
    async recordPlaced(i) {
      if (crash.onRecord) {
        crash.onRecord = false;
        throw new Error("the Worker stopped");
      }
      if (placed.some((p) => p.callSid === i.callSid)) return;
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
  return { services, placed, attempts, checks, crash, prepared: () => prepared };
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

  it("adopts the one call Twilio placed before a crash instead of placing another", async () => {
    const { twilio, connector, ctx } = await setup();
    const over: Parameters<typeof memoryVoice>[0] = {};
    const voice = memoryVoice(over);
    // Twilio places the call, then the Worker stops before it is recorded.
    voice.crash.onRecord = true;
    await expect(
      executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(voice.services)),
    ).rejects.toThrow("the Worker stopped");
    expect(twilio.placed()).toHaveLength(1);
    expect(voice.attempts).toEqual([
      expect.objectContaining({ key: "run-1:call:0", to: PAT, startedAt: NOW }),
    ]);
    expect(voice.placed).toHaveLength(0);
    // Pat opts out meanwhile; the re-run places nothing, finds Twilio's call and adopts it.
    over.block = { ok: false, block: "opted_out", message: "opted out" };
    const again = await executeWrite(connector, CALL_PLACE_TOOL, CALL, ctx(voice.services));
    const sid = [...twilio.calls.values()].at(-1)?.sid;
    expect(again.output).toMatchObject({ callSid: sid, to: PAT, contactName: "Pat Lee" });
    expect(again.before).toMatchObject({ contact: { id: "c1", name: "Pat Lee" } });
    expect(twilio.placed()).toHaveLength(1);
    expect(voice.prepared()).toBe(1);
    expect(voice.placed).toEqual([expect.objectContaining({ callSid: sid, key: "run-1:call:0" })]);
    const lists = twilio.requests.filter(
      (r) => r.method === "GET" && r.url.includes("/Calls.json?"),
    );
    expect(lists).toHaveLength(1);
    expect(lists[0]?.url).toContain(`To=${encodeURIComponent(PAT)}`);
  });

  it("never places again after an unrecorded attempt: none or several matches fail for the operator", async () => {
    const { twilio, sub, connector, ctx } = await setup();
    const attempt = (key: string): CallAttempt & { key: string } => ({
      key,
      callId: "0190f0c8-0000-7000-8000-0000000000bb",
      contactId: "c1",
      contactName: "Pat Lee",
      to: PAT,
      from: "+15125550101",
      startedAt: NOW,
    });
    // None: the Worker stopped after the request, before Twilio placed anything.
    const none = memoryVoice();
    none.attempts.push(attempt("k-none"));
    const e1 = await executeWrite(
      connector,
      CALL_PLACE_TOOL,
      CALL,
      ctx(none.services, "k-none"),
    ).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(UnconfirmedWriteError);
    expect((e1 as Error).message).toContain(
      "The call to Pat Lee may have been placed; check before trying again",
    );
    expect((e1 as UnconfirmedWriteError).details).toMatchObject({ candidates: [], to: PAT });

    // Several: two calls to Pat since the attempt that nobody recorded.
    const several = memoryVoice();
    several.attempts.push(attempt("k-several"));
    for (const n of ["1", "2"]) {
      const sid = `CA${n.repeat(32)}`;
      twilio.calls.set(sid, {
        sid,
        account_sid: sub.accountSid,
        from: "+15125550101",
        to: PAT,
        url: "",
        status_callback: "",
        time_limit: "",
        status: "completed",
        direction: "outbound-api",
        date_created: NOW.toUTCString(),
      });
    }
    const e2 = await executeWrite(
      connector,
      CALL_PLACE_TOOL,
      CALL,
      ctx(several.services, "k-several"),
    ).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(UnconfirmedWriteError);
    expect((e2 as Error).message).toContain("2 calls");
    expect(twilio.placed()).toHaveLength(0);
    expect(several.prepared() + none.prepared()).toBe(0);
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
