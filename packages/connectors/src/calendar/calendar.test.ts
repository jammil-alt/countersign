// The shared calendar tools: local times and zones (DST both ways, all-day days), the checks on an
// event's times, who is told of a change, and both calendar connectors registered together, so a
// workflow names `calendar.*` and the agent's binding decides which calendar answers.
import { describe, expect, it } from "vitest";
import { createGcalConnector } from "../gcal/index";
import { createOutlookCalendarConnector } from "../outlook_calendar/index";
import { ConnectorRegistry, sharedToolShape } from "../registry";
import {
  CALENDAR_TOOLS,
  CalendarCreateInput,
  CalendarUpdateInput,
  invitees,
  isTimeZone,
  notified,
  timesProblems,
  wallTime,
  zonedToUtc,
} from "./index";

const iso = (ms: number) => new Date(ms).toISOString();

describe("calendar times", () => {
  it("reads local times in a zone, both sides of a change of clocks", () => {
    expect(iso(zonedToUtc("2026-11-20T10:00", "America/Chicago"))).toBe("2026-11-20T16:00:00.000Z");
    expect(iso(zonedToUtc("2026-07-20T10:00:00", "America/Chicago"))).toBe(
      "2026-07-20T15:00:00.000Z",
    );
    expect(iso(zonedToUtc("2026-11-20T10:00", "UTC"))).toBe("2026-11-20T10:00:00.000Z");
    expect(iso(zonedToUtc("2026-11-20T10:00", "Asia/Kolkata"))).toBe("2026-11-20T04:30:00.000Z");
    // Skipped when the clocks go forward: moved on by the gap.
    expect(iso(zonedToUtc("2026-03-08T02:30", "America/Chicago"))).toBe("2026-03-08T08:30:00.000Z");
    expect(iso(zonedToUtc("2026-03-29T02:30", "Europe/Berlin"))).toBe("2026-03-29T01:30:00.000Z");
    // Twice when they go back: the first.
    expect(iso(zonedToUtc("2026-11-01T01:30", "America/Chicago"))).toBe("2026-11-01T06:30:00.000Z");
    expect(iso(zonedToUtc("2026-10-25T02:30", "Europe/Berlin"))).toBe("2026-10-25T00:30:00.000Z");
    expect(wallTime(Date.parse("2026-11-20T16:00:00Z"), "America/Chicago")).toBe(
      "2026-11-20T10:00:00",
    );
    expect(wallTime(Date.parse("2026-11-20T00:00:00Z"), "UTC")).toBe("2026-11-20T00:00:00");
    expect(isTimeZone("Europe/London")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });

  it("checks an event's times: order, zone, all-day dates and length", () => {
    expect(
      timesProblems({ start: "2026-11-20T10:00", end: "2026-11-20T11:00", timeZone: "UTC" }),
    ).toEqual([]);
    expect(timesProblems({ start: "2026-11-20", end: "2026-11-21", allDay: true })).toEqual([]);
    expect(timesProblems({ start: "2026-11-20T10:00" })).toEqual(["give start and end together"]);
    expect(timesProblems({ start: "2026-11-20T10:00", end: "2026-11-20T11:00" })).toEqual([
      "give the time zone of start and end",
    ]);
    expect(timesProblems({ start: "2026-11-21", end: "2026-11-21", allDay: true })[0]).toMatch(
      /day after its last day/,
    );
    expect(timesProblems({ start: "2026-11-01", end: "2027-02-01", allDay: true })[0]).toMatch(
      /at most 62 days/,
    );
    expect(
      CalendarCreateInput.safeParse({
        title: " ",
        start: "2026-11-20",
        end: "2026-11-21",
        allDay: true,
      }).success,
    ).toBe(false);
    expect(CalendarUpdateInput.safeParse({ eventId: "e1" }).success).toBe(false);
    expect(CalendarUpdateInput.safeParse({ eventId: "e1", allDay: true, title: "x" }).success).toBe(
      false,
    );
    expect(CalendarUpdateInput.safeParse({ eventId: "e1", busy: false }).success).toBe(true);
  });

  it("invites each person once, in lower case, never the account itself", () => {
    expect(
      invitees(
        [
          { address: "A@x.example", optional: true },
          { address: "a@x.example", optional: false },
          { address: "Me@Shop.example", optional: false },
        ],
        "me@shop.example",
      ),
    ).toEqual([{ address: "a@x.example", optional: false }]);
  });

  it("says who is told of a change", () => {
    const current = [{ address: "a@x.example" }, { address: "b@x.example" }];
    const attendees = [
      { address: "b@x.example", optional: false },
      { address: "c@x.example", optional: false },
    ];
    expect(notified(current, { title: "x" }, true)).toEqual(["a@x.example", "b@x.example"]);
    expect(notified(current, { attendees }, false)).toEqual([
      "b@x.example",
      "c@x.example",
      "a@x.example",
    ]);
    expect(notified(current, { attendees }, true)).toEqual(["c@x.example", "a@x.example"]);
    expect(notified(current, { attendees, title: "x" }, true)).toEqual([
      "b@x.example",
      "c@x.example",
      "a@x.example",
    ]);
    expect(notified([], { title: "x" }, false)).toEqual([]);
  });
});

describe("both calendar connectors", () => {
  const google = () => createGcalConnector({ clientId: "g", clientSecret: "s" });
  const outlook = () => createOutlookCalendarConnector({ clientId: "m", clientSecret: "s" });

  it("register together and supply the same calendar tool ids with the same shapes", () => {
    const registry = new ConnectorRegistry([google(), outlook()]);
    for (const id of Object.values(CALENDAR_TOOLS)) {
      expect(registry.providersOf(id).map((c) => c.manifest.id)).toEqual([
        "gcal",
        "outlook_calendar",
      ]);
      expect(registry.toolSpecs().filter((s) => s.id === id)).toHaveLength(1);
      const g = registry.findTool(id, "gcal");
      const o = registry.findTool(id, "outlook_calendar");
      expect(g && o && sharedToolShape(g.spec)).toBe(o && sharedToolShape(o.spec));
      expect(g?.spec.undo).toEqual(o?.spec.undo);
      expect(g?.spec.description).toBe(o?.spec.description);
    }
    // The writes name their own connector, so the gate checks the bound one's connection.
    expect(registry.findTool(CALENDAR_TOOLS.create, "outlook_calendar")?.spec.connector).toBe(
      "outlook_calendar",
    );
    expect(registry.findTool(CALENDAR_TOOLS.create, "gcal")?.spec.connector).toBe("gcal");
  });

  it("start with approval on for both writes, and never offer delete", () => {
    for (const c of [google(), outlook()]) {
      expect(c.manifest.permissionEntities).toEqual([
        { id: "event", label: "Events", verbs: ["read", "create", "update"] },
      ]);
      expect(c.manifest.tools.some((t) => t.verb === "delete")).toBe(false);
      expect(
        c.manifest.tools.find((t) => t.id === CALENDAR_TOOLS.create)?.approval,
      ).toBeUndefined();
    }
  });
});
