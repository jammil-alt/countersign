// S5.2, S5.4, S5.5 (overnight fixes, 2026-11-23): times where the client is. The browser here is
// in Los Angeles; the clients are in Chicago and Madrid, so a day or hour taken from the wrong zone
// shows.
import { afterAll, describe, expect, it, vi } from "vitest";
import { nextRunLine } from "../ops/client/ClientOverview";
import { chipValue } from "../ops/screens/Runs";
import { utcDayNote } from "../ops/screens/Usage";
import { when } from "../ops/work/sales/DealPage";
import { createFormatters } from "./format";
import { periodEnd, zoneName } from "./zone";

// Before any import, so formatters made when a module loads are in this zone too, as in a browser.
const BROWSER_TZ = vi.hoisted(() => {
  const was = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  return was;
});
afterAll(() => {
  if (BROWSER_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = BROWSER_TZ;
});

const NOW = new Date("2026-11-25T12:00:00.000Z");

describe("the deal timeline (S5.2)", () => {
  it("stamps the day and the time in the same zone", () => {
    // 04:58 UTC on 23 Nov is 20:58 on 22 Nov in Los Angeles: it read "Nov 23 20:58".
    expect(new Date("2026-11-23T04:58:00.000Z").getHours()).toBe(20);
    expect(when("2026-11-23T04:58:00.000Z", NOW)).toBe("22 Nov, 20:58");
  });
});

describe("a period's ends (S5.4)", () => {
  // 1–30 Nov in Chicago: from 1 Nov 00:00 (05:00 UTC) to 1 Dec 00:00 (06:00 UTC), until exclusive.
  const since = "2026-11-01T05:00:00.000Z";
  const until = "2026-12-01T06:00:00.000Z";

  it("reads its days in the client's zone, the end as the last day", () => {
    expect(periodEnd("since", since, "en-US", "America/Chicago")).toBe("1 Nov 2026");
    expect(periodEnd("until", until, "en-US", "America/Chicago")).toBe("30 Nov 2026");
    // In the browser's zone it started "31 Oct".
    expect(createFormatters("en-US").date(since)).toBe("31 Oct 2026");
    // Spanish reads the same days.
    expect(periodEnd("since", since, "es", "America/Chicago")).toBe("1 nov 2026");
  });

  it("keeps the time of an end that isn't midnight", () => {
    expect(periodEnd("since", "2026-11-23T20:00:00.000Z", "en-US", "America/Chicago", NOW)).toBe(
      "23 Nov, 14:00",
    );
  });

  it("names the client's zone on the back office's chip", () => {
    expect(chipValue("since", since, "America/Chicago")).toBe("1 Nov 2026 (Chicago Time)");
    expect(chipValue("until", until, "America/Chicago")).toBe("30 Nov 2026 (Chicago Time)");
    // The viewer's own zone needs no name.
    expect(chipValue("until", "2026-12-01T08:00:00.000Z", "America/Los_Angeles")).toBe(
      "30 Nov 2026",
    );
  });
});

describe("a client's next run and usage's days (S5.5)", () => {
  it("reads the next run in the client's zone, named", () => {
    const activity = { nextRunAt: "2026-11-26T08:00:00.000Z" } as Parameters<typeof nextRunLine>[0];
    // 09:00 in Madrid, which the browser would show as 00:00.
    expect(nextRunLine(activity, "Europe/Madrid", NOW)).toMatch(/^Next run 26 Nov, 09:00 \(.+\)$/);
    expect(zoneName("UTC")).toBe("UTC");
    expect(zoneName("America/Chicago")).toBe("Chicago Time");
  });

  it("says usage's days are UTC, and when today began here", () => {
    expect(utcDayNote(NOW)).toBe("Days are UTC: today began at 24 Nov, 16:00 your time.");
  });
});
