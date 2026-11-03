import { expect, it } from "vitest";
import { Duration, isDuration, parseDuration } from "./duration";

it("parses Workflows-style durations", () => {
  expect(parseDuration("30 seconds")).toBe(30_000);
  expect(parseDuration("1 minute")).toBe(60_000);
  expect(parseDuration("5 days")).toBe(432_000_000);
  expect(parseDuration("2 weeks")).toBe(1_209_600_000);
  expect(isDuration("soon")).toBe(false);
  expect(() => parseDuration("3 fortnights")).toThrow(/Invalid duration/);
  expect(Duration.safeParse("1 hour").success).toBe(true);
  expect(Duration.safeParse("1h").success).toBe(false);
});
