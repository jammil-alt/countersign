import { describe, expect, it } from "vitest";
import {
  clientHealth,
  LOW_CONFIDENCE_DEFAULT,
  lowConfidenceThreshold,
  newestFeed,
  shareOf,
  sortEscalations,
} from "./command-center";
import { forbiddenPortalFields, routeFamily } from "./contract";
import { routes } from "./routes";

describe("command center", () => {
  it("is the back office's only", () => {
    for (const r of [
      routes.opsCommandCenter,
      routes.opsFeed,
      routes.opsSearch,
      routes.opsRunsAsk,
    ]) {
      expect(routeFamily(r)).toBe("ops");
      expect(r.roles).toEqual(["operator"]);
    }
  });

  it("reads the low-confidence threshold from the client's settings, 0.80 by default", () => {
    expect(LOW_CONFIDENCE_DEFAULT).toBe("0.80");
    expect(lowConfidenceThreshold({})).toBe("0.80");
    expect(lowConfidenceThreshold({ ops: { lowConfidence: 0.9 } })).toBe("0.900");
    expect(lowConfidenceThreshold({ ops: { lowConfidence: "0.75" } })).toBe("0.750");
    for (const bad of [0, -1, 1.5, "x", null, true]) {
      expect(lowConfidenceThreshold({ ops: { lowConfidence: bad } })).toBe("0.80");
    }
  });

  it("calls a client good, watch or bad by §13.1's limits", () => {
    const h = (
      cleanShare: number | null,
      medianResponseHours: number | null,
      openEscalations = 0,
    ) => clientHealth({ cleanShare, medianResponseHours, openEscalations });
    expect(h(0.95, 24)).toBe("good");
    expect(h(null, null)).toBe("good");
    expect(h(0.94, 24)).toBe("watch");
    expect(h(0.95, 25)).toBe("watch");
    expect(h(1, 1, 1)).toBe("watch");
    expect(h(0.85, 72, 2)).toBe("watch");
    expect(h(0.849, 1)).toBe("bad");
    expect(h(1, 72.1)).toBe("bad");
    expect(h(1, 1, 3)).toBe("bad");
  });

  it("divides only when there is something to divide", () => {
    expect(shareOf(0, 0)).toBeNull();
    expect(shareOf(2, 3)).toBe(0.6667);
    expect(shareOf(3, 3)).toBe(1);
  });

  it("puts the longest-blocked escalation first", () => {
    const list = sortEscalations([
      { kind: "item", id: "b", blockedSince: "2026-11-06T10:00:00.000Z" },
      { kind: "failed_run", id: "a", blockedSince: "2026-11-05T10:00:00.000Z" },
      { kind: "connection", id: "c", blockedSince: "2026-11-06T10:00:00.000Z" },
    ]);
    expect(list.map((e) => e.id)).toEqual(["a", "c", "b"]);
  });

  it("keeps the newest feed items", () => {
    const items = Array.from({ length: 120 }, (_, i) => ({
      id: `step:${i}`,
      at: new Date(Date.UTC(2026, 10, 6, 0, i)).toISOString(),
    }));
    const kept = newestFeed(items);
    expect(kept).toHaveLength(100);
    expect(kept[0]?.id).toBe("step:119");
  });

  it("never gives the portal costs, bundles or prompts through search or questions", () => {
    expect(forbiddenPortalFields(routes.portalSearch.response)).toEqual([]);
    expect(forbiddenPortalFields(routes.portalRunsAsk.response)).toEqual([]);
    // Cost is in the back office's answers, which is why they are operator-only.
    expect(forbiddenPortalFields(routes.opsCommandCenter.response)).toContain("costUsd");
    expect(forbiddenPortalFields(routes.opsRunsAsk.response)).toContain("costOver");
  });
});
