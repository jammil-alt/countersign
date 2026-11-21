import { describe, expect, it } from "vitest";
import {
  cronText,
  inWeekCycle,
  planOfSchedule,
  scheduleOfPlan,
  scheduleText,
  weekStart,
  zoneText,
} from "./schedule";

describe("schedule words", () => {
  it("reads common crons on a 12-hour clock", () => {
    expect(cronText("0 7 * * 1-5")).toBe("Weekdays at 7:00 AM");
    expect(cronText("30 18 * * *")).toBe("Every day at 6:30 PM");
    expect(cronText("0 0 * * *")).toBe("Every day at 12:00 AM");
    expect(cronText("0 12 * * 0-6")).toBe("Every day at 12:00 PM");
    expect(cronText("0 9 * * 1")).toBe("Mondays at 9:00 AM");
    expect(cronText("0 9 * * 7")).toBe("Sundays at 9:00 AM");
    expect(cronText("15 9 * * 1,4")).toBe("Mondays and Thursdays at 9:15 AM");
    expect(cronText("0 9 * * 1,3,5")).toBe("Mondays, Wednesdays and Fridays at 9:00 AM");
    expect(cronText("0 10 * * 0,6")).toBe("Weekends at 10:00 AM");
  });

  it("keeps anything else as its cron", () => {
    expect(cronText("*/5 * * * *")).toBe("*/5 * * * *");
    expect(cronText("0 9 1 1 *")).toBe("0 9 1 1 *");
    expect(cronText("0 9 1 * 1")).toBe("0 9 1 * 1");
    expect(cronText("0 */5 * * *")).toBe("0 */5 * * *");
    expect(cronText("0 9 * * MON")).toBe("0 9 * * MON");
    expect(cronText("0 25 * * *")).toBe("0 25 * * *");
  });

  it("names the zone, or says it is the client's", () => {
    expect(zoneText("America/Chicago")).toBe("Central Time");
    expect(zoneText("Not/AZone")).toBe("Not/AZone");
    expect(scheduleText({ cron: "0 7 * * 1-5", tz: "America/New_York" })).toBe(
      "Weekdays at 7:00 AM, Eastern Time",
    );
    expect(scheduleText({ cron: "0 7 * * 1-5" })).toBe(
      "Weekdays at 7:00 AM, in the client's time zone",
    );
  });

  // Owner, 2026-11-21: "the first Monday of the month, or every other Monday or the third Thursday".
  it("reads hours, days of the month and its first to last weekday", () => {
    expect(cronText("0 * * * *")).toBe("Every hour, on the hour");
    expect(cronText("15 */2 * * *")).toBe("Every 2 hours, 15 minutes past");
    expect(cronText("0 9 1 * *")).toBe("The 1st of every month at 9:00 AM");
    expect(cronText("0 9 22 * *")).toBe("The 22nd of every month at 9:00 AM");
    expect(cronText("0 9 L * *")).toBe("The last day of every month at 9:00 AM");
    expect(cronText("0 9 * * 1#1")).toBe("The first Monday of every month at 9:00 AM");
    expect(cronText("30 14 * * 4#3")).toBe("The third Thursday of every month at 2:30 PM");
    expect(cronText("0 17 * * 5L")).toBe("The last Friday of every month at 5:00 PM");
  });

  it("says every other week beside the cron", () => {
    const every = { weeks: 2, from: "2026-11-22" };
    expect(scheduleText({ cron: "0 9 * * 1", every, tz: "America/Chicago" })).toBe(
      "Every other Monday at 9:00 AM, Central Time",
    );
    expect(cronText("0 9 * * 1,4", every)).toBe(
      "Every other week on Mondays and Thursdays at 9:00 AM",
    );
    expect(cronText("0 9 * * 1-5", { weeks: 3, from: "2026-11-22" })).toBe(
      "Every 3 weeks on weekdays at 9:00 AM",
    );
    // A cron the picker can't show keeps its cron, and still says it skips weeks.
    expect(cronText("*/5 * * * *", every)).toBe("*/5 * * * *, every other week");
  });

  it("writes a plan back as the cron it was read from", () => {
    const crons = [
      "0 * * * *",
      "15 */2 * * *",
      "0 7 * * 1-5",
      "30 18 * * *",
      "15 9 * * 1,4",
      "0 9 1 * *",
      "0 9 L * *",
      "0 9 * * 1#1",
      "30 14 * * 4#3",
      "0 17 * * 5L",
      "*/5 * * * *",
      "0 9 * * MON",
    ];
    for (const cron of crons) expect(scheduleOfPlan(planOfSchedule({ cron }))).toEqual({ cron });
    const every = { weeks: 2, from: "2026-11-22" };
    expect(scheduleOfPlan(planOfSchedule({ cron: "0 9 * * 1", every }))).toEqual({
      cron: "0 9 * * 1",
      every,
    });
    // Sunday written as 7 reads as Sunday and is written as 0.
    expect(scheduleOfPlan(planOfSchedule({ cron: "0 9 * * 7" }))).toEqual({ cron: "0 9 * * 0" });
    // The first week starts on its Sunday, whichever day of it was picked.
    expect(
      scheduleOfPlan({ kind: "days", days: [1], hour: 9, minute: 0, weeks: 2, from: "2026-11-25" }),
    ).toEqual({ cron: "0 9 * * 1", every: { weeks: 2, from: "2026-11-22" } });
    expect(weekStart("2026-11-22")).toBe("2026-11-22");
  });

  it("counts whole weeks from the first one, before it too", () => {
    const every = { weeks: 2, from: "2026-11-22" };
    expect(inWeekCycle("2026-11-22", every)).toBe(true);
    expect(inWeekCycle("2026-11-28", every)).toBe(true);
    expect(inWeekCycle("2026-11-29", every)).toBe(false);
    expect(inWeekCycle("2026-12-06", every)).toBe(true);
    expect(inWeekCycle("2026-11-21", every)).toBe(false);
    expect(inWeekCycle("2026-11-08", every)).toBe(true);
    expect(inWeekCycle("2026-12-20", { weeks: 3, from: "2026-11-22" })).toBe(false);
    expect(inWeekCycle("2026-12-13", { weeks: 3, from: "2026-11-22" })).toBe(true);
  });
});
