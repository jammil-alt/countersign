import { describe, expect, it } from "vitest";
import { cronText, scheduleText, zoneText } from "./schedule";

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
    expect(cronText("0 9 1 * *")).toBe("0 9 1 * *");
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
});
