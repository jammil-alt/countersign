import { describe, expect, it } from "vitest";
import { diffBundles } from "../bundle/diff";
import { mergeBundles } from "../bundle/merge";
import { bundleHash } from "../canonical";
import { AgentBundle } from "../schemas/agent";
import { bundle, edit } from "../testing/fixtures";
import { validateBundle } from "../workflow/validate";
import {
  nextEscalation,
  type PlanInput,
  pickMessage,
  planReachOut,
  quietHoursEnd,
  type ReachChannel,
  type ReachContact,
  ReachOutInput,
  reachLanguage,
  reachSubject,
} from "./rules";

const GRANTED = { grantedAt: "2026-11-01T00:00:00.000Z", source: "signed form" };

function contact(over: Partial<ReachContact> = {}): ReachContact {
  return {
    id: "0192f7a0-0000-7000-8000-000000000001",
    name: "Pat Lee",
    email: "pat@shop.com",
    phone: "+15555550100",
    whatsapp: "+15555550100",
    language: null,
    preferredChannels: [],
    timezone: "America/Chicago",
    quietHours: null,
    consent: { email: GRANTED, sms: GRANTED, whatsapp: GRANTED, voice: GRANTED },
    optedOutAt: null,
    ...over,
  };
}

// 15:00 UTC is 09:00 in Chicago (outside the default 21:00–08:00 quiet hours); 06:00 UTC is midnight.
const DAY = new Date("2026-11-04T15:00:00.000Z");
const NIGHT = new Date("2026-11-04T06:00:00.000Z");
const ALL: ReadonlySet<ReachChannel> = new Set(["email", "sms", "whatsapp", "voice"]);

function plan(over: Partial<PlanInput> = {}) {
  return planReachOut({
    contact: contact(),
    conditions: {},
    urgency: "normal",
    boundChannels: ALL,
    client: { timezone: "America/Chicago" },
    facts: { trigger: { total: 800 } },
    openForSubject: false,
    sentToday: 0,
    now: DAY,
    ...over,
  });
}

describe("planReachOut: urgency → channels", () => {
  it("urgent: call, then text", () => {
    const p = plan({ urgency: "urgent" });
    expect(p.ok && p.channels).toEqual(["voice", "sms"]);
  });
  it("normal: the contact's preferred order", () => {
    const p = plan({ contact: contact({ preferredChannels: ["whatsapp", "voice"] }) });
    expect(p.ok && p.channels).toEqual(["whatsapp", "voice"]);
  });
  it("normal with no preferences: least intrusive first", () => {
    const p = plan();
    expect(p.ok && p.channels).toEqual(["email", "sms", "whatsapp", "voice"]);
  });
  it("FYI: email only", () => {
    const p = plan({ urgency: "fyi" });
    expect(p.ok && p.channels).toEqual(["email"]);
  });
  it("the binding can set its own order per urgency", () => {
    const p = plan({ urgency: "urgent", conditions: { urgency: { urgent: ["sms"] } } });
    expect(p.ok && p.channels).toEqual(["sms"]);
  });
});

describe("planReachOut: filters", () => {
  it("drops channels the binding doesn't allow, the role doesn't take, or the agent hasn't bound", () => {
    const p = plan({
      conditions: { channels: ["email", "sms", "voice"] },
      roleChannels: ["email", "voice", "whatsapp"],
      boundChannels: new Set(["email", "sms"]),
    });
    expect(p.ok && p.channels).toEqual(["email"]);
    expect(p.checks.map((c) => c.block)).toEqual([
      null,
      "not_allowed_for_role",
      "not_allowed_by_binding",
      "not_bound",
    ]);
  });
  it("drops channels without consent or an address", () => {
    const p = plan({
      contact: contact({ email: null, consent: { sms: GRANTED } }),
    });
    expect(p.ok && p.channels).toEqual(["sms"]);
  });
  it("an opt-out stops everything", () => {
    const p = plan({ contact: contact({ optedOutAt: "2026-11-02T00:00:00.000Z" }) });
    expect(p).toMatchObject({ ok: false, outcome: "opted_out" });
  });
  it("nothing passing is not_allowed, with the reasons", () => {
    const p = plan({ contact: contact({ consent: {} }) });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.outcome).toBe("not_allowed");
      expect(p.reason).toContain("email: no consent");
    }
  });
});

