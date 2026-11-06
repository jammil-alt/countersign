import { describe, expect, it } from "vitest";
import { clientHolidays, isDayOff, localDate, usFederalHolidayOn, usFederalHolidays } from "./us";

describe("US federal holidays", () => {
  it("observes a Saturday holiday on the Friday before and a Sunday one on the Monday after", () => {
    // July 4, 2026 is a Saturday.
    expect(usFederalHolidayOn("2026-07-03")?.name).toBe("Independence Day");
    expect(usFederalHolidayOn("2026-07-04")?.name).toBe("Independence Day");
    // Juneteenth 2022 was a Sunday: observed Monday June 20.
    expect(usFederalHolidayOn("2022-06-20")?.name).toBe("Juneteenth National Independence Day");
    // New Year's Day 2022 was a Saturday: observed Friday December 31, 2021.
    expect(usFederalHolidayOn("2021-12-31")?.name).toBe("New Year's Day");
    expect(usFederalHolidayOn("2026-07-06")).toBeNull();
  });

  it("finds the floating ones", () => {
    const y = Object.fromEntries(usFederalHolidays(2026).map((h) => [h.name, h.observed]));
    expect(y["Birthday of Martin Luther King, Jr."]).toBe("2026-01-19");
    expect(y["Memorial Day"]).toBe("2026-05-25");
    expect(y["Labor Day"]).toBe("2026-09-07");
    expect(y["Thanksgiving Day"]).toBe("2026-11-26");
    expect(usFederalHolidays(2020).some((h) => h.name.startsWith("Juneteenth"))).toBe(false);
  });

  it("reads the date in the client's zone, and the client's own days off", () => {
    // 02:00 UTC on July 3 is still July 2 in Los Angeles.
    const at = new Date("2026-07-03T02:00:00Z");
    expect(localDate(at, "America/Los_Angeles")).toBe("2026-07-02");
    expect(isDayOff(at, "America/Los_Angeles")).toBe(false);
    expect(isDayOff(at, "America/New_York")).toBe(false);
    expect(isDayOff(new Date("2026-07-03T13:00:00Z"), "America/New_York")).toBe(true);
    expect(isDayOff(new Date("2026-12-24T15:00:00Z"), "UTC", ["2026-12-24"])).toBe(true);
    expect(clientHolidays({ holidays: ["2026-12-24", "nope"] })).toEqual([]);
    expect(clientHolidays({ holidays: ["2026-12-24"] })).toEqual(["2026-12-24"]);
  });
});
