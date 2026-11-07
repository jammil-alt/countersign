import { describe, expect, it } from "vitest";
import { EnterReleaseCode, SetRelease } from "../api/access";
import {
  codeOpen,
  normalizeCode,
  RELEASE_CODE_TTL_MS,
  RELEASE_MAX_TRIES,
  RELEASE_OFF,
  type ReleaseRecord,
  type ReleaseSetting,
  type ReleaseStatus,
  releaseCovers,
  releaseLocale,
  releaseMessage,
  releaseOf,
  releaseSettingProblem,
  tryCode,
  validUntilFor,
} from "./release";

const PERSON = "0190f0a0-0000-7000-8000-000000000001";
const OTHER = "0190f0a0-0000-7000-8000-000000000002";
const now = new Date("2026-11-05T15:00:00Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const runSetting: ReleaseSetting = {
  ...RELEASE_OFF,
  mode: "code",
  personId: PERSON,
  channel: "email",
  window: "run",
};
const hoursSetting: ReleaseSetting = { ...runSetting, window: { hours: 4 } };

function released(over: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    status: "released",
    connectionId: "c1",
    agentId: "a1",
    runId: "r1",
    personId: PERSON,
    expiresAt: at(10),
    tries: 0,
    releasedAt: now,
    validUntil: null,
    ...over,
  };
}
const ask = { connectionId: "c1", agentId: "a1", runId: "r1", now: at(1) };

describe("the release setting", () => {
  it("is off when absent, and fails closed when it no longer parses", () => {
    expect(releaseOf({})).toEqual(RELEASE_OFF);
    expect(releaseOf(null)).toEqual(RELEASE_OFF);
    const broken = releaseOf({ release: { mode: "code", window: { hours: 99 } } });
    expect(broken.mode).toBe("code");
    expect(broken.personId).toBeNull();
    expect(releaseSettingProblem(broken)).toMatch(/nobody is named/);
    expect(releaseSettingProblem(runSetting)).toBeNull();
    expect(releaseSettingProblem({ ...runSetting, channel: "sms" })).toMatch(/phone/);
  });

  it("needs a person, a channel and a window to turn on; windows are one run or 1–24 hours", () => {
    expect(SetRelease.safeParse({ mode: "off" }).success).toBe(true);
    expect(SetRelease.safeParse({ mode: "code" }).success).toBe(false);
    const on = { mode: "code", personId: PERSON, channel: "sms" };
    expect(SetRelease.safeParse({ ...on, window: "run" }).success).toBe(true);
    expect(SetRelease.safeParse({ ...on, window: { hours: 24 } }).success).toBe(true);
    expect(SetRelease.safeParse({ ...on, window: { hours: 25 } }).success).toBe(false);
    expect(SetRelease.safeParse({ ...on, window: { hours: 0 } }).success).toBe(false);
    // The pinned phone is the server's: a body can't set it.
    expect(SetRelease.safeParse({ ...on, window: "run", phone: "+15555550100" }).success).toBe(
      false,
    );
  });
});

describe("window rules", () => {
  it("a run release covers that run only, for that connection and agent", () => {
    expect(releaseCovers(released(), runSetting, ask)).toBe(true);
    expect(releaseCovers(released(), runSetting, { ...ask, runId: "r2" })).toBe(false);
    expect(releaseCovers(released(), runSetting, { ...ask, agentId: "a2" })).toBe(false);
    expect(releaseCovers(released(), runSetting, { ...ask, connectionId: "c2" })).toBe(false);
    expect(validUntilFor("run", now)).toBeNull();
  });

  it("an hours release covers any run of that connection and agent until valid_until", () => {
    const row = released({ validUntil: validUntilFor({ hours: 4 }, now) });
    expect(row.validUntil?.toISOString()).toBe("2026-11-05T19:00:00.000Z");
    expect(releaseCovers(row, hoursSetting, { ...ask, runId: "r9", now: at(239) })).toBe(true);
    expect(releaseCovers(row, hoursSetting, { ...ask, now: at(240) })).toBe(false);
    expect(releaseCovers(row, hoursSetting, { ...ask, agentId: "a2" })).toBe(false);
  });

  it("tightening the setting applies at once: off, another person, a shorter window, a kind change", () => {
    const row = released({ validUntil: validUntilFor({ hours: 4 }, now) });
    expect(releaseCovers(row, RELEASE_OFF, ask)).toBe(false);
    expect(releaseCovers(row, { ...hoursSetting, personId: OTHER }, ask)).toBe(false);
    expect(releaseCovers(row, { ...hoursSetting, window: { hours: 1 } }, ask)).toBe(false);
    expect(releaseCovers(row, runSetting, ask)).toBe(false);
    expect(releaseCovers(released(), hoursSetting, ask)).toBe(false);
    // Saved again after the release: it lapses.
    const later = { ...hoursSetting, updatedAt: at(5).toISOString() };
    expect(releaseCovers(row, later, ask)).toBe(false);
    expect(releaseCovers(row, { ...hoursSetting, updatedAt: at(-5).toISOString() }, ask)).toBe(
      true,
    );
  });

  it("only released rows count", () => {
    for (const status of ["pending", "expired", "failed", "revoked", "void"] as const) {
      expect(releaseCovers(released({ status }), runSetting, ask)).toBe(false);
    }
  });
});