describe("planReachOut: hours", () => {
  it("quiet hours hold texts and calls back but not email", () => {
    const p = plan({
      now: NIGHT,
      urgency: "urgent",
      conditions: { urgency: { urgent: ["sms", "email"] } },
    });
    expect(p.ok && p.channels).toEqual(["email"]);
  });
  it("a later channel in quiet hours stays in the plan for escalation", () => {
    const p = plan({ now: NIGHT });
    expect(p.ok && p.channels).toEqual(["email", "sms", "whatsapp", "voice"]);
  });
  it("urgent outside hours only when the binding allows it", () => {
    expect(plan({ now: NIGHT, urgency: "urgent" }).ok).toBe(false);
    const p = plan({ now: NIGHT, urgency: "urgent", conditions: { urgentOutsideHours: true } });
    expect(p.ok && p.channels).toEqual(["voice", "sms"]);
  });
  it("uses the contact's own timezone and quiet hours", () => {
    // 06:00 UTC is 15:00 in Tokyo.
    const p = plan({
      now: NIGHT,
      urgency: "urgent",
      contact: contact({ timezone: "Asia/Tokyo" }),
    });
    expect(p.ok && p.channels).toEqual(["voice", "sms"]);
    const strict = plan({
      urgency: "urgent",
      contact: contact({ quietHours: { start: "08:00", end: "18:00" } }),
    });
    expect(strict.ok).toBe(false);
  });
});

describe("planReachOut: how often and only if", () => {
  it("caps reach-outs per day", () => {
    expect(plan({ sentToday: 3 }).ok).toBe(false);
    expect(plan({ sentToday: 3, conditions: { maxPerDay: 5 } }).ok).toBe(true);
  });
  it("one open reach-out per contact and subject", () => {
    const p = plan({ openForSubject: true });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain("already open");
  });
  it("only if: the fork rules over the step's facts", () => {
    const onlyIf = {
      match: "all" as const,
      rules: [{ field: "{{trigger.total}}", op: ">" as const, value: 500 }],
    };
    expect(plan({ conditions: { onlyIf } }).ok).toBe(true);
    const p = plan({ conditions: { onlyIf }, facts: { trigger: { total: 100 } } });
    expect(p).toMatchObject({ ok: false, outcome: "not_allowed" });
  });
});

describe("nextEscalation", () => {
  const base = {
    channels: ["sms", "voice"] as ReachChannel[],
    escalateAfter: "2 hours",
    replied: false,
    optedOut: false,
  };
  const t0 = new Date("2026-11-04T15:00:00.000Z");
  it("starts with the first channel", () => {
    expect(nextEscalation({ ...base, attempts: 0, lastAttemptAt: null }, t0)).toEqual({
      kind: "attempt",
      channel: "sms",
      index: 0,
    });
  });
  it("waits until escalateAfter, then the next channel", () => {
    const s = { ...base, attempts: 1, lastAttemptAt: t0 };
    expect(nextEscalation(s, new Date(t0.getTime() + 3_600_000))).toMatchObject({ kind: "wait" });
    expect(nextEscalation(s, new Date(t0.getTime() + 7_200_000))).toEqual({
      kind: "attempt",
      channel: "voice",
      index: 1,
    });
  });
  it("stops at a reply, an opt-out or the last channel", () => {
    const late = new Date(t0.getTime() + 10 * 3_600_000);
    expect(
      nextEscalation({ ...base, attempts: 1, lastAttemptAt: t0, replied: true }, late),
    ).toEqual({ kind: "stop", why: "replied" });
    expect(
      nextEscalation({ ...base, attempts: 1, lastAttemptAt: t0, optedOut: true }, late),
    ).toEqual({ kind: "stop", why: "opted_out" });
    expect(nextEscalation({ ...base, attempts: 2, lastAttemptAt: t0 }, late)).toEqual({
      kind: "stop",
      why: "last_channel",
    });
  });
  it("finds the end of quiet hours", () => {
    const end = quietHoursEnd(
      { timezone: "America/Chicago", quietHours: { start: "21:00", end: "08:00" } },
      NIGHT,
    );
    expect(end.toISOString()).toBe("2026-11-04T14:00:00.000Z");
  });
});

