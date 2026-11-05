import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locale";
import { findingText, SUPERVISOR_WORDS } from "../i18n/supervisor";
import {
  ConnectionNeedsAttentionPayload,
  FINDING_KINDS,
  findingFingerprint,
  fingerprintOf,
  HealthSummary,
  healthState,
  RunFailedPayload,
  supervisorSettings,
} from "./health";

const ID = "0192f7a0-0000-7000-8000-000000000001";

describe("supervisor events", () => {
  it("validate run.failed and connection.needs_attention", () => {
    expect(
      RunFailedPayload.safeParse({
        runId: ID,
        agentId: ID,
        agentVersionId: ID,
        workflowSlug: "w",
        stepId: null,
        error: "x",
      }).success,
    ).toBe(true);
    expect(RunFailedPayload.safeParse({ runId: "nope" }).success).toBe(false);
    expect(
      ConnectionNeedsAttentionPayload.parse({
        connectionId: ID,
        connector: "zoho_crm",
        reason: "signin_expired",
        detail: "refused",
      }).sourceId,
    ).toBeNull();
    expect(
      ConnectionNeedsAttentionPayload.safeParse({
        connectionId: ID,
        connector: "zoho_crm",
        reason: "bored",
        detail: "",
      }).success,
    ).toBe(false);
  });
});

describe("findings", () => {
  it("fingerprint the issue from ids only", () => {
    const run = { kind: "run_failed", agentId: ID, workflowSlug: "w", stepId: "s" } as const;
    expect(findingFingerprint(run)).toBe(findingFingerprint({ ...run }));
    expect(findingFingerprint(run)).not.toBe(findingFingerprint({ ...run, stepId: "t" }));
    expect(findingFingerprint({ kind: "connection_signin", connectionId: ID })).toBe(
      `connection_signin:${ID}`,
    );
    expect(fingerprintOf({ fingerprint: "x" })).toBe("x");
    expect(fingerprintOf({ fingerprint: "" })).toBeNull();
    expect(fingerprintOf(null)).toBeNull();
  });

  it("have a title and plain steps for every kind in every language", () => {
    for (const locale of LOCALES) {
      for (const kind of FINDING_KINDS) {
        const words = findingText(locale, kind, {
          service: "Record keeping",
          connector: "Zoho CRM",
          site: "portal.example.com",
          count: 3,
        });
        expect(words.title.length, `${locale} ${kind}`).toBeGreaterThan(0);
        expect(words.steps.length, `${locale} ${kind}`).toBeGreaterThan(0);
        for (const text of [words.title, ...words.steps]) {
          expect(text, `${locale} ${kind}`).not.toMatch(/undefined|\{|\}|!/);
        }
      }
      expect(Object.keys(SUPERVISOR_WORDS[locale]).sort()).toEqual([...FINDING_KINDS].sort());
    }
    expect(findingText("en", "connection_signin", { connector: "QuickBooks" }).title).toBe(
      "QuickBooks needs you to sign in again",
    );
  });

  it("read the client's reminder and waiting hours, with defaults", () => {
    expect(supervisorSettings({})).toEqual({ reminderHours: 24, waitingHours: 48 });
    expect(supervisorSettings({ supervisor: { reminderHours: 6 } })).toMatchObject({
      reminderHours: 6,
    });
    expect(supervisorSettings({ supervisor: { reminderHours: -1 } }).reminderHours).toBe(24);
  });

  it("call a summary good only when nothing needs a person", () => {
    const s = HealthSummary.parse({
      checkedAt: "2026-11-05T08:00:00.000Z",
      runs: { total: 4, failed: 0 },
      connections: { total: 2, needsAttention: 0 },
      waiting: { count: 1, oldestHours: 3 },
      agents: { active: 2, paused: 0 },
      openFindings: 0,
      sources: [],
    });
    expect(healthState(s)).toBe("good");
    expect(healthState({ ...s, openFindings: 1 })).toBe("attention");
  });
});
