import { describe, expect, it } from "vitest";
import { cameBack, LOCK_AFTER_MS, startLock, unlocked, wentAway } from "./lock";

describe("the app lock", () => {
  it("locks a cold start with a session, and not without one", () => {
    expect(startLock(true).locked).toBe(true);
    expect(startLock(false).locked).toBe(false);
  });

  it("stays open after a short absence and locks after five minutes", () => {
    const t = 1_000_000;
    const away = wentAway(unlocked(), t);
    expect(cameBack(away, t + LOCK_AFTER_MS - 1).locked).toBe(false);
    expect(cameBack(away, t + LOCK_AFTER_MS).locked).toBe(true);
  });

  it("counts from when the app first left, not from later background events", () => {
    const t = 1_000_000;
    const away = wentAway(wentAway(unlocked(), t), t + 4 * 60_000);
    expect(cameBack(away, t + LOCK_AFTER_MS).locked).toBe(true);
  });

  it("never unlocks by coming back", () => {
    const locked = { locked: true, awaySince: 5 };
    expect(cameBack(locked, 6).locked).toBe(true);
    expect(cameBack(unlocked(), 10)).toEqual(unlocked());
  });
});