describe("language, subject and message", () => {
  it("the contact's language, else the client's, else English", () => {
    expect(reachLanguage("es", "fr")).toBe("es");
    expect(reachLanguage(null, "fr")).toBe("fr");
    expect(reachLanguage(null, null)).toBe("en");
    expect(reachLanguage("pt", null)).toBe("pt-BR");
  });
  it("the subject is the sources, else the purpose", () => {
    expect(reachSubject(["b", "a", "a"], "x")).toBe("about:a,b");
    expect(reachSubject([], "Confirm Friday")).toBe("purpose:Confirm Friday");
  });
  it("picks the template in the contact's language, else English", () => {
    const t = { en: "Hello", es: "Hola" };
    expect(pickMessage(t, "es")).toBe("Hola");
    expect(pickMessage(t, "de")).toBe("Hello");
  });
  it("parses the skill's input with defaults", () => {
    const i = ReachOutInput.parse({
      to: { role: "purchaser" },
      purpose: "Confirm the delivery date",
      message: { template: { en: "Can you confirm Friday?" } },
    });
    expect(i).toMatchObject({ urgency: "normal", expectReply: true, timeout: "2 days", about: [] });
    expect(ReachOutInput.safeParse({ ...i, message: { template: { es: "Hola" } } }).success).toBe(
      false,
    );
  });
});

describe("bundles with people", () => {
  const roles = [
    {
      role: "purchaser",
      description: "Buys materials",
      required: true,
      channels: ["email", "sms"],
    },
  ];

  it("old versions without people parse and hash as they were", async () => {
    const old = bundle();
    const reparsed = AgentBundle.parse(JSON.parse(JSON.stringify(old)));
    expect("people" in reparsed).toBe(false);
    expect(await bundleHash(reparsed)).toBe(await bundleHash(old));
  });

  it("validates roles, refusing a duplicate", () => {
    const b = edit(bundle(), (d) => {
      d.people = AgentBundle.shape.people.parse([...roles, ...roles]);
    });
    const r = validateBundle(b);
    expect(r.errors.map((e) => e.code)).toContain("duplicate_role");
  });

  it("diffs people by role", () => {
    const a = bundle();
    const b = edit(a, (d) => {
      d.people = AgentBundle.shape.people.parse(roles);
    });
    const changes = diffBundles(a, b);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "added", entity: "person:purchaser" }),
    ]);
    const c = edit(b, (d) => {
      if (d.people?.[0]) d.people[0].required = false;
    });
    expect(diffBundles(b, c)).toEqual([
      expect.objectContaining({ kind: "changed", path: "person:purchaser#/required" }),
    ]);
  });

  it("merges roles added on both sides, and conflicts on one role changed two ways", () => {
    const base = edit(bundle(), (d) => {
      d.people = AgentBundle.shape.people.parse(roles);
    });
    const ours = edit(base, (d) => {
      d.people?.push(...(AgentBundle.shape.people.parse([{ role: "owner" }]) ?? []));
    });
    const theirs = edit(base, (d) => {
      d.people?.push(...(AgentBundle.shape.people.parse([{ role: "vendor-rep" }]) ?? []));
    });
    const merged = mergeBundles(base, ours, theirs);
    expect(merged.clean).toBe(true);
    expect(merged.bundle.people?.map((p) => p.role)).toEqual(["purchaser", "owner", "vendor-rep"]);

    const o2 = edit(base, (d) => {
      if (d.people?.[0]) d.people[0].description = "Ours";
    });
    const t2 = edit(base, (d) => {
      if (d.people?.[0]) d.people[0].description = "Theirs";
    });
    const conflicted = mergeBundles(base, o2, t2);
    expect(conflicted.conflicts.map((c) => c.path)).toEqual(["person:purchaser#/description"]);
  });

  it("a merge with no people anywhere adds none; a template adding roles brings them in", () => {
    const b = bundle();
    expect("people" in mergeBundles(b, b, b).bundle).toBe(false);
    const theirs = edit(b, (d) => {
      d.people = AgentBundle.shape.people.parse(roles);
    });
    expect(mergeBundles(b, b, theirs).bundle.people?.[0]?.role).toBe("purchaser");
  });
});
