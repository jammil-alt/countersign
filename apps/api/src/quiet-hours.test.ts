import { inQuietHours, QuietHours } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { quietNever, quietNow } from "./quiet-hours.test-helper";

// The helpers other tests use for "quiet now" and "not quiet now", at every minute of a day.
describe("quiet-hours test helpers", () => {
  const day = Date.UTC(2026, 10, 8);
  const minutes = Array.from({ length: 24 * 60 }, (_, m) => new Date(day + m * 60_000));

  it("quietNow is quiet, and valid, at every minute of the day, 23:59 included", () => {
    for (const at of minutes) {
      const q = quietNow(at);
      expect(QuietHours.safeParse(q).success).toBe(true);
      expect(inQuietHours(at, "UTC", q)).toBe(true);
    }
  });

  it("quietNever is not quiet, and valid, at every minute of the day, 03:00 included", () => {
    for (const at of minutes) {
      const q = quietNever(at);
      expect(QuietHours.safeParse(q).success).toBe(true);
      expect(inQuietHours(at, "UTC", q)).toBe(false);
    }
  });
});