describe("tries and expiry", () => {
  const pending: { status: ReleaseStatus; expiresAt: Date; tries: number } = {
    status: "pending",
    expiresAt: at(10),
    tries: 0,
  };

  it("releases on the right code inside the 10 minutes", () => {
    expect(RELEASE_CODE_TTL_MS).toBe(600_000);
    expect(tryCode(pending, true, at(9))).toMatchObject({ kind: "released" });
    expect(codeOpen(pending, at(9))).toBe(true);
  });

  it("expires at 10 minutes, right code or not", () => {
    expect(tryCode(pending, true, at(10))).toMatchObject({ kind: "expired", status: "expired" });
    expect(codeOpen(pending, at(10))).toBe(false);
  });

  it("counts wrong codes and fails at the fifth", () => {
    let row = { ...pending };
    for (let i = 1; i <= RELEASE_MAX_TRIES; i++) {
      const o = tryCode(row, false, at(1));
      expect(o.kind).toBe("wrong");
      if (o.kind !== "wrong") throw new Error("unreachable");
      expect(o.tries).toBe(i);
      expect(o.triesLeft).toBe(RELEASE_MAX_TRIES - i);
      expect(o.status).toBe(i === RELEASE_MAX_TRIES ? "failed" : "pending");
      row = { ...row, tries: o.tries, status: o.status };
    }
    // Once failed, even the right code does nothing.
    expect(tryCode(row, true, at(1))).toMatchObject({ kind: "closed", status: "failed" });
    expect(codeOpen(row, at(1))).toBe(false);
  });

  it("works once: a released, void or revoked request takes no code", () => {
    for (const status of ["released", "void", "revoked"] as const) {
      expect(tryCode({ ...pending, status }, true, at(1))).toMatchObject({ kind: "closed" });
    }
  });

  it("reads codes with spaces or dashes and nothing else", () => {
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
    expect(normalizeCode("12345")).toBeNull();
    expect(normalizeCode("Yes 123456")).toBeNull();
    expect(EnterReleaseCode.parse({ code: "123 456" })).toEqual({ code: "123456" });
    expect(EnterReleaseCode.safeParse({ code: "abcdef" }).success).toBe(false);
  });
});

describe("the message", () => {
  it("is short, has no link and says what it releases", () => {
    const text = releaseMessage({
      code: "123456",
      agent: "Intake",
      tool: "QuickBooks",
      window: "run",
      test: false,
    });
    expect(text).toBe(
      "Mezonas code: 123456. Enter it to let Intake use QuickBooks for this run. It expires in 10 minutes.",
    );
    expect(text).not.toMatch(/https?:|www\./);
    expect(
      releaseMessage({
        code: "1",
        agent: "Intake",
        tool: "QuickBooks",
        window: { hours: 4 },
        test: false,
      }),
    ).toContain("for the next 4 hours");
  });
});

describe("the message in the person's language", () => {
  const base = { code: "123456", agent: "Intake", tool: "QuickBooks", test: false };
  it("is written in Spanish and German, short and without a link", () => {
    const es = releaseMessage({ ...base, window: "run", locale: "es" });
    expect(es).toBe(
      "Código de Mezonas: 123456. Introdúzcalo para que Intake use QuickBooks en esta ejecución. Caduca en 10 minutos.",
    );
    const de = releaseMessage({ ...base, window: { hours: 4 }, locale: "de" });
    expect(de).toBe(
      "Mezonas-Code: 123456. Geben Sie ihn ein, damit Intake QuickBooks für die nächsten 4 Stunden nutzen kann. Er läuft in 10 Minuten ab.",
    );
    for (const locale of ["en", "es", "fr", "pt-BR", "it", "de"] as const) {
      const text = releaseMessage({ ...base, window: "run", locale });
      expect(text).toContain("123456");
      expect(text).not.toMatch(/https?:|www\./);
      expect(text.length).toBeLessThan(160);
    }
  });

  it("follows the person's choice, else the client's default, else English", () => {
    expect(releaseLocale("es", "de")).toBe("es");
    expect(releaseLocale(null, "de")).toBe("de");
    expect(releaseLocale(null, null)).toBe("en");
  });
});
