import { describe, expect, it } from "vitest";
import { houseDate, IanaTimeZone, isTimeZone, timeZoneChoices } from "./timezone";

describe("time zones", () => {
  it("takes IANA names the runtime knows, and refuses the rest at the boundary", () => {
    expect(isTimeZone("America/Chicago")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(IanaTimeZone.parse(" Europe/London ")).toBe("Europe/London");
    const bad = IanaTimeZone.safeParse("Central time");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain("not a time zone we know");
  });

  it("offers UTC first, then the zones A to Z, keeping a saved one", () => {
    const zones = timeZoneChoices();
    expect(zones[0]).toBe("UTC");
    expect(zones).toContain("America/Chicago");
    expect(zones.slice(1)).toEqual([...zones.slice(1)].sort());
    expect(new Set(zones).size).toBe(zones.length);
    expect(timeZoneChoices("US/Central")).toContain("US/Central");
  });
});

describe("houseDate (S5.1)", () => {
  it("writes the house date: day, short month, year", () => {
    expect(houseDate("2026-11-23")).toBe("23 Nov 2026");
    // An instant is its day in the zone given, UTC unless given.
    expect(houseDate("2026-11-23T02:58:00.000Z")).toBe("23 Nov 2026");
    expect(houseDate("2026-11-23T02:58:00.000Z", "America/Chicago")).toBe("22 Nov 2026");
    // A calendar day is that day in any zone; an unknown zone reads as UTC; not a date stays.
    expect(houseDate("2026-11-23", "America/Chicago")).toBe("23 Nov 2026");
    expect(houseDate("2026-11-23T02:58:00.000Z", "Not/AZone")).toBe("23 Nov 2026");
    expect(houseDate("soon")).toBe("soon");
  });
});
