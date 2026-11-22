import { describe, expect, it } from "vitest";
import { IanaTimeZone, isTimeZone, timeZoneChoices } from "./timezone";

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
