import { describe, expect, it } from "vitest";
import {
  addDays,
  draftDueWeek,
  isMonday,
  sendDueWeek,
  weekBounds,
  weeklySchedule,
  weekStartOf,
  zonedParts,
  zonedTimeToUtc,
} from "./week";

describe("weeks in a time zone", () => {
  it("the week's Monday is the local one", () => {
    // Sunday 23:30 in Chicago is Monday 05:30 UTC.
    const at = new Date("2026-11-09T05:30:00Z");
    expect(weekStartOf(at, "America/Chicago")).toBe("2026-11-02");
    expect(weekStartOf(at, "UTC")).toBe("2026-11-09");
    expect(weekStartOf(at, "Europe/Madrid")).toBe("2026-11-09");
  });

  it("local wall time to an instant, across DST", () => {
    expect(zonedTimeToUtc("2026-11-09", 7, 0, "America/Chicago").toISOString()).toBe(
      "2026-11-09T13:00:00.000Z",
    );
    expect(zonedTimeToUtc("2026-07-06", 7, 0, "America/Chicago").toISOString()).toBe(
      "2026-07-06T12:00:00.000Z",
    );
    expect(zonedTimeToUtc("2026-11-09", 7, 0, "Asia/Tokyo").toISOString()).toBe(
      "2026-11-08T22:00:00.000Z",
    );
    // The week of the switch back to standard time (Nov 1 2026 in the US) is 169 hours long.
    const b = weekBounds("2026-10-26", "America/New_York");
    expect((b.to.getTime() - b.from.getTime()) / 3_600_000).toBe(169);
    expect(zonedParts(b.from, "America/New_York")).toMatchObject({ hour: 0, weekday: 1 });
  });

  it("the draft is due from Friday 17:00 and the send from Monday 7:00, local", () => {
    const tz = "America/Chicago";
    const { draftAt, sendAt } = weeklySchedule("2026-11-02", tz);
    expect(draftAt.toISOString()).toBe("2026-11-06T23:00:00.000Z");
    expect(sendAt.toISOString()).toBe("2026-11-09T13:00:00.000Z");
    expect(draftDueWeek(new Date(draftAt.getTime() - 60_000), tz)).toBeNull();
    expect(draftDueWeek(draftAt, tz)).toBe("2026-11-02");
    expect(sendDueWeek(new Date(sendAt.getTime() - 60_000), tz)).toBeNull();
    expect(sendDueWeek(sendAt, tz)).toBe("2026-11-02");
    // Sunday evening: last week's table went out last Monday; this week's waits for tomorrow.
    expect(sendDueWeek(new Date("2026-11-09T01:00:00Z"), tz)).toBe("2026-10-26");
  });

  it("dates", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(isMonday("2026-11-02")).toBe(true);
    expect(isMonday("2026-11-03")).toBe(false);
    expect(zonedParts(new Date("2026-11-06T12:00:00Z"), "Not/AZone").hour).toBe(12);
  });
});
