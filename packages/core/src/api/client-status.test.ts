// QA round 1: the portal's run and agent shapes carry what the client's states are derived from
// (waiting on you, time waited, what an agent has going, runs per day by state), and older
// answers without them still parse.
import { describe, expect, it } from "vitest";
import { FORBIDDEN_PORTAL_FIELD } from "./contract";
import { routes } from "./routes";

const run = {
  id: "r1",
  service: { id: "s1", name: "Bill clerk" },
  status: "running",
  startedAt: "2026-11-05T23:00:00.000Z",
  finishedAt: null,
};

describe("the client's states in portal shapes", () => {
  it("carries waiting on you and time waited on a run, and parses without them", () => {
    const shape = routes.portalRuns.response;
    const out = shape.parse({ runs: [{ ...run, waitingOnYou: true, waitedMs: 75_600_000 }] });
    expect(out.runs[0]).toMatchObject({ waitingOnYou: true, waitedMs: 75_600_000 });
    expect(shape.parse({ runs: [run] }).runs[0]?.waitingOnYou).toBeUndefined();
    expect(() => shape.parse({ runs: [{ ...run, waitedMs: -1 }] })).toThrow();
  });

  it("carries them on an agent's history too", () => {
    const zero = { total: 0, succeeded: 0, failed: 0, cancelled: 0, waiting: 0, going: 0 };
    const out = routes.portalService.response.parse({
      service: { id: "s1", name: "Bill clerk", description: null, status: "active" },
      thisMonth: { runs: zero, documentsRead: 1, actions: 0, from: "2026-11-01", to: "2026-11-07" },
      recentRuns: [{ ...run, waitingOnYou: true, waitedMs: 1 }],
      packs: [],
    });
    expect(out.recentRuns[0]).toMatchObject({ waitingOnYou: true, waitedMs: 1 });
  });

  it("counts runs per day by state", () => {
    const day = {
      day: "2026-11-05",
      runs: 2,
      failed: 0,
      done: 1,
      waiting: 1,
      going: 0,
      stopped: 0,
    };
    const out = routes.portalRuns.response.parse({ runs: [], perDay: [day] });
    expect(out.perDay?.[0]).toEqual(day);
  });

  it("gives the Table's and the sidebar's agents what they have going, and the week's runs", () => {
    const runs = { total: 1, succeeded: 0, failed: 0, cancelled: 0, waiting: 1, going: 0 };
    const service = {
      id: "s1",
      name: "Bill clerk",
      description: null,
      status: "active",
      stage: "live",
      now: null,
      runsDone: 0,
      runs,
      runsNow: { running: 0, waitingOnYou: 1 },
      kpis: [],
    };
    const table = routes.portalTable.response.parse({
      client: { id: "c", name: "Demo", timezone: "America/Chicago" },
      week: { weekStart: "2026-11-02", from: "x", to: "y" },
      services: [service],
      figures: { runsDone: 0, runs, changes: { automatic: 0, signed: 0 } },
      recent: [],
      desk: { open: 1, top: [] },
      lead: null,
    });
    expect(table.figures.runs).toEqual(runs);
    expect(table.services[0]?.runsNow).toEqual({ running: 0, waitingOnYou: 1 });
    const overview = routes.portalOverview.response.parse({
      client: { id: "c", name: "Demo" },
      services: [{ ...service, kpis: undefined }],
      needsYou: { inbox: 1 },
      recentRuns: [],
    });
    expect(overview.services[0]).toMatchObject({ stage: "live", runsNow: { waitingOnYou: 1 } });
    // None of the new fields is one a portal answer may never carry.
    for (const k of ["waitingOnYou", "waitedMs", "runsNow", "runs", "stage"]) {
      expect(FORBIDDEN_PORTAL_FIELD.test(k)).toBe(false);
    }
  });
});
