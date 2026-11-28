// 2026-11-24 (owner: poll Zoho once a day, and again when an agent needs the records): when the
// cron polls a connection, from its stored cursor alone. No database.

import { startZohoSync } from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { ZOHO_PASS_DONE_KEY, zohoPollDue, zohoWatchLive } from "./sync";

const NOW = new Date("2026-11-24T09:09:00.000Z");
const cursor = startZohoSync(new Date("2026-11-20T00:00:00.000Z"));

describe("the Zoho poll's schedule", () => {
  it("polls a first sync and a pass under way at once", () => {
    expect(zohoPollDue(null, NOW)).toBe("first");
    expect(zohoPollDue({ zohoWatch: { at: NOW.toISOString(), ok: true } }, NOW)).toBe("first");
    expect(zohoPollDue({ zoho: cursor, [ZOHO_PASS_DONE_KEY]: null }, NOW)).toBe("unfinished");
    // A cursor stored before the pass's end was kept: polled once more to record it.
    expect(zohoPollDue({ zoho: cursor }, NOW)).toBe("unfinished");
    expect(zohoPollDue({ zoho: cursor, [ZOHO_PASS_DONE_KEY]: "soon" }, NOW)).toBe("unfinished");
  });

  it("polls a finished connection once a day, a tick early rather than a day late", () => {
    const done = (iso: string) => ({ zoho: cursor, [ZOHO_PASS_DONE_KEY]: iso });
    expect(zohoPollDue(done("2026-11-24T08:00:00.000Z"), NOW)).toBeNull();
    expect(zohoPollDue(done("2026-11-23T09:30:00.000Z"), NOW)).toBeNull();
    expect(zohoPollDue(done("2026-11-23T09:09:30.000Z"), NOW)).toBe("daily");
    expect(zohoPollDue(done("2026-11-20T09:09:00.000Z"), NOW)).toBe("daily");
  });

  it("counts a watch live only when Zoho took it and it hasn't lapsed", () => {
    const watch = (at: string, ok: boolean) => ({ zohoWatch: { at, ok } });
    expect(zohoWatchLive(watch("2026-11-24T08:00:00.000Z", true), NOW)).toBe(true);
    expect(zohoWatchLive(watch("2026-11-24T08:00:00.000Z", false), NOW)).toBe(false);
    expect(zohoWatchLive(watch("2026-11-23T08:00:00.000Z", true), NOW)).toBe(false);
    expect(zohoWatchLive({}, NOW)).toBe(false);
    expect(zohoWatchLive(null, NOW)).toBe(false);
  });
});
